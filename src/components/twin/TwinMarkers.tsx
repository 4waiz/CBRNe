import { memo, useEffect, useRef } from 'react';
import { Radiation, FlaskConical, Biohazard, Wind, Bot, Drone, Users, Truck, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SENSORS, SENSOR_BY_ID } from '../../simulation/sensors';
import { SITE, ZONES } from '../../data/site';
import { useSim } from '../../store/sim';
import { useUI } from '../../store/ui';
import { frameBus } from '../../three/frameBus';
import { assetVisual } from '../../three/AssetLayer';
import { RESPONSE_VEHICLE_POSE } from '../../simulation/assets';
import { focusOn } from '../../three/CameraRig';
import { project, placeEl, type Projected } from './project';
import { SENSOR_STATUS_LABEL, SENSOR_STATUS_TONE, TONE_HEX, CATEGORY_HEX, SEVERITY_TONE } from '../ui/tone';
import { cx } from '../ui/primitives';
import { fmtNum } from '../../utils/format';
import type { AssetId, SensorKind } from '../../types';
import { SensorCallout } from './SensorCallout';

export const SENSOR_ICON: Record<SensorKind, LucideIcon> = { rad: Radiation, chem: FlaskConical, bio: Biohazard, met: Wind };
export const SENSOR_COLOR: Record<SensorKind, string> = { rad: CATEGORY_HEX.rad, chem: CATEGORY_HEX.chem, bio: CATEGORY_HEX.bio, met: '#c2ccd6' };
export const ASSET_ICON: Record<AssetId, LucideIcon> = { 'UGV-01': Bot, 'UAV-01': Drone, 'TEAM-1': Users, 'RV-02': Truck };

