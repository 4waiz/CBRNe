import { useEffect, useRef, useState } from 'react';
import {
  Cctv,
  Camera,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  ScanEye,
  ScanLine,
  Thermometer,
  Rewind,
  Radio,
  Crosshair,
  Bot,
  Drone,
  Video,
  User,
  Truck,
  Building,
  Flame,
  CloudFog,
  Activity,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useSim } from '../../store/sim';
import { useUI, FEED_SOURCES, type FeedMode, type FeedSource } from '../../store/ui';
import { FeedViewport } from '../../components/feeds/FeedViewport';
import { FeedTile, FeedStamp, LiveChip } from '../../components/feeds/FeedTile';
import { FEED_META, cam02Directed, resetFeedOffset } from '../../three/feedCameras';
import { requestSnapshot } from '../../three/RenderLoop';
import { focusOn } from '../../three/CameraRig';
import { heatToCelsius } from '../../three/thermal';
import { Panel, Segmented, Toggle, IconButton, cx, StatusDot, Kbd, useNow } from '../../components/ui/primitives';
import type { Detection } from '../../three/detections';
import { fmtClock } from '../../utils/format';

const KIND_ICON: Record<Detection['kind'], LucideIcon> = {
  person: User,
  robot: Bot,
  vehicle: Truck,
  structure: Building,
  hotspot: Thermometer,
  aircraft: Drone,
  fire: Flame,
  smoke: CloudFog,
};

const MODE_OPTIONS: { value: FeedMode; label: string }[] = [
  { value: 'visible', label: 'Visible' },
  { value: 'thermal', label: 'Thermal' },
  { value: 'fusion', label: 'Fusion' },
];

/** CAM-02 is being steered by the incident director (fire response); the operator's PTZ still applies. */
function AutoTrack() {
  useNow(1000);
  if (!cam02Directed()) return null;
  return <span className="rounded-[3px] bg-[rgb(242_179_61/0.2)] px-1.5 py-[1px] normal-case tracking-normal text-amber">Auto-track · incident</span>;
}

function ThermalScale() {
  const palette = useUI((s) => s.settings.palette);
  const grad =
    palette === 'ironbow'
      ? 'linear-gradient(0deg, #000000, #20084a 16%, #761684 34%, #ce3240 52%, #f0701e 68%, #fbca3e 84%, #fffcec)'
      : 'linear-gradient(0deg, #08080a, #78797e 50%, #fafcff)';
  return (
    <div className="pointer-events-none flex items-stretch gap-1.5">
      <div className="w-[8px] rounded-[2px]" style={{ background: grad }} />
      <div className="mono flex flex-col justify-between py-[1px] text-[9.5px] text-ink-1" style={{ textShadow: '0 1px 2px #000' }}>
        <span>{heatToCelsius(1.08).toFixed(0)} °C</span>
        <span>{heatToCelsius(0.64).toFixed(0)}</span>
        <span>{heatToCelsius(0.2).toFixed(0)} °C</span>
      </div>
    </div>
  );
}

