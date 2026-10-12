import { Maximize2 } from 'lucide-react';
import { useSim } from '../../store/sim';
import { useUI, type FeedSource } from '../../store/ui';
import { FEED_META } from '../../three/feedCameras';
import { FeedViewport } from './FeedViewport';
import { fmtClock } from '../../utils/format';
import { cx, useNow } from '../ui/primitives';

export function FeedStamp({ source, stale, staleSince }: { source: FeedSource; stale: boolean; staleSince: number | null }) {
  const now = useNow(1000);
  return (
    <span className="mono rounded-[3px] bg-bg-0/45 px-1 py-px text-[10.5px] text-ink-1/95" style={{ textShadow: '0 1px 2px rgb(0 0 0 / 0.9)' }}>
      {fmtClock(stale && staleSince ? staleSince : now)} GST <span className="text-ink-2">· {stale ? '0' : FEED_META[source].fps} FPS</span>
    </span>
  );
}

export function LiveChip({ stale }: { stale: boolean }) {
  return stale ? (
    <span className="inline-flex items-center gap-1 rounded-[3px] bg-[rgb(242_179_61/0.16)] px-1.5 py-[1px] font-cond text-[10px] font-semibold uppercase tracking-[0.1em] text-amber">
      Stale
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 font-cond text-[10px] font-semibold uppercase tracking-[0.1em] text-green">
      <span className="h-[6px] w-[6px] rounded-full bg-green shadow-[0_0_6px_#3dd68c]" aria-hidden />
      {/* a narrow tile keeps the green dot and gives the camera name the room */}
      <span className="@max-[200px]:sr-only">Sim live</span>
    </span>
  );
}

export function FeedTile({ source, viewId }: { source: FeedSource; viewId: string }) {
  const mode = useUI((s) => s.feedModes[source]);
  const overlays = useUI((s) => s.feedOverlays);
  const feed = useSim((s) => s.feeds[source]);
  const stale = !!feed?.stale;
  const meta = FEED_META[source];
  const open = () => {
    const ui = useUI.getState();
    ui.setFeedMain(source);
    ui.setScreen('feeds');
  };
  return (
    <div className="group @container relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[6px] border border-line transition-colors hover:border-line-bright">
      <div className="flex h-[25px] shrink-0 items-center gap-1.5 bg-surface-2 px-2">
        <span className="mono shrink-0 whitespace-nowrap text-[11px] font-medium text-ink-1">{source}</span>
        <span className="shrink-0 text-ink-4" aria-hidden>
          |
        </span>
        <span className="min-w-0 truncate text-[11px] text-ink-2" title={meta.label}>
          {meta.short}
        </span>
        <span className="ml-auto shrink-0">
          <LiveChip stale={stale} />
        </span>
      </div>
      <FeedViewport viewId={viewId} source={source} mode={mode} size="thumb" detections={overlays} compact className="relative min-h-0 flex-1">
        <div className="pointer-events-none absolute left-1.5 top-1 z-10">
          <FeedStamp source={source} stale={stale} staleSince={feed?.staleSince ?? null} />
        </div>
        {mode !== 'visible' && (
          <span className="pointer-events-none absolute bottom-1.5 left-1.5 z-10 rounded-[3px] bg-bg-0/70 px-1.5 py-[1px] font-cond text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-1">
            {mode === 'thermal' ? 'Thermal · LWIR' : 'Fusion'}
          </span>
        )}
        {stale && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="rounded-[4px] border border-amber/40 bg-bg-0/75 px-2 py-1 font-cond text-[10.5px] font-semibold uppercase tracking-[0.12em] text-amber">
              Signal stale · last frame held
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={open}
          className={cx('absolute bottom-1.5 right-1.5 z-10 flex h-[22px] w-[22px] items-center justify-center rounded-[4px] border border-line-strong bg-bg-0/70 text-ink-2 opacity-80 transition-opacity hover:text-ink-1 group-hover:opacity-100')}
          aria-label={`Open ${source} in Live Feeds`}
        >
          <Maximize2 size={12} />
        </button>
        <button type="button" className="absolute inset-0 z-0 cursor-pointer" aria-label={`Select ${source}`} onClick={open} tabIndex={-1} />
      </FeedViewport>
    </div>
  );
}