const SensorMarker = memo(function SensorMarker({ id, setRef }: { id: string; setRef: (el: HTMLElement | null) => void }) {
  const def = SENSOR_BY_ID[id];
  const state = useSim((s) => s.sensors[id]);
  const selected = useUI((s) => s.selection?.kind === 'sensor' && s.selection.id === id);
  const hovered = useUI((s) => s.hovered?.kind === 'sensor' && s.hovered.id === id);
  const status = state?.status ?? 'online';
  const tone = SENSOR_STATUS_TONE[status];
  const ring = status === 'online' ? 'rgb(148 163 184 / 0.55)' : TONE_HEX[tone];
  const Icon = SENSOR_ICON[def.kind];
  const flagged = status === 'elevated' || status === 'alert';
  const offline = status === 'offline';
  return (
    <div ref={setRef} className={cx('pointer-events-none absolute left-0 top-0 will-change-transform', selected ? 'z-20' : flagged && 'z-10')} style={{ visibility: 'hidden' }}>
      <div className="relative -translate-x-1/2 -translate-y-full">
        <button
          type="button"
          className="group pointer-events-auto relative flex flex-col items-center outline-none"
          onClick={() => useUI.getState().select({ kind: 'sensor', id })}
          onDoubleClick={() => focusOn({ kind: 'sensor', id })}
          onMouseEnter={() => useUI.getState().setHovered({ kind: 'sensor', id })}
          onMouseLeave={() => useUI.getState().setHovered(null)}
          aria-label={`${id} ${def.name}: ${SENSOR_STATUS_LABEL[status]}`}
        >
          <span
            className={cx(
              'relative flex h-[22px] w-[22px] items-center justify-center rounded-full transition-transform duration-150',
              (hovered || selected) && 'scale-[1.18]',
              'group-focus-visible:ring-2 group-focus-visible:ring-cyan',
            )}
            style={{
              background: 'rgb(14 19 25 / 0.88)',
              // selected: a cyan ring separated by a dark gap reads on white roofs and open sea alike
              boxShadow: selected
                ? `0 0 0 1.5px ${ring}, 0 0 0 3.5px rgb(10 14 19 / 0.92), 0 0 0 5.5px var(--color-cyan), 0 2px 10px rgb(0 0 0 / 0.5)`
                : `0 0 0 1.5px ${ring}, 0 2px 8px rgb(0 0 0 / 0.45)`,
            }}
          >
            {flagged && <span className="absolute inset-0 rounded-full animate-pulse-ring" style={{ background: TONE_HEX[tone] }} />}
            <Icon size={12} strokeWidth={2.1} style={{ color: offline ? TONE_HEX.offline : SENSOR_COLOR[def.kind] }} aria-hidden />
            {flagged && (
              <span className="absolute -right-1 -top-1 flex h-[11px] w-[11px] items-center justify-center rounded-full" style={{ background: TONE_HEX[tone] }}>
                <span className="text-[8px] font-bold leading-none text-bg-0">!</span>
              </span>
            )}
            {offline && <span className="absolute h-[1.5px] w-[16px] rotate-45 rounded-full bg-ink-3" />}
          </span>
          <span className="h-[9px] w-px" style={{ background: ring }} />
          {(selected || flagged) && !hovered && (
            <span
              className={cx(
                'pointer-events-none absolute left-[calc(50%+16px)] top-[3px] whitespace-nowrap rounded-[3px] px-1 mono text-[9.5px] leading-[15px] shadow-[0_2px_6px_rgb(0_0_0/0.4)]',
                selected ? 'bg-cyan font-semibold text-bg-0' : 'border border-line-strong bg-surface-1/92 text-ink-1',
              )}
              aria-hidden
            >
              {id}
            </span>
          )}
          <span
            className={cx(
              'pointer-events-none absolute bottom-[34px] left-1/2 z-10 w-max -translate-x-1/2 rounded-[6px] border border-line-strong bg-surface-2/95 px-2.5 py-1.5 text-left shadow-[0_8px_24px_rgb(0_0_0/0.45)] transition-opacity duration-150',
              hovered && !selected ? 'opacity-100' : 'opacity-0',
            )}
          >
            <span className="flex items-center gap-2">
              <span className="mono text-[11px] font-medium text-ink-1">{id}</span>
              <span className="text-[10.5px] text-ink-3">{def.name}</span>
            </span>
            <span className="mt-0.5 flex items-baseline gap-1.5">
              <span className="num text-[13px] font-semibold" style={{ color: flagged ? TONE_HEX[tone] : 'var(--color-ink-1)' }}>
                {fmtNum(state?.value ?? null, def.kind === 'rad' ? 3 : def.kind === 'chem' ? 2 : def.kind === 'met' ? 1 : 0)}
              </span>
              <span className="text-[10.5px] text-ink-3">{def.unit}</span>
              <span className="ml-1 text-[10.5px]" style={{ color: TONE_HEX[tone] }}>
                {SENSOR_STATUS_LABEL[status]}
              </span>
            </span>
          </span>
        </button>
      </div>
    </div>
  );
});

const AssetMarker = memo(function AssetMarker({ id, setRef }: { id: AssetId; setRef: (el: HTMLElement | null) => void }) {
  const asset = useSim((s) => s.assets[id]);
  const selected = useUI((s) => s.selection?.kind === 'asset' && s.selection.id === id);
  const Icon = ASSET_ICON[id];
  const tone = asset?.tone ?? 'neutral';
  return (
    <div ref={setRef} className="pointer-events-none absolute left-0 top-0 will-change-transform" style={{ visibility: 'hidden' }}>
      <div className="relative -translate-x-1/2 -translate-y-full pb-[7px]">
        <button
          type="button"
          onClick={() => {
            useUI.getState().select({ kind: 'asset', id });
          }}
          onDoubleClick={() => focusOn({ kind: 'asset', id })}
          className={cx(
            'pointer-events-auto flex h-[22px] items-center gap-1.5 rounded-[5px] border pl-1.5 pr-2 text-[11px] font-medium text-ink-1 shadow-[0_4px_14px_rgb(0_0_0/0.4)] transition-colors',
            selected ? 'border-cyan/70 bg-surface-3' : 'border-line-strong bg-surface-1/92 hover:bg-surface-3',
          )}
          aria-label={`${asset?.name ?? id}: ${asset?.status ?? ''}`}
        >
          <Icon size={13} strokeWidth={2} className="text-blue" aria-hidden />
          <span className="mono text-[11px]">{asset?.name ?? id}</span>
          <span className="h-[5px] w-[5px] rounded-full" style={{ background: TONE_HEX[tone] }} aria-hidden />
          <span className="text-[10.5px] text-ink-3">{asset?.status}</span>
        </button>
        <span className="absolute bottom-0 left-1/2 h-[7px] w-px -translate-x-1/2 bg-blue/70" aria-hidden />
      </div>
    </div>
  );
});