function MainFeed({ source, onDetections }: { source: FeedSource; onDetections: (d: Detection[]) => void }) {
  const mode = useUI((s) => s.feedModes[source]);
  const overlays = useUI((s) => s.feedOverlays);
  const feed = useSim((s) => s.feeds[source]);
  const ptz = useUI((s) => (source === 'CAM-01' || source === 'CAM-02' ? s.ptz[source] : null));
  const moved = useUI((s) => (source === 'CAM-01' || source === 'CAM-02' ? s.feedMoved[source] : 0));
  const pb = useUI((s) => s.playback);
  const stale = !!feed?.stale;
  const meta = FEED_META[source];
  const drag = useRef<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState(false);
  const fixed = source === 'CAM-01' || source === 'CAM-02';

  // brief crossfade when the source changes
  useEffect(() => {
    setFade(true);
    const id = setTimeout(() => setFade(false), 220);
    return () => clearTimeout(id);
  }, [source, mode]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el || !fixed) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cur = useUI.getState().ptz[source as 'CAM-01' | 'CAM-02'];
      useUI.getState().setPtz(source as 'CAM-01' | 'CAM-02', { zoom: Math.min(4, Math.max(1, cur.zoom * (e.deltaY < 0 ? 1.12 : 0.9))) });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [source, fixed]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <FeedViewport viewId="feeds-main" source={source} mode={mode} size="large" detections={overlays} onDetections={onDetections} className="relative min-h-0 flex-1">
        <div
          ref={inputRef}
          className={cx('absolute inset-0 z-[1]', ptz ? 'cursor-move' : 'cursor-default')}
          onPointerDown={(e) => {
            if (!ptz) return;
            drag.current = { x: e.clientX, y: e.clientY };
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current || !ptz) return;
            const dx = e.clientX - drag.current.x;
            const dy = e.clientY - drag.current.y;
            drag.current = { x: e.clientX, y: e.clientY };
            const cur = useUI.getState().ptz[source as 'CAM-01' | 'CAM-02'];
            const k = 0.09 / cur.zoom;
            useUI.getState().setPtz(source as 'CAM-01' | 'CAM-02', {
              yaw: Math.max(-70, Math.min(70, cur.yaw - dx * k)),
              pitch: Math.max(-25, Math.min(20, cur.pitch + dy * k)),
            });
          }}
          onPointerUp={() => (drag.current = null)}
          aria-label={ptz ? `${source} view. Drag to pan and tilt, scroll to zoom.` : `${source} view`}
          role="img"
        />
        <div className={cx('pointer-events-none absolute inset-0 z-[2] bg-bg-0 transition-opacity duration-200', fade ? 'opacity-70' : 'opacity-0')} />
        <div className="pointer-events-none absolute left-3 top-2.5 z-[3] flex flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="mono text-[13px] font-medium text-ink-1" style={{ textShadow: '0 1px 3px #000' }}>
              {source}
            </span>
            <span className="text-[12px] text-ink-1/90" style={{ textShadow: '0 1px 3px #000' }}>
              {meta.label}
            </span>
          </span>
          <FeedStamp source={source} stale={stale} staleSince={feed?.staleSince ?? null} />
        </div>
        <div className="pointer-events-none absolute right-3 top-2.5 z-[3] flex items-center gap-2 rounded-[4px] bg-bg-0/45 px-1.5 py-0.5">
          {pb.mode === 'replay' ? (
            <span className="rounded-[3px] bg-[rgb(242_179_61/0.2)] px-1.5 py-[1px] font-cond text-[10.5px] font-semibold uppercase tracking-[0.1em] text-amber">
              Replay {fmtClock(pb.cursor)}
            </span>
          ) : (
            <span className="flex items-center gap-1 font-cond text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#ff5a52]">
              <span className="h-[7px] w-[7px] rounded-full bg-[#ff5a52] animate-blink" aria-hidden /> Rec
            </span>
          )}
          <LiveChip stale={stale} />
        </div>
        {/* reticle */}
        <svg className="pointer-events-none absolute left-1/2 top-1/2 z-[3] -translate-x-1/2 -translate-y-1/2 opacity-60" width="54" height="54" aria-hidden>
          <path d="M0 12V0h12M42 0h12v12M54 42v12H42M12 54H0V42" fill="none" stroke="#ece7df" strokeWidth="1.2" />
          <path d="M27 21v12M21 27h12" stroke="#ece7df" strokeWidth="1" />
        </svg>
        {mode !== 'visible' && (
          <div className="absolute bottom-3 right-3 z-[3] h-[130px]">
            <ThermalScale />
          </div>
        )}
        <div className="pointer-events-none absolute bottom-2.5 left-3 z-[3] flex items-center gap-2 rounded-[4px] bg-bg-0/45 px-1.5 py-0.5 font-cond text-[10.5px] uppercase tracking-[0.12em] text-ink-1" style={{ textShadow: '0 1px 3px #000' }}>
          <span>{mode === 'visible' ? 'EO · Visible' : mode === 'thermal' ? 'LWIR · Thermal' : 'Fusion · EO + LWIR'}</span>
          {ptz && (
            <span className="mono normal-case tracking-normal text-ink-2">
              PAN {ptz.yaw.toFixed(1)}° · TILT {ptz.pitch.toFixed(1)}° · {ptz.zoom.toFixed(1)}×
            </span>
          )}
          {source === 'CAM-02' && <AutoTrack />}
          {moved > 0.5 && (
            <span className="rounded-[3px] bg-[rgb(60_200_220/0.22)] px-1.5 py-[1px] normal-case tracking-normal text-[#8fe8f5]">
              Virtual view · {Math.round(moved)} m from mount
            </span>
          )}
        </div>
        {stale && (
          <div className="pointer-events-none absolute inset-0 z-[4] flex items-center justify-center">
            <span className="rounded-[5px] border border-amber/40 bg-bg-0/80 px-3 py-1.5 font-cond text-[12px] font-semibold uppercase tracking-[0.12em] text-amber">
              Signal stale · last frame {feed?.staleSince ? fmtClock(feed.staleSince) : ''}
            </span>
          </div>
        )}
      </FeedViewport>
    </div>
  );
}

