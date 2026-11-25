import {
  generationRequestTemplateV2Schema,
  type ExecutionMode,
  type GenerationRequestTemplateV2,
  type InputAsset,
  type InputAssetRole,
  type ProviderKind,
  type ShotSpec,
  type StoryBible,
} from '@nolen/contracts';
import { ApiFailure } from '../http/errors.js';

export const COMPILER_VERSION = 'generation-intent-1' as const;
const MAX_IMAGE_PROMPT_CHARS = 5000;
const MAX_VIDEO_PROMPT_CHARS = 1000;

const ROLE_PRECEDENCE: Record<InputAssetRole, number> = {
  START_FRAME: 0,
  CHARACTER_REFERENCE: 1,
  WARDROBE_REFERENCE: 2,
  PROP_REFERENCE: 3,
  LOCATION_REFERENCE: 4,
  STYLE_REFERENCE: 5,
};

export interface ReferenceAssetLookup {
  id: string;
  sha256Hash: string;
  mimeType: string;
}

export interface CompileGenerationTemplateInput {
  filmId: string;
  storyRevisionId: string;
  shotRevisionId: string;
  shotDependencyHash: string;
  kind: 'IMAGE' | 'VIDEO';
  shotSpec: ShotSpec;
  storyBible: StoryBible;
  referenceAssets: Map<string, ReferenceAssetLookup>;
  selectedStartFrame?: {
    assetId: string;
    sha256Hash: string;
    mimeType: string;
  } | null;
  provider: ProviderKind;
  modelId: string;
  rateCardSnapshotId: string;
  executionMode: ExecutionMode;
  fixturePackVersion?: string;
  fixtureId?: string;
}

type BibleDef = { id: string; name: string; description: string; hero?: boolean; referenceAssetIds?: string[] };

function resolveReferenced<T extends BibleDef>(list: T[], ids: Iterable<string>, kindLabel: string): T[] {
  const byId = new Map(list.map(item => [item.id, item]));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const found = byId.get(id);
    if (!found) {
      throw new ApiFailure(422, 'REFERENCE_ERROR', `Referenced ${kindLabel} "${id}" missing from Story Bible`);
    }
    out.push(found);
  }
  return out;
}

function collectInputAssets(
  roleBindings: Array<{ role: InputAssetRole; defs: BibleDef[] }>,
  referenceAssets: Map<string, ReferenceAssetLookup>,
  selectedStartFrame?: CompileGenerationTemplateInput['selectedStartFrame'],
): InputAsset[] {
  const deduped = new Map<string, InputAsset>();

  if (selectedStartFrame) {
    const asset: InputAsset = {
      source: 'GENERATED_ASSET',
      role: 'START_FRAME',
      assetId: selectedStartFrame.assetId,
      sha256Hash: selectedStartFrame.sha256Hash,
      mimeType: selectedStartFrame.mimeType,
    };
    deduped.set(`${asset.source}|${asset.assetId}|${asset.role}`, asset);
  }

  for (const { role, defs } of roleBindings) {
    for (const def of defs) {
      for (const refId of def.referenceAssetIds ?? []) {
        const meta = referenceAssets.get(refId);
        if (!meta) {
          throw new ApiFailure(422, 'REFERENCE_ASSET_INVALID', `Bound reference asset ${refId} is unavailable`);
        }
        const asset: InputAsset = {
          source: 'REFERENCE_UPLOAD',
          role,
          assetId: meta.id,
          sha256Hash: meta.sha256Hash,
          mimeType: meta.mimeType,
        };
        deduped.set(`${asset.source}|${asset.assetId}|${asset.role}`, asset);
      }
    }
  }

  return [...deduped.values()].sort((a, b) => {
    const roleDiff = ROLE_PRECEDENCE[a.role] - ROLE_PRECEDENCE[b.role];
    if (roleDiff !== 0) return roleDiff;
    const sourceDiff = a.source.localeCompare(b.source, 'en');
    if (sourceDiff !== 0) return sourceDiff;
    return a.assetId.localeCompare(b.assetId, 'en');
  });
}

