'use client';
import { useEffect, useState } from 'react';
import type { ShotAttemptDto } from '@nolen/contracts';
import { Button } from './ui/button';
import { errorMessage } from '../lib/api';

export type AssetWithStatus = {
  id: string;
  filmId: string;
  attemptId: string;
  shotRevisionId: string;
  kind: 'IMAGE' | 'VIDEO';
  mediaUrl: string;
  sha256Hash: string;
  mimeType: string;
  byteSize: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  latestReviewDecision: 'APPROVED' | 'REJECTED' | null;
  latestReviewReason: string | null;
  reviewCount: number;
  isSelected: boolean;
};

interface VideoReviewProps {
  filmId: string;
  shotId: string;
  shotRevisionId: string;
  shotPrompt?: string;
  isOpen: boolean;
  onClose: () => void;
  onReviewSubmitted?: () => void;
}

export function VideoReviewModal({
  filmId,
  shotId,
  shotRevisionId,
  shotPrompt,
  isOpen,
  onClose,
  onReviewSubmitted,
}: VideoReviewProps) {
  const [assets, setAssets] = useState<AssetWithStatus[]>([]);
  const [attempts, setAttempts] = useState<ShotAttemptDto[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);

  async function loadData() {
    setLoading(true);
    setError('');
    try {
      const [assetsRes, attemptsRes] = await Promise.all([
        fetch(`/api/films/${filmId}/shots/${shotId}/assets`, { cache: 'no-store' }),
        fetch(`/api/films/${filmId}/shots/${shotId}/attempts`, { cache: 'no-store' }),
      ]);

      if (!assetsRes.ok) {
        throw new Error(await errorMessage(assetsRes));
      }
      const allAssets = (await assetsRes.json()) as AssetWithStatus[];
      const videoAssets = allAssets.filter(a => a.kind === 'VIDEO');
      setAssets(videoAssets);

      const selectedIdx = videoAssets.findIndex(a => a.isSelected);
      setSelectedIndex(selectedIdx >= 0 ? selectedIdx : 0);

      if (attemptsRes.ok) {
        const attemptsData = (await attemptsRes.json()) as ShotAttemptDto[];
        setAttempts(attemptsData.filter(a => a.kind === 'VIDEO'));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load video assets');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isOpen) {
      void loadData();
      setShowRejectForm(false);
      setRejectReason('');
    }
  }, [isOpen, filmId, shotId]);

  if (!isOpen) return null;

  const currentAsset = assets[selectedIndex];
  const hasApprovedVideo = assets.some(a => a.latestReviewDecision === 'APPROVED' && a.isSelected);

  async function handleReview(decision: 'APPROVED' | 'REJECTED') {
    if (!currentAsset) return;
    if (decision === 'REJECTED' && !rejectReason.trim()) {
      setError('A rejection reason is required');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`/api/assets/${currentAsset.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          reason: decision === 'REJECTED' ? rejectReason.trim() : undefined,
          expectedShotRevisionId: shotRevisionId,
          expectedReviewCount: currentAsset.reviewCount,
        }),
      });

      if (!res.ok) {
        throw new Error(await errorMessage(res));
      }

      setShowRejectForm(false);
      setRejectReason('');
      await loadData();
      if (onReviewSubmitted) onReviewSubmitted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Review submission failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSelectActive() {
    if (!currentAsset) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`/api/films/${filmId}/shots/${shotId}/selections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetId: currentAsset.id,
          kind: 'VIDEO',
        }),
      });

      if (!res.ok) {
        throw new Error(await errorMessage(res));
      }

      await loadData();
      if (onReviewSubmitted) onReviewSubmitted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Selection failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="video-review-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-6 text-zinc-100 shadow-2xl space-y-6">
        <header className="flex items-center justify-between border-b border-zinc-800 pb-3">
          <div>
            <h2 id="video-review-title" className="text-lg font-bold">
              Shot Video Review & Asset Selection
            </h2>
            <p className="text-xs text-zinc-400">
              Shot Revision: <span className="font-mono text-zinc-300">{shotRevisionId.slice(0, 8)}</span>
              {shotPrompt && <span className="ml-2 italic text-zinc-500 truncate max-w-md inline-block align-bottom">“{shotPrompt.slice(0, 50)}…”</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </header>

        {error && (
          <p role="alert" className="rounded bg-rose-950/60 p-2 text-sm text-rose-300 border border-rose-800">
            {error}
          </p>
        )}

        {loading ? (
          <div className="flex h-64 items-center justify-center text-sm text-zinc-400">Loading video assets…</div>
        ) : assets.length === 0 ? (
          <div className="py-12 text-center space-y-3">
            <p className="text-zinc-300 font-semibold">No video assets generated for this shot yet.</p>
            <p className="text-xs text-zinc-500 max-w-md mx-auto">
              Ensure keyframe approval is satisfied (if required), then click “Generate Video” in the Shot Inspector.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Version / Attempt Selector Tabs */}
            {assets.length > 1 && (
              <div className="flex gap-2 overflow-x-auto pb-2 border-b border-zinc-800">
                {assets.map((asset, idx) => (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => {
                      setSelectedIndex(idx);
                      setShowRejectForm(false);
                      setRejectReason('');
                    }}
                    className={`flex items-center gap-2 rounded px-3 py-1.5 text-xs font-medium border ${
                      selectedIndex === idx
                        ? 'bg-zinc-800 border-amber-400 text-amber-300'
                        : 'border-zinc-800 text-zinc-400 hover:bg-zinc-900'
                    }`}
                  >
                    <span>Attempt {assets.length - idx}</span>
                    {asset.isSelected && (
                      <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300 border border-emerald-500/40">
                        Active
                      </span>
                    )}
                    {asset.latestReviewDecision === 'APPROVED' && (
                      <span className="text-emerald-400">✓</span>
                    )}
                    {asset.latestReviewDecision === 'REJECTED' && (
                      <span className="text-rose-400">✗</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {currentAsset && (
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-[220px_1fr]">
                {/* 9:16 Vertical Video Preview */}
                <div className="flex flex-col items-center">
                  <div className="relative aspect-[9/16] w-full max-w-[220px] overflow-hidden rounded-md border border-zinc-800 bg-zinc-900 shadow-inner">
                    <video
                      key={currentAsset.mediaUrl}
                      src={currentAsset.mediaUrl}
                      controls
                      autoPlay
                      loop
                      playsInline
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <span className="mt-2 text-[10px] font-mono text-zinc-500">9:16 Vertical Video Preview</span>
                </div>

                {/* Details & Decision Panel */}
                <div className="space-y-4 text-sm">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-zinc-400">Decision:</span>
                    {currentAsset.latestReviewDecision === 'APPROVED' ? (
                      <span className="rounded bg-emerald-950 px-2 py-0.5 text-xs font-semibold text-emerald-300 border border-emerald-800">
                        APPROVED
                      </span>
                    ) : currentAsset.latestReviewDecision === 'REJECTED' ? (
                      <span className="rounded bg-rose-950 px-2 py-0.5 text-xs font-semibold text-rose-300 border border-rose-800">
                        REJECTED
                      </span>
                    ) : (
                      <span className="rounded bg-amber-950 px-2 py-0.5 text-xs font-semibold text-amber-300 border border-amber-800">
                        PENDING REVIEW
                      </span>
                    )}
                    {currentAsset.isSelected ? (
                      <span className="rounded bg-emerald-900/60 px-2 py-0.5 text-xs text-emerald-200 border border-emerald-700">
                        ✓ Selected for Timeline Assembly
                      </span>
                    ) : currentAsset.latestReviewDecision === 'APPROVED' ? (
                      <Button
                        variant="outline"
                        disabled={submitting}
                        onClick={() => void handleSelectActive()}
                        className="text-xs h-6 px-2 border-zinc-700 hover:bg-zinc-800"
                      >
                        Set as Active
                      </Button>
                    ) : null}
                  </div>

                  {currentAsset.latestReviewReason && (
                    <div className="rounded bg-zinc-900 p-2 text-xs text-zinc-300 border border-zinc-800">
                      <span className="font-semibold text-zinc-400">Review note: </span>
                      {currentAsset.latestReviewReason}
                    </div>
                  )}

                  <div className="space-y-1 text-xs text-zinc-400 font-mono bg-zinc-900/60 p-3 rounded border border-zinc-800/80">
                    <p>
                      SHA-256:{' '}
                      <span className="text-zinc-200">
                        {currentAsset.sha256Hash.slice(0, 16)}…{currentAsset.sha256Hash.slice(-8)}
                      </span>
                    </p>
                    <p>
                      File size:{' '}
                      <span className="text-zinc-200">
                        {(Number(currentAsset.byteSize) / (1024 * 1024)).toFixed(2)} MB ({currentAsset.mimeType})
                      </span>
                    </p>
                    <p>
                      Attempt ID:{' '}
                      <span className="text-zinc-200">{currentAsset.attemptId.slice(0, 8)}…</span>
                    </p>
                    <p>
                      Generated:{' '}
                      <span className="text-zinc-200">{new Date(currentAsset.createdAt).toLocaleString()}</span>
                    </p>
                  </div>

                  {/* Producer Review Actions */}
                  <div className="pt-3 border-t border-zinc-800 space-y-3">
                    {!showRejectForm ? (
                      <div className="flex gap-2">
                        <Button
                          variant="default"
                          disabled={submitting || currentAsset.latestReviewDecision === 'APPROVED'}
                          onClick={() => void handleReview('APPROVED')}
                          className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                        >
                          Approve Video
                        </Button>
                        <Button
                          variant="outline"
                          disabled={submitting}
                          onClick={() => setShowRejectForm(true)}
                          className="border-rose-800 text-rose-300 hover:bg-rose-950/60"
                        >
                          Reject Video…
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2 rounded bg-zinc-900 p-3 border border-rose-900/50">
                        <label className="block text-xs font-semibold text-rose-300">
                          Rejection Reason (required for audit ledger):
                        </label>
                        <textarea
                          rows={2}
                          className="w-full rounded border border-zinc-700 bg-zinc-950 p-2 text-xs text-zinc-100"
                          placeholder="Explain visual flaws (motion blur, temporal flicker, identity drift, artifacting)..."
                          value={rejectReason}
                          onChange={e => setRejectReason(e.target.value)}
                        />
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            disabled={submitting || !rejectReason.trim()}
                            onClick={() => void handleReview('REJECTED')}
                            className="bg-rose-900 hover:bg-rose-800 text-rose-100 border-rose-700"
                          >
                            Confirm Rejection
                          </Button>
                          <Button
                            variant="outline"
                            disabled={submitting}
                            onClick={() => {
                              setShowRejectForm(false);
                              setRejectReason('');
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Attempt History List */}
        {attempts.length > 0 && (
          <section className="border-t border-zinc-800 pt-3">
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
              Attempt Execution History ({attempts.length})
            </h3>
            <div className="max-h-32 overflow-y-auto space-y-1.5 text-xs font-mono">
              {attempts.map(att => (
                <div
                  key={att.id}
                  className="flex items-center justify-between rounded bg-zinc-900/70 px-2.5 py-1 text-zinc-300 border border-zinc-800/50"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-500">{att.id.slice(0, 8)}</span>
                    <span className="rounded bg-zinc-800 px-1.5 py-0.2 text-[10px] text-zinc-400">
                      {att.executionMode}
                    </span>
                    <span>{att.provider ?? 'PROVIDER'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[10px] font-semibold ${
                        att.state === 'SUCCEEDED'
                          ? 'text-emerald-400'
                          : att.state === 'FAILED'
                          ? 'text-rose-400'
                          : 'text-amber-400'
                      }`}
                    >
                      {att.state}
                    </span>
                    <span className="text-[10px] text-zinc-500">
                      {new Date(att.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <footer className="flex items-center justify-between border-t border-zinc-800 pt-4 text-xs text-zinc-400">
          <div>
            {hasApprovedVideo ? (
              <span className="text-emerald-400 font-semibold">✓ Approved video selected for timeline assembly</span>
            ) : (
              <span className="text-amber-400">⚠ Requires producer approval before final export</span>
            )}
          </div>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </footer>
      </div>
    </div>
  );
}