function SourceList({ main }: { main: FeedSource }) {
  const feeds = useSim((s) => s.feeds);
  const modes = useUI((s) => s.feedModes);
  return (
    <div className="flex flex-col gap-1">
      {FEED_SOURCES.map((s) => {
        const on = s === main;
        const stale = feeds[s]?.stale;
        const Icon = s === 'UGV-01' ? Bot : s === 'UAV-01' ? Drone : Video;
        return (
          <button
            key={s}
            type="button"
            onClick={() => useUI.getState().setFeedMain(s)}
            className={cx('flex items-center gap-2 rounded-[5px] border px-2 py-1.5 text-left transition-colors', on ? 'border-cyan/50 bg-[rgb(60_200_220/0.08)]' : 'border-line hover:bg-surface-2')}
            aria-pressed={on}
          >
            <Icon size={14} className={on ? 'text-cyan' : 'text-ink-3'} aria-hidden />
            <span className="mono text-[11.5px] text-ink-1">{s}</span>
            <span className="min-w-0 truncate text-[11px] text-ink-3">{FEED_META[s].kind}</span>
            <span className="ml-auto text-[10px] uppercase tracking-[0.08em] text-ink-3">{modes[s]}</span>
            <StatusDot tone={stale ? 'watch' : 'ok'} size={6} />
          </button>
        );
      })}
    </div>
  );
}