/**
 * Deterministically compiles an immutable StoryRevision + ShotRevision + resolved
 * references into a GenerationRequestTemplateV2 without truncation or network calls.
 */
export function compileGenerationTemplate(input: CompileGenerationTemplateInput): GenerationRequestTemplateV2 {
  const { shotSpec, storyBible } = input;
  const start = shotSpec.continuity.start;
  const end = shotSpec.continuity.end;

  const angle = shotSpec.schemaVersion === '2' ? shotSpec.camera.angle : ('UNSPECIFIED' as const);
  const camera = {
    angle,
    framing: shotSpec.camera.framing.trim(),
    movement: shotSpec.camera.movement.trim(),
  };

  const [location] = resolveReferenced(storyBible.locations, [shotSpec.locationId], 'location');
  const [styleRef] = resolveReferenced(storyBible.styleRefs, [shotSpec.styleRefId], 'styleRef');

  const charIds = [
    ...shotSpec.subjectIds,
    ...start.characterStates.map(c => c.characterId),
    ...end.characterStates.map(c => c.characterId),
  ];
  const subjects = resolveReferenced(storyBible.characters, charIds, 'character');

  const wardrobeIds = [
    ...start.characterStates.map(c => c.wardrobeId),
    ...end.characterStates.map(c => c.wardrobeId),
  ];
  const wardrobes = resolveReferenced(storyBible.wardrobes, wardrobeIds, 'wardrobe');

  const propIds = [
    ...start.propIds,
    ...end.propIds,
    ...start.characterStates.flatMap(c => c.heldPropIds),
    ...end.characterStates.flatMap(c => c.heldPropIds),
  ];
  const props = resolveReferenced(storyBible.props, propIds, 'prop');

  const nameById = <T extends { id: string; name: string }>(items: T[]) => new Map(items.map(x => [x.id, x.name]));
  const charNames = nameById(subjects);
  const wardrobeNames = nameById(wardrobes);
  const propNames = nameById(props);

  const formatCharStates = (states: typeof start.characterStates) =>
    states
      .map(cs => {
        const cName = charNames.get(cs.characterId) ?? cs.characterId;
        const wName = wardrobeNames.get(cs.wardrobeId) ?? cs.wardrobeId;
        const held = cs.heldPropIds.length > 0 ? `, holding ${cs.heldPropIds.map(id => propNames.get(id) ?? id).join(', ')}` : '';
        return `${cName} (${wName}, pose: ${cs.pose.trim()}${held})`;
      })
      .join('; ');

  let prompt: string;
  if (input.kind === 'IMAGE') {
    const lines: string[] = [
      shotSpec.prompt.trim(),
      `Shot type: ${shotSpec.shotType}`,
      `Camera: angle=${camera.angle}, framing=${camera.framing}, movement=${camera.movement}`,
      `Location: ${location.name} — ${location.description.trim()}`,
      `Visual style: ${styleRef.name} — ${styleRef.description.trim()}`,
    ];

    if (subjects.length > 0) {
      lines.push(`Subjects: ${subjects.map(s => `${s.name} — ${s.description.trim()}`).join('; ')}`);
    }
    if (wardrobes.length > 0) {
      lines.push(`Wardrobes: ${wardrobes.map(w => `${w.name} — ${w.description.trim()}`).join('; ')}`);
    }
    const startChars = formatCharStates(start.characterStates);
    const endChars = formatCharStates(end.characterStates);
    if (startChars || endChars) {
      lines.push(`Character states: start=[${startChars || 'none'}]; end=[${endChars || 'none'}]`);
    }
    if (props.length > 0) {
      lines.push(
        `Props: ${props.map(p => `${p.name}${p.hero ? ' [HERO]' : ''} — ${p.description.trim()}`).join('; ')}`,
      );
    }
    lines.push(`Lighting: start=${start.lighting.trim()}; end=${end.lighting.trim()}`);
    if (shotSpec.intendedTransitions.length > 0) {
      lines.push(
        `Transitions: ${shotSpec.intendedTransitions.map(t => `${t.field}: ${t.reason.trim()}`).join('; ')}`,
      );
    }
    prompt = lines.join('\n');
    if (prompt.length > MAX_IMAGE_PROMPT_CHARS) {
      throw new ApiFailure(
        422,
        'COMPILED_PROMPT_TOO_LONG',
        `Compiled IMAGE prompt is ${prompt.length} characters (max ${MAX_IMAGE_PROMPT_CHARS})`,
      );
    }
  } else {
    // VIDEO I2V profile: focus on motion/camera/start->end transitions without repeating static START_FRAME prose
    const lines: string[] = [
      shotSpec.prompt.trim(),
      `Camera: angle=${camera.angle}, movement=${camera.movement}, framing=${camera.framing}`,
    ];
    const startChars = formatCharStates(start.characterStates);
    const endChars = formatCharStates(end.characterStates);
    if (startChars || endChars) {
      lines.push(`State progression: start=[${startChars || 'none'}] -> end=[${endChars || 'none'}]`);
    }
    if (start.lighting.trim() !== end.lighting.trim()) {
      lines.push(`Lighting shift: ${start.lighting.trim()} -> ${end.lighting.trim()}`);
    }
    if (shotSpec.intendedTransitions.length > 0) {
      lines.push(
        `Transitions: ${shotSpec.intendedTransitions.map(t => `${t.field}: ${t.reason.trim()}`).join('; ')}`,
      );
    }
    prompt = lines.join('\n');
    if (prompt.length > MAX_VIDEO_PROMPT_CHARS) {
      throw new ApiFailure(
        422,
        'COMPILED_PROMPT_TOO_LONG',
        `Compiled VIDEO prompt is ${prompt.length} characters (max ${MAX_VIDEO_PROMPT_CHARS})`,
      );
    }
  }

  const inputAssets = collectInputAssets(
    [
      { role: 'CHARACTER_REFERENCE', defs: subjects },
      { role: 'WARDROBE_REFERENCE', defs: wardrobes },
      { role: 'PROP_REFERENCE', defs: props },
      { role: 'LOCATION_REFERENCE', defs: [location] },
      { role: 'STYLE_REFERENCE', defs: [styleRef] },
    ],
    input.referenceAssets,
    input.kind === 'VIDEO' ? input.selectedStartFrame : undefined,
  );

  const templateInput: Record<string, unknown> = {
    filmId: input.filmId,
    storyRevisionId: input.storyRevisionId,
    shotRevisionId: input.shotRevisionId,
    kind: input.kind,
    provider: input.provider,
    modelId: input.modelId,
    rateCardSnapshotId: input.rateCardSnapshotId,
    executionMode: input.executionMode,
    prompt,
    negativePrompt: shotSpec.negativePrompt.trim(),
    promptCompilerVersion: COMPILER_VERSION,
    shotDependencyHash: input.shotDependencyHash,
    camera,
    aspectRatio: '9:16',
    inputAssets,
    structuredIntent: {
      shotType: shotSpec.shotType,
      authoredPrompt: shotSpec.prompt.trim(),
      camera,
      location: { id: location.id, name: location.name, description: location.description },
      styleRef: { id: styleRef.id, name: styleRef.name, description: styleRef.description },
      subjects: subjects.map(s => ({ id: s.id, name: s.name, description: s.description })),
      wardrobes: wardrobes.map(w => ({ id: w.id, name: w.name, description: w.description })),
      props: props.map(p => ({ id: p.id, name: p.name, description: p.description, hero: Boolean(p.hero) })),
      continuity: {
        startLighting: start.lighting,
        endLighting: end.lighting,
        startCharacters: start.characterStates,
        endCharacters: end.characterStates,
      },
      intendedTransitions: shotSpec.intendedTransitions,
    },
  };

  if (input.kind === 'VIDEO') {
    templateInput.durationSeconds = shotSpec.durationSeconds;
  }
  if (input.executionMode === 'REPLAY') {
    templateInput.fixturePackVersion = input.fixturePackVersion;
    templateInput.fixtureId = input.fixtureId;
  }

  return generationRequestTemplateV2Schema.parse(templateInput);
}