function UnitLabel({ label, setRef }: { label: string; setRef: (el: HTMLElement | null) => void }) {
  // above ordinary sensor icons (text stays readable), below flagged or selected sensors (z-10 / z-20)
  return (
    <div ref={setRef} className="pointer-events-none absolute left-0 top-0 z-[5] will-change-transform" style={{ visibility: 'hidden' }}>
      <div className="-translate-x-1/2 -translate-y-full rounded-[4px] border border-line-strong bg-surface-1/85 px-2 py-[3px] font-cond text-[11.5px] font-semibold tracking-[0.06em] text-ink-1 shadow-[0_4px_12px_rgb(0_0_0/0.35)]">
        {label}
      </div>
    </div>
  );
}

function ZoneLabel({ label, color, setRef }: { label: string; color: string; setRef: (el: HTMLElement | null) => void }) {
  return (
    <div ref={setRef} className="pointer-events-none absolute left-0 top-0 will-change-transform" style={{ visibility: 'hidden' }}>
      <div className="-translate-x-1/2 -translate-y-1/2 whitespace-nowrap font-cond text-[10.5px] font-semibold uppercase tracking-[0.14em]" style={{ color, textShadow: '0 1px 3px rgb(0 0 0 / 0.85)' }}>
        {label}
      </div>
    </div>
  );
}

function IncidentPin({ id, setRef }: { id: string; setRef: (el: HTMLElement | null) => void }) {
  const inc = useSim((s) => s.incidents.find((i) => i.id === id));
  if (!inc) return null;
  const c = TONE_HEX[SEVERITY_TONE[inc.severity]];
  return (
    <div ref={setRef} className="pointer-events-none absolute left-0 top-0 will-change-transform" style={{ visibility: 'hidden' }}>
      <button
        type="button"
        className="pointer-events-auto relative flex -translate-x-1/2 -translate-y-full flex-col items-center"
        onClick={() => {
          useUI.getState().selectIncident(inc.id);
          useUI.getState().select({ kind: 'location', x: inc.location.x, z: inc.location.z, label: inc.location.label });
        }}
        onDoubleClick={() => focusOn({ kind: 'location', x: inc.location.x, z: inc.location.z, radius: 120 })}
        aria-label={`Incident ${inc.id}: ${inc.title}`}
      >
        <span className="relative flex h-[26px] w-[26px] items-center justify-center rounded-full rounded-br-none rotate-45" style={{ background: c, boxShadow: `0 0 0 3px ${c}40, 0 6px 16px rgb(0 0 0 / 0.5)` }}>
          <TriangleAlert size={13} strokeWidth={2.4} className="-rotate-45 text-bg-0" aria-hidden />
        </span>
        <span className="mt-2 whitespace-nowrap rounded-[4px] bg-bg-0/80 px-1.5 py-[1px] mono text-[10px] text-ink-1">{inc.id}</span>
      </button>
    </div>
  );
}

type Box = { w: number; h: number };
type Rect = { l: number; t: number; r: number; b: number };