/** Stream parameters of the selected source (synthetic; bitrate and latency drift with the link). */
function StreamInfo({ source }: { source: FeedSource }) {
  const now = useNow(1000);
  const stale = useSim((s) => !!s.feeds[source]?.stale);
  const linkMs = useSim((s) => s.metrics.latencyMs);
  const meta = FEED_META[source];
  const wobble = Math.sin(now / 2300 + source.length) * 0.06 + Math.sin(now / 900 + source.charCodeAt(4)) * 0.03;
  const kbps = stale ? 0 : meta.kbps * (1 + wobble);
  const latency = source === 'CAM-01' || source === 'CAM-02' ? 70 + Math.round(wobble * 120) : source === 'UAV-01' ? linkMs + 60 : linkMs;
  const rows: [string, string][] = [
    ['Resolution', meta.res],
    ['Frame rate', `${stale ? 0 : meta.fps} fps`],
    ['Codec', `${meta.codec} · 2 s GOP`],
    ['Bitrate', stale ? '—' : `${(kbps / 1000).toFixed(1)} Mb/s`],
    ['Glass-to-glass', stale ? 'stalled' : `${latency} ms`],
    ['Link', meta.link],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[5px] px-3 py-2.5 text-[11.5px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className={cx('num truncate text-right', k === 'Glass-to-glass' && stale ? 'text-amber' : 'text-ink-1')}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function MoveHint() {
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap text-[10.5px] text-ink-3" title="Move a virtual view of this camera: W A S D move, Q / E height, Shift faster">
      <span className="flex items-center gap-0.5">
        <Kbd>W</Kbd>
        <Kbd>A</Kbd>
        <Kbd>S</Kbd>
        <Kbd>D</Kbd>
      </span>
      move
      <span className="flex items-center gap-0.5">
        <Kbd>Q</Kbd>
        <Kbd>E</Kbd>
      </span>
      height
    </div>
  );
}

function Ptz({ source }: { source: FeedSource }) {
  const ptz = useUI((s) => (source === 'CAM-01' || source === 'CAM-02' ? s.ptz[source] : null));
  const moved = useUI((s) => (source === 'CAM-01' || source === 'CAM-02' ? s.feedMoved[source] : 0));
  const setPtz = useUI((s) => s.setPtz);
  if (!ptz) {
    const asset = source as 'UGV-01' | 'UAV-01';
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[11px] leading-[15px] text-ink-3">
          Mounted camera, oriented by {asset}'s tasking. To move a virtual view with WASD, select CAM-01 or CAM-02.
        </p>
        <button
          type="button"
          className="ctl"
          onClick={() => {
            useUI.getState().setScreen('twin');
            useUI.getState().select({ kind: 'asset', id: asset });
            focusOn({ kind: 'asset', id: asset });
          }}
        >
          <Crosshair size={12} /> Locate {asset} in twin
        </button>
      </div>
    );
  }
  const cam = source as 'CAM-01' | 'CAM-02';
  const nudge = (dy: number, dp: number) => setPtz(cam, { yaw: Math.max(-70, Math.min(70, ptz.yaw + dy)), pitch: Math.max(-25, Math.min(20, ptz.pitch + dp)) });
  const resetAll = () => {
    setPtz(cam, { yaw: 0, pitch: 0, zoom: 1 });
    resetFeedOffset(cam);
    useUI.getState().setFeedMoved(cam, 0);
  };
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-4">
        <div className="grid grid-cols-3 grid-rows-3 gap-1">
          <span />
          <IconButton icon={ChevronUp} label="Tilt up" onClick={() => nudge(0, 2)} size={26} />
          <span />
          <IconButton icon={ChevronLeft} label="Pan left" onClick={() => nudge(4, 0)} size={26} />
          <IconButton icon={RotateCcw} label="Reset PTZ and position" onClick={resetAll} size={26} />
          <IconButton icon={ChevronRight} label="Pan right" onClick={() => nudge(-4, 0)} size={26} />
          <span />
          <IconButton icon={ChevronDown} label="Tilt down" onClick={() => nudge(0, -2)} size={26} />
          <span />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <span className="micro">Zoom</span>
            <span className="num text-[12px] text-ink-1">{ptz.zoom.toFixed(1)}×</span>
          </div>
          <input
            type="range"
            min={1}
            max={4}
            step={0.1}
            value={ptz.zoom}
            onChange={(e) => setPtz(cam, { zoom: Number(e.target.value) })}
            className="w-full accent-[var(--color-cyan)]"
            aria-label="Zoom"
          />
          <span className="text-[10.5px] text-ink-3">Drag the image to look · scroll to zoom</span>
        </div>
      </div>
      <div className="flex min-h-[24px] items-center justify-between gap-2">
        <MoveHint />
        {moved > 0.5 && (
          <button type="button" className="ctl h-[22px] shrink-0" onClick={resetAll}>
            Return to mount
          </button>
        )}
      </div>
    </div>
  );
}

