'use client';
import { useEffect, useState } from 'react';
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

interface KeyframeReviewProps {
  filmId: string;
  shotId: string;
  shotRevisionId: string;
  keyframeRequirement?: 'REQUIRED' | 'OPTIONAL';
  isOpen: boolean;
  onClose: () => void;
  onReviewSubmitted?: () => void;
}

export function KeyframeReviewModal({
  filmId,
  shotId,
  shotRevisionId,
  keyframeRequirement = 'REQUIRED',
  isOpen,
  onClose,
  onReviewSubmitted,
}: KeyframeReviewProps) {
  const [assets, setAssets] = useState<AssetWithStatus[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);

  async function loadAssets() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/films/${filmId}/shots/${shotId}/assets`, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(await errorMessage(res));
      }
      const data = (await res.json()) as AssetWithStatus[];
      const imageAssets = data.filter(a => a.kind === 'IMAGE');
      setAssets(imageAssets);
      // Select currently selected asset, or first
      const selectedIdx = imageAssets.findIndex(a => a.isSelected);
      setSelectedIndex(selectedIdx >= 0 ? selectedIdx : 0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load keyframe assets');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isOpen) {
      void loadAssets();
      setShowRejectForm(false);
      setRejectReason('');
    }
  }, [isOpen, filmId, shotId]);

  if (!isOpen) return null;

  const currentAsset = assets[selectedIndex];
  const hasApprovedKeyframe = assets.some(a => a.latestReviewDecision === 'APPROVED' && a.isSelected);

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
      await loadAssets();
      if (onReviewSubmitted) onReviewSubmitted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Review submission failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="keyframe-review-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-6 text-zinc-100 shadow-2xl space-y-6">
        <header className="flex items-center justify-between border-b border-zinc-800 pb-3">
          <div>
            <h2 id="keyframe-review-title" className="text-lg font-bold">
              Keyframe Review & Approval
            </h2>
            <p className="text-xs text-zinc-400">
              Policy: <span className="font-semibold text-zinc-200">{keyframeRequirement}</span> · Revision:{' '}
              <span className="font-mono text-zinc-300">{shotRevisionId.slice(0, 8)}</span>
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
          <div className="flex h-48 items-center justify-center text-sm text-zinc-400">Loading assets…</div>
        ) : assets.length === 0 ? (
          <div className="py-8 text-center space-y-2">
            <p className="text-zinc-300">No keyframe assets found for this shot revision.</p>
            <p className="text-xs text-zinc-500">
              Generate a keyframe attempt from the Shot Inspector to review and approve reference frames.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Attempt thumbnail selector if multiple exist */}
            {assets.length > 1 && (
              <div className="flex gap-2 overflow-x-auto pb-2">
                {assets.map((asset, idx) => (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => {
                      setSelectedIndex(idx);
                      setShowRejectForm(false);
                      setRejectReason('');
                    }}
                    className={`relative h-20 w-12 flex-shrink-0 overflow-hidden rounded border text-xs ${
                      selectedIndex === idx ? 'border-amber-400 ring-2 ring-amber-400/20' : 'border-zinc-800'
                    }`}
                  >
                    <img src={asset.mediaUrl} alt={`Thumbnail ${idx + 1}`} className="h-full w-full object-cover" />
                    {asset.isSelected && (
                      <span className="absolute bottom-0 inset-x-0 bg-emerald-500 text-[10px] text-black font-bold text-center">
                        Active
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {currentAsset && (
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-[180px_1fr]">
                {/* 9:16 Keyframe Preview */}
                <div className="flex flex-col items-center">
                  <div className="relative aspect-[9/16] w-full max-w-[180px] overflow-hidden rounded-md border border-zinc-800 bg-zinc-900 shadow-inner">
                    <img
                      src={currentAsset.mediaUrl}
                      alt="Keyframe preview 9:16"
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <span className="mt-2 text-[10px] font-mono text-zinc-500">9:16 Vertical Keyframe</span>
                </div>

                {/* Metadata & Decision details */}
                <div className="space-y-3 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-400">Review status:</span>
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
                    {currentAsset.isSelected && (
                      <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
                        Selected for Video
                      </span>
                    )}
                  </div>

                  {currentAsset.latestReviewReason && (
                    <div className="rounded bg-zinc-900 p-2 text-xs text-zinc-300">
                      <span className="font-semibold text-zinc-400">Review note: </span>
                      {currentAsset.latestReviewReason}
                    </div>
                  )}

                  <div className="space-y-1 text-xs text-zinc-400 font-mono">
                    <p>
                      SHA-256:{' '}
                      <span className="text-zinc-200">
                        {currentAsset.sha256Hash.slice(0, 16)}…{currentAsset.sha256Hash.slice(-8)}
                      </span>
                    </p>
                    <p>
                      File size:{' '}
                      <span className="text-zinc-200">
                        {(Number(currentAsset.byteSize) / 1024).toFixed(1)} KB ({currentAsset.mimeType})
                      </span>
                    </p>
                    <p>
                      Reviews logged:{' '}
                      <span className="text-zinc-200">{currentAsset.reviewCount}</span>
                    </p>
                    <p>
                      Attempt ID:{' '}
                      <span className="text-zinc-200">{currentAsset.attemptId.slice(0, 8)}…</span>
                    </p>
                  </div>

                  {/* Review Actions */}
                  <div className="pt-3 border-t border-zinc-800 space-y-3">
                    {!showRejectForm ? (
                      <div className="flex gap-2">
                        <Button
                          variant="default"
                          disabled={submitting}
                          onClick={() => void handleReview('APPROVED')}
                          className="bg-emerald-600 hover:bg-emerald-500 text-white"
                        >
                          Approve Keyframe
                        </Button>
                        <Button
                          variant="outline"
                          disabled={submitting}
                          onClick={() => setShowRejectForm(true)}
                          className="border-rose-800 text-rose-300 hover:bg-rose-950/60"
                        >
                          Reject…
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2 rounded bg-zinc-900 p-3">
                        <label className="block text-xs font-semibold text-rose-300">
                          Rejection Reason (required):
                        </label>
                        <textarea
                          rows={2}
                          className="w-full rounded border border-zinc-700 bg-zinc-950 p-2 text-xs text-zinc-100"
                          placeholder="State reason (e.g. character distortion, incorrect lighting, wrong wardrobe)..."
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

        <footer className="flex items-center justify-between border-t border-zinc-800 pt-4 text-xs text-zinc-400">
          <div>
            {hasApprovedKeyframe ? (
              <span className="text-emerald-400 font-semibold">✓ Keyframe approved — video generation enabled</span>
            ) : keyframeRequirement === 'REQUIRED' ? (
              <span className="text-amber-400 font-semibold">⚠ Approval required before video generation</span>
            ) : (
              <span className="text-zinc-400">Keyframe optional for this shot</span>
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