export function TwinMarkers({ compact }: { compact?: boolean }) {
  const layers = useUI((s) => s.layers);
  const labels = useUI((s) => s.settings.labels);
  const selection = useUI((s) => s.selection);
  const incidents = useSim((s) => s.incidents.filter((i) => i.status !== 'resolved').map((i) => i.id).join(','));
  const refs = useRef(new Map<string, HTMLElement | null>());
  const anchors = useRef(new Map<string, () => [number, number, number]>());
  const rootRef = useRef<HTMLDivElement>(null);
  const leaderRef = useRef<SVGGElement>(null);
  const setRef = (key: string, anchor: () => [number, number, number]) => (el: HTMLElement | null) => {
    refs.current.set(key, el);
    anchors.current.set(key, anchor);
  };

  useEffect(() => {
    // approximate label footprints (px) above their anchor, used for de-cluttering
    const box = (key: string): Box | null =>
      key.startsWith('incident:') ? { w: 92, h: 50 } : key.startsWith('asset:') ? { w: 150, h: 30 } : key.startsWith('unit:') ? { w: 62, h: 24 } : null;
    const rectOf = (x: number, y: number, b: Box): Rect => ({ l: x - b.w / 2, t: y - b.h, r: x + b.w / 2, b: y });
    const hits = (a: Rect, o: Rect) => a.l < o.r + 2 && a.r > o.l - 2 && a.t < o.b + 2 && a.b > o.t - 2;
    const pool = new Map<string, Projected>();
    const offsets = new Map<string, [number, number]>();
    const lines = new Map<string, SVGLineElement>();
    // HUD cards and docked panels drawn over the twin; labels never hide underneath them
    let hud: Rect[] = [];
    let hudAt = -Infinity;
    const readHud = () => {
      const root = rootRef.current;
      if (!root) return;
      const base = root.getBoundingClientRect();
      hud = [];
      for (const el of document.querySelectorAll<HTMLElement>('[data-twin-obstacle]')) {
        const r = el.getBoundingClientRect();
        if (r.width >= 2 && r.height >= 2) hud.push({ l: r.left - base.left, t: r.top - base.top, r: r.right - base.left, b: r.bottom - base.top });
      }
    };
    const leader = (key: string, from: [number, number] | null, to: [number, number] = [0, 0], color = '') => {
      let ln = lines.get(key);
      if (!from) {
        if (ln && ln.style.display !== 'none') ln.style.display = 'none';
        return;
      }
      if (!ln) {
        const g = leaderRef.current;
        if (!g) return;
        ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        ln.setAttribute('stroke-width', '1');
        g.appendChild(ln);
        lines.set(key, ln);
      }
      ln.style.display = '';
      ln.setAttribute('stroke', color);
      ln.setAttribute('x1', from[0].toFixed(1));
      ln.setAttribute('y1', from[1].toFixed(1));
      ln.setAttribute('x2', to[0].toFixed(1));
      ln.setAttribute('y2', to[1].toFixed(1));
    };
    return frameBus.onMain((f) => {
      const now = performance.now();
      if (now - hudAt > 400) {
        hudAt = now;
        readHud();
      }
      const W = f.rect.width;
      const items: { key: string; el: HTMLElement; p: Projected; s: number; x0: number; y0: number }[] = [];
      for (const [key, el] of refs.current) {
        if (!el) continue;
        const a = anchors.current.get(key);
        if (!a) continue;
        const [x, y, z] = a();
        let p = pool.get(key);
        if (!p) {
          p = { x: 0, y: 0, visible: false, distance: 0 };
          pool.set(key, p);
        }
        project(f.camera, f.rect, x, y, z, p);
        const isUnit = key.startsWith('unit:');
        const isZone = key.startsWith('zone:');
        if (isUnit && p.distance > 3200) p.visible = false;
        if (key === 'callout') {
          // docked card + leader line to the sensor marker (marker centre sits ~20 px above its anchor)
          if (el.style.visibility !== 'visible') el.style.visibility = 'visible';
          const line = el.querySelector<SVGLineElement>('[data-leader]');
          const dot = el.querySelector<SVGCircleElement>('[data-leader-dot]');
          const card = el.querySelector<HTMLElement>('[data-callout-card]');
          if (line && dot && card) {
            const bx = card.offsetLeft;
            const by = card.offsetTop + 22;
            const mx = p.x;
            const my = p.y - 20;
            const len = Math.hypot(bx - mx, by - my);
            const show = p.visible && len > 30 && !(mx > bx - 6 && my > card.offsetTop - 6 && my < card.offsetTop + card.offsetHeight + 6);
            line.style.display = dot.style.display = show ? '' : 'none';
            if (show) {
              const ex = mx + ((bx - mx) / len) * 14;
              const ey = my + ((by - my) / len) * 14;
              line.setAttribute('x1', bx.toFixed(1));
              line.setAttribute('y1', by.toFixed(1));
              line.setAttribute('x2', ex.toFixed(1));
              line.setAttribute('y2', ey.toFixed(1));
              dot.setAttribute('cx', ex.toFixed(1));
              dot.setAttribute('cy', ey.toFixed(1));
            }
          }
          continue;
        }
        items.push({ key, el, p, s: isUnit || isZone ? 1 : Math.max(0.74, Math.min(1, 1250 / p.distance)), x0: p.x, y0: p.y });
      }

      // De-clutter, greedy by priority: tagged sensors (selected or flagged: marker + ID tag) > incidents >
      // assets > unit labels. A label that would collide with a placed label, a HUD card or the viewport
      // edge moves to the nearest free spot (stacked above, beside or below what it hits) and keeps a
      // leader line to its anchor; with no free spot it is dropped (incident pins never are).
      const placed: Rect[] = [];
      const sel = useUI.getState().selection;
      const sim = useSim.getState();
      for (const it of items) {
        if (!it.key.startsWith('sensor:') || !it.p.visible) continue;
        const id = it.key.slice(7);
        const st = sim.sensors[id]?.status;
        const tagged = (sel?.kind === 'sensor' && sel.id === id) || st === 'elevated' || st === 'alert';
        // footprint: 22 px marker + stem above the anchor, ID tag to its right (centred box ≈ ±76 px)
        if (tagged) placed.push(rectOf(it.p.x, it.p.y, { w: 152, h: 36 }));
      }
      for (const prefix of ['incident:', 'asset:', 'unit:']) {
        for (const it of items) {
          if (!it.key.startsWith(prefix) || !it.p.visible) continue;
          const b = box(it.key);
          if (!b) continue;
          const { x0, y0 } = it;
          const free = (x: number, y: number) => {
            const r = rectOf(x, y, b);
            return r.l >= 2 && r.r <= W - 2 && r.t >= 2 && !placed.some((o) => hits(r, o)) && !hud.some((o) => hits(r, o));
          };
          if (!free(x0, y0)) {
            if (prefix === 'unit:') it.p.visible = false;
            else {
              let best: [number, number] | null = null;
              let cost = Infinity;
              const consider = (x: number, y: number, weight: number) => {
                const c = Math.hypot(x - x0, y - y0) * weight;
                if (c < cost && free(x, y)) {
                  cost = c;
                  best = [x, y];
                }
              };
              // last frame's spot first, so labels do not hop between equally good places
              const prev = offsets.get(it.key);
              if (prev) consider(x0 + prev[0], y0 + prev[1], 0.6);
              for (const o of [...placed, ...hud]) {
                consider(x0, o.t - 2, 1);
                consider(o.r + b.w / 2 + 4, y0, 1.25);
                consider(o.l - b.w / 2 - 4, y0, 1.25);
                consider(x0, o.b + b.h + 2, 1.6);
              }
              consider(x0, b.h + 2, 1.4); // pinned under the top edge
              const spot = best as [number, number] | null;
              if (spot) {
                it.p.x = spot[0];
                it.p.y = spot[1];
              } else if (prefix === 'asset:') it.p.visible = false;
            }
          }
          if (it.p.visible) placed.push(rectOf(it.p.x, it.p.y, b));
        }
      }

      for (const it of items) {
        placeEl(it.el, it.p, it.s);
        const kind = it.key.startsWith('incident:') ? 'incident' : it.key.startsWith('asset:') ? 'asset' : null;
        if (!kind) continue;
        const dx = it.p.x - it.x0;
        const dy = it.p.y - it.y0;
        const moved = it.p.visible && Math.hypot(dx, dy) > 3;
        if (moved) offsets.set(it.key, [dx, dy]);
        else offsets.delete(it.key);
        if (!moved) {
          leader(it.key, null);
          continue;
        }
        let color = 'rgb(76 148 255 / 0.75)';
        if (kind === 'incident') {
          const inc = sim.incidents.find((i) => i.id === it.key.slice(9));
          color = inc ? TONE_HEX[SEVERITY_TONE[inc.severity]] : '#f2b33d';
        }
        leader(it.key, [it.p.x, it.p.y], [it.x0, it.y0], color);
      }
    });
  }, []);

  const incidentIds = incidents ? incidents.split(',') : [];
  const showSensors = labels;
  const showAssets = layers.assets;

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 overflow-hidden" aria-label="Map markers">
      {/* leader lines from moved labels back to their anchors, under every marker */}
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <g ref={leaderRef} strokeOpacity={0.8} />
      </svg>
      {SITE.units.map((u) => (
        <UnitLabel key={u.id} label={u.label} setRef={setRef(`unit:${u.id}`, () => [u.x, 76, u.z])} />
      ))}
      {layers.zones &&
        ZONES.filter((z) => z.overlay).map((z) => (
          <ZoneLabel key={z.id} label={z.short} color={z.color} setRef={setRef(`zone:${z.id}`, () => [(z.minX + z.maxX) / 2, 2, (z.minZ + z.maxZ) / 2])} />
        ))}
      {showSensors &&
        SENSORS.map((s) => <SensorMarker key={s.id} id={s.id} setRef={setRef(`sensor:${s.id}`, () => [s.x, s.y, s.z])} />)}
      {showAssets && (
        <>
          <AssetMarker id="UGV-01" setRef={setRef('asset:UGV-01', () => [assetVisual.ugv.x, 3, assetVisual.ugv.z])} />
          <AssetMarker id="UAV-01" setRef={setRef('asset:UAV-01', () => [assetVisual.uav.x, assetVisual.uav.y + 6, assetVisual.uav.z])} />
          {!compact && <AssetMarker id="TEAM-1" setRef={setRef('asset:TEAM-1', () => [assetVisual.team[0].x, 3, assetVisual.team[0].z])} />}
          {!compact && <AssetMarker id="RV-02" setRef={setRef('asset:RV-02', () => [RESPONSE_VEHICLE_POSE.x, 5, RESPONSE_VEHICLE_POSE.z])} />}
        </>
      )}
      {incidentIds.map((id) => (
        <IncidentPin
          key={id}
          id={id}
          setRef={setRef(`incident:${id}`, () => {
            const inc = useSim.getState().incidents.find((i) => i.id === id);
            return inc ? [inc.location.x, 34, inc.location.z] : [0, -9999, 0];
          })}
        />
      ))}
      {compact && selection?.kind === 'sensor' && (
        <SensorCallout id={selection.id} setRef={setRef('callout', () => {
          const s = SENSOR_BY_ID[selection.id];
          return s ? [s.x, s.y, s.z] : [0, -9999, 0];
        })} />
      )}
    </div>
  );
}