export function FeedsScreen() {
  const main = useUI((s) => s.feedMain);
  const mode = useUI((s) => s.feedModes[main]);
  const setMode = useUI((s) => s.setFeedMode);
  const overlays = useUI((s) => s.feedOverlays);
  const palette = useUI((s) => s.settings.palette);
  const [dets, setDets] = useState<Detection[]>([]);
  const last = useRef(0);
  const onDetections = (d: Detection[]) => {
    const now = performance.now();
    if (now - last.current < 450) return;
    last.current = now;
    setDets(d);
  };
  const others = FEED_SOURCES.filter((s) => s !== main);

  const snapshot = async () => {
    try {
      const url = await requestSnapshot('feeds-main');
      const a = document.createElement('a');
      a.href = url;
      a.download = `bridge-${main}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      a.click();
      useUI.getState().notify(`Snapshot saved · ${main}`, 'ok');
    } catch {
      useUI.getState().notify('Snapshot failed', 'warn');
    }
  };

  const jump = (sec: number) => useUI.getState().setPlayback({ mode: 'replay', cursor: Date.now() - sec * 1000, playing: true });

  return (
    <div className="absolute inset-0 grid gap-2 p-2" style={{ gridTemplateColumns: 'minmax(0,1fr) clamp(300px, 22vw, 360px)', gridTemplateRows: 'minmax(0,1fr) clamp(150px, 24vh, 220px)' }}>
      <Panel
        title={
          <>
            {main} <span className="ml-1 font-sans text-[11px] font-normal normal-case tracking-normal text-ink-3">{FEED_META[main].label}</span>
          </>
        }
        icon={Cctv}
        iconColor="#3cc8dc"
        transparentBody
        className="min-h-0"
        actions={
          <>
            <Segmented label="Imaging mode" value={mode} onChange={(m) => setMode(main, m)} options={MODE_OPTIONS} size="md" />
            <button type="button" className="ctl h-[28px]" data-active={overlays} onClick={() => useUI.getState().toggleFeedOverlays()} aria-pressed={overlays}>
              <ScanEye size={13} /> Overlays
            </button>
            <button type="button" className="ctl h-[28px]" onClick={snapshot}>
              <Camera size={13} /> Snapshot
            </button>
          </>
        }
      >
        <MainFeed source={main} onDetections={onDetections} />
      </Panel>

      <aside className="row-span-2 flex min-h-0 flex-col gap-2">
        <Panel title="Sources" icon={Video} className="shrink-0">
          <div className="p-2">
            <SourceList main={main} />
          </div>
        </Panel>
        <Panel title="Camera control" icon={ScanLine} className="shrink-0">
          <div className="flex flex-col gap-3 p-3">
            <Ptz source={main} />
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11.5px] text-ink-2">
                <Thermometer size={13} /> Thermal
              </span>
              <Toggle checked={mode !== 'visible'} onChange={(v) => setMode(main, v ? 'thermal' : 'visible')} label="Thermal imaging" color="#e0574a" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11.5px] text-ink-2">Thermal palette</span>
              <Segmented
                label="Thermal palette"
                value={palette}
                onChange={(v) => useUI.getState().setSettings({ palette: v })}
                options={[
                  { value: 'ironbow', label: 'Ironbow' },
                  { value: 'whitehot', label: 'White-hot' },
                ]}
              />
            </div>
          </div>
        </Panel>
        <Panel title="Detections" icon={ScanEye} className="min-h-0 flex-1" subtitle="local synthetic analytics">
          <div className="absolute inset-0 overflow-y-auto p-2">
            {!overlays && <p className="px-1 text-[11px] text-ink-3">Object overlays are off.</p>}
            {overlays && dets.length === 0 && <p className="px-1 text-[11px] text-ink-3">No tracked objects in frame.</p>}
            {overlays &&
              dets.map((d) => {
                const Icon = KIND_ICON[d.kind];
                return (
                  <div key={d.id} className="flex items-center gap-2 border-b border-line px-1 py-[6px] last:border-b-0">
                    <Icon size={13} className="text-ink-2" aria-hidden />
                    <span className="text-[12px] text-ink-1">{d.label}</span>
                    {d.extra && <span className="mono text-[11px] text-orange">{d.extra}</span>}
                    <span className="num ml-auto text-[11.5px] text-ink-2">{Math.round(d.confidence * 100)}%</span>
                  </div>
                );
              })}
          </div>
        </Panel>
        {/* fixed cameras carry the taller PTZ control: the stream card yields to Detections on 900 px screens */}
        <Panel
          title="Stream"
          icon={Activity}
          className={cx('shrink-0', main === 'CAM-01' || main === 'CAM-02' ? '[@media(max-height:1000px)]:hidden' : '[@media(max-height:820px)]:hidden')}
          subtitle={main}
        >
          <StreamInfo source={main} />
        </Panel>
        <Panel title="Playback" icon={Rewind} className="shrink-0">
          <div className="flex gap-1.5 p-2.5">
            <button type="button" className="ctl h-[26px] flex-1" onClick={() => jump(60)}>
              −60 s
            </button>
            <button type="button" className="ctl h-[26px] flex-1" onClick={() => jump(30)}>
              −30 s
            </button>
            <button type="button" className="ctl h-[26px] flex-1" onClick={() => jump(10)}>
              −10 s
            </button>
            <button type="button" className="ctl h-[26px] flex-1" onClick={() => useUI.getState().goLive()}>
              <Radio size={12} /> Live
            </button>
          </div>
        </Panel>
      </aside>

      <div className="grid min-h-0 grid-cols-3 gap-2">
        {others.map((s) => (
          <FeedTile key={s} source={s} viewId={`feeds-thumb-${s}`} />
        ))}
      </div>
    </div>
  );
}
