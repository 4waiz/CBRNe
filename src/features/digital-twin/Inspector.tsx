import type { ReactNode } from 'react';
import { MousePointer2, Crosshair, Cctv, Undo2, Navigation, BrainCircuit, Siren, Play, BatteryMedium, Signal, Gauge, X, MapPin } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useSim } from '../../store/sim';
import { useUI } from '../../store/ui';
import { SENSORS, SENSOR_BY_ID, SENSOR_KIND_LABEL } from '../../simulation/sensors';
import { engine } from '../../simulation/engine';
import { history } from '../../simulation/history';
import { zoneById, zoneAt } from '../../data/site';
import { TEAM_MEMBERS } from '../../simulation/assets';
import { focusOn } from '../../three/CameraRig';
import { Chip, ProgressBar, Sparkline, StatusDot, cx } from '../../components/ui/primitives';
import { SENSOR_STATUS_LABEL, SENSOR_STATUS_TONE, TONE_HEX, SEVERITY_TONE } from '../../components/ui/tone';
import { SENSOR_COLOR, SENSOR_ICON, ASSET_ICON } from '../../components/twin/TwinMarkers';
import { fmtClock, fmtDuration, fmtNum, fmtSigned, fmtDistance } from '../../utils/format';
import type { AssetId, SensorStatus } from '../../types';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-[5px] last:border-b-0">
      <span className="text-[11px] text-ink-3">{label}</span>
      <span className="min-w-0 truncate text-right text-[11.5px] text-ink-1">{children}</span>
    </div>
  );
}

function Action({ icon: Icon, label, onClick, disabled }: { icon: typeof Crosshair; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="ctl h-[26px] flex-1" onClick={onClick} disabled={disabled}>
      <Icon size={13} /> {label}
    </button>
  );
}

function statusAt(id: string, v: number | null): SensorStatus {
  const d = SENSOR_BY_ID[id];
  if (v === null) return 'offline';
  if (d.kind === 'met') return 'online';
  return v >= d.alertAt ? 'alert' : v >= d.reviewAt ? 'elevated' : 'online';
}

function SensorView({ id }: { id: string }) {
  const def = SENSOR_BY_ID[id];
  const st = useSim((s) => s.sensors[id]);
  useSim((s) => s.historyVersion);
  const incidents = useSim(useShallow((s) => s.incidents.filter((i) => i.sensors.includes(id))));
  const obs = useSim((s) => s.observations.find((o) => o.sources.includes(id) && o.status !== 'cleared'));
  const pb = useUI((s) => s.playback);
  const replay = pb.mode === 'replay';
  const value = replay ? engine.sensorValueAt(id, pb.cursor) : (st?.value ?? null);
  const status = replay ? statusAt(id, value) : (st?.status ?? 'online');
  const tone = SENSOR_STATUS_TONE[status];
  const series = history.get(`sensor:${id}`);
  const data = series ? series.tail(900).filter((_, i) => i % 4 === 0) : [];
  const dec = def.kind === 'rad' ? 3 : def.kind === 'chem' ? 2 : def.kind === 'met' ? 1 : 0;
  const Icon = SENSOR_ICON[def.kind];
  return (
    <>
      <div className="flex items-center gap-2.5">
        <span className="flex h-[32px] w-[32px] items-center justify-center rounded-[7px]" style={{ background: `${SENSOR_COLOR[def.kind]}1f`, boxShadow: `inset 0 0 0 1px ${SENSOR_COLOR[def.kind]}44` }}>
          <Icon size={16} style={{ color: SENSOR_COLOR[def.kind] }} aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="mono text-[14px] font-medium text-ink-1">{id}</div>
          <div className="line-clamp-2 text-[11px] leading-[15px] text-ink-3">
            {SENSOR_KIND_LABEL[def.kind]} · {def.name}
          </div>
        </div>
        <Chip tone={tone} className="ml-auto">
          {status === 'online' ? 'Nominal' : status === 'offline' ? 'No data' : status}
        </Chip>
      </div>
      <div className="mt-3 flex items-end justify-between">
        <div>
          <div className="micro">{replay ? `Reading at ${fmtClock(pb.cursor)}` : 'Current reading'}</div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="num text-[28px] font-semibold leading-none text-ink-1">{fmtNum(value, dec)}</span>
            <span className="text-[12px] text-ink-3">{def.unit}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="micro">5-min trend</div>
          <div className="num mt-0.5 text-[14px] font-medium text-ink-1">{st && !replay ? `${fmtSigned(st.trend, 1)}%` : '—'}</div>
        </div>
      </div>
      <div className="mt-2.5 rounded-[6px] border border-line bg-bg-1/60 px-2 pb-1 pt-1.5">
        <div className="flex items-center justify-between text-[10px] text-ink-3">
          <span className="font-cond uppercase tracking-[0.1em]">15-minute trend</span>
          {def.kind !== 'met' && (
            <span>
              review <span className="num text-ink-2">{def.reviewAt}</span> · alert <span className="num text-ink-2">{def.alertAt}</span>
            </span>
          )}
        </div>
        <Sparkline data={data} color={SENSOR_COLOR[def.kind]} height={58} threshold={def.kind === 'met' ? undefined : def.reviewAt} strokeWidth={1.6} />
        <div className="mono flex justify-between text-[9.5px] text-ink-3">
          <span>−15 min</span>
          <span>now</span>
        </div>
      </div>
      <div className="mt-2">
        <Row label="Status">
          <span style={{ color: TONE_HEX[tone] }}>{SENSOR_STATUS_LABEL[status]}</span>
        </Row>
        <Row label="Last update">
          <span className="mono">{st ? fmtClock(st.updatedAt) : '—'}</span>
        </Row>
        <Row label="Data confidence">{st ? `${Math.round(st.quality * 100)}%` : '—'}</Row>
        <Row label="Zone">{zoneById(def.zoneId)?.label ?? def.zoneId}</Row>
        <Row label="Model">{def.model}</Row>
        <Row label="Related incidents">
          {incidents.length ? (
            incidents.map((i) => (
              <button
                key={i.id}
                type="button"
                className="mono ml-1 text-cyan hover:underline"
                onClick={() => {
                  useUI.getState().selectIncident(i.id);
                  useUI.getState().setScreen('incidents');
                }}
              >
                {i.id}
              </button>
            ))
          ) : (
            <span className="text-ink-3">None</span>
          )}
        </Row>
      </div>
      <div className="mt-3 flex gap-1.5">
        <Action icon={Crosshair} label="Focus" onClick={() => focusOn({ kind: 'sensor', id })} />
        <Action
          icon={Play}
          label="Replay 5 min"
          onClick={() => useUI.getState().setPlayback({ mode: 'replay', cursor: Date.now() - 5 * 60_000, playing: true })}
        />
        {obs && (
          <Action
            icon={BrainCircuit}
            label="Insight"
            onClick={() => {
              useUI.getState().selectObservation(obs.id);
              useUI.getState().setScreen('insights');
            }}
          />
        )}
      </div>
    </>
  );
}

function AssetView({ id }: { id: AssetId }) {
  const a = useSim((s) => s.assets[id]);
  const active = useSim((s) => s.incidents.find((i) => i.status !== 'resolved'));
  const follow = useUI((s) => s.follow);
  if (!a) return null;
  const Icon = ASSET_ICON[id];
  const openFeed = (src: 'UGV-01' | 'UAV-01' | 'CAM-02') => {
    const ui = useUI.getState();
    ui.setFeedMain(src);
    ui.setScreen('feeds');
  };
  const payload =
    id === 'UGV-01' ? 'PTZ visible · LWIR thermal · dosimeter · PID gas' : id === 'UAV-01' ? 'EO/IR gimbal · 30× zoom' : id === 'RV-02' ? 'Crew 4 · decon kit · SCBA' : 'Survey instruments';
  return (
    <>
      <div className="flex items-center gap-2.5">
        <span className="flex h-[32px] w-[32px] items-center justify-center rounded-[7px] bg-[rgb(76_148_255/0.14)]">
          <Icon size={17} className="text-blue" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="mono text-[14px] font-medium text-ink-1">{a.name}</div>
          <div className="truncate text-[11px] text-ink-3">{a.task}</div>
        </div>
        <span className="ml-auto flex items-center gap-1.5 text-[11.5px]" style={{ color: TONE_HEX[a.tone] }}>
          <StatusDot tone={a.tone} pulse={a.status === 'En route'} /> {a.status}
        </span>
      </div>
      {a.battery !== null && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-[6px] border border-line bg-surface-2/60 p-2">
            <div className="flex items-center gap-1 text-[10px] text-ink-3">
              <BatteryMedium size={11} /> Battery
            </div>
            <div className="num mt-0.5 text-[15px] font-semibold text-ink-1">{Math.round(a.battery)}%</div>
            <ProgressBar value={a.battery / 100} color={a.battery < 30 ? TONE_HEX.watch : TONE_HEX.ok} height={3} className="mt-1" />
          </div>
          <div className="rounded-[6px] border border-line bg-surface-2/60 p-2">
            <div className="flex items-center gap-1 text-[10px] text-ink-3">
              <Signal size={11} /> Link
            </div>
            <div className="num mt-0.5 text-[15px] font-semibold text-ink-1">{Math.round(a.signal)}%</div>
            <ProgressBar value={a.signal / 100} color={TONE_HEX.info} height={3} className="mt-1" />
          </div>
          <div className="rounded-[6px] border border-line bg-surface-2/60 p-2">
            <div className="flex items-center gap-1 text-[10px] text-ink-3">
              <Gauge size={11} /> Speed
            </div>
            <div className="num mt-0.5 text-[15px] font-semibold text-ink-1">
              {Math.round(a.speed * 3.6)} <span className="text-[10px] text-ink-3">km/h</span>
            </div>
          </div>
        </div>
      )}
      <div className="mt-2">
        <Row label="Area">{a.area}</Row>
        {a.eta !== null && <Row label="ETA">{fmtDuration(a.eta)}</Row>}
        {a.distance !== null && <Row label="Remaining">{fmtDistance(a.distance)}</Row>}
        {a.headcount && (
          <Row label="Headcount">
            {a.headcount.present} / {a.headcount.total} accounted
          </Row>
        )}
        <Row label="Payload">{payload}</Row>
        {id === 'TEAM-1' && TEAM_MEMBERS.map((m) => <Row key={m.id} label={m.id}>{m.role}</Row>)}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        <Action
          icon={Navigation}
          label={follow === id ? 'Following' : 'Follow'}
          onClick={() => {
            focusOn({ kind: 'asset', id });
          }}
        />
        {(id === 'UGV-01' || id === 'UAV-01') && <Action icon={Cctv} label="Open feed" onClick={() => openFeed(id)} />}
        {id === 'RV-02' && <Action icon={Cctv} label="CAM-02" onClick={() => openFeed('CAM-02')} />}
        {active && id !== 'RV-02' && !active.assigned.includes(id) && (
          <Action icon={Siren} label={`Assign ${active.id.slice(-2)}`} onClick={() => engine.assign(active.id, id)} />
        )}
        {(id === 'UGV-01' || id === 'UAV-01' || id === 'TEAM-1') && (
          <Action icon={Undo2} label={id === 'UAV-01' ? 'Resume route' : id === 'TEAM-1' ? 'Release' : 'Return'} onClick={() => engine.recall(id)} />
        )}
      </div>
    </>
  );
}

function ZoneView({ id }: { id: string }) {
  const z = zoneById(id);
  const sensors = useSim((s) => s.sensors);
  const assets = useSim((s) => s.assets);
  const incidents = useSim(useShallow((s) => s.incidents.filter((i) => i.status !== 'resolved')));
  if (!z) return null;
  const inside = (x: number, zz: number) => x >= z.minX && x <= z.maxX && zz >= z.minZ && zz <= z.maxZ;
  const zs = SENSORS.filter((s) => inside(s.x, s.z));
  const za = Object.values(assets).filter((a) => inside(a.x, a.z));
  const zi = incidents.filter((i) => inside(i.location.x, i.location.z));
  return (
    <>
      <div className="flex items-center gap-2.5">
        <span className="flex h-[32px] w-[32px] items-center justify-center rounded-[7px]" style={{ background: `${z.color}22` }}>
          <MapPin size={16} style={{ color: z.color }} aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink-1">{z.label}</div>
          <div className="text-[11px] text-ink-3">{z.sector} · generalized sector</div>
        </div>
      </div>
      <div className="mt-3">
        <div className="micro mb-1">Sensors in zone ({zs.length})</div>
        <div className="flex flex-col">
          {zs.length === 0 && <span className="text-[11px] text-ink-3">No primary sensor nodes in this zone.</span>}
          {zs.map((s) => {
            const st = sensors[s.id];
            const tone = SENSOR_STATUS_TONE[st?.status ?? 'online'];
            return (
              <button key={s.id} type="button" className="flex items-center gap-2 rounded-[4px] px-1.5 py-[4px] text-left hover:bg-surface-3" onClick={() => useUI.getState().select({ kind: 'sensor', id: s.id })}>
                <StatusDot tone={tone} size={6} />
                <span className="mono text-[11px] text-ink-1">{s.id}</span>
                <span className="num ml-auto text-[11px] text-ink-2">
                  {fmtNum(st?.value ?? null, s.kind === 'rad' ? 3 : s.kind === 'chem' ? 2 : 0)} {s.unit}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-2">
        <Row label="Assets present">{za.length ? za.map((a) => a.name).join(', ') : 'None'}</Row>
        <Row label="Active incidents">{zi.length ? zi.map((i) => i.id).join(', ') : 'None'}</Row>
      </div>
      <div className="mt-3 flex gap-1.5">
        <Action icon={Crosshair} label="Focus zone" onClick={() => focusOn({ kind: 'zone', id })} />
        <Action icon={Navigation} label="Task UGV" onClick={() => engine.taskAsset('UGV-01', (z.minX + z.maxX) / 2, (z.minZ + z.maxZ) / 2, z.short)} />
      </div>
    </>
  );
}

function LocationView({ x, z, label }: { x: number; z: number; label: string }) {
  const incidents = useSim(useShallow((s) => s.incidents.filter((i) => Math.hypot(i.location.x - x, i.location.z - z) < 30)));
  return (
    <>
      <div className="flex items-center gap-2.5">
        <span className="flex h-[32px] w-[32px] items-center justify-center rounded-[7px] bg-[rgb(255_138_61/0.14)]">
          <MapPin size={16} className="text-orange" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink-1">{label}</div>
          <div className="text-[11px] text-ink-3">{zoneAt(x, z)?.label ?? 'Site'}</div>
        </div>
      </div>
      <div className="mt-3">
        {incidents.map((i) => (
          <button
            key={i.id}
            type="button"
            onClick={() => {
              useUI.getState().selectIncident(i.id);
              useUI.getState().setScreen('incidents');
            }}
            className="mb-1 flex w-full items-center gap-2 rounded-[5px] border border-line px-2 py-1.5 text-left hover:bg-surface-3"
          >
            <StatusDot tone={SEVERITY_TONE[i.severity]} />
            <span className="mono text-[11px] text-ink-1">{i.id}</span>
            <span className="truncate text-[11px] text-ink-3">{i.title}</span>
          </button>
        ))}
        {!incidents.length && <span className="text-[11px] text-ink-3">No incidents recorded at this location.</span>}
      </div>
      <div className="mt-3 flex gap-1.5">
        <Action icon={Crosshair} label="Focus" onClick={() => focusOn({ kind: 'location', x, z, radius: 120 })} />
        <Action icon={Navigation} label="Task UGV" onClick={() => engine.taskAsset('UGV-01', x, z, label)} />
      </div>
    </>
  );
}

export function Inspector({ className, width }: { className?: string; width?: number }) {
  const sel = useUI((s) => s.selection);
  const flagged = useSim(useShallow((s) => Object.values(s.sensors).filter((x) => x.status === 'elevated' || x.status === 'alert')));
  return (
    <aside data-twin-obstacle className={cx('panel flex flex-col shadow-[0_16px_40px_rgb(0_0_0/0.45)]', className)} style={width ? { width } : undefined} aria-label="Inspector">
      <header className="panel-header">
        <MousePointer2 size={14} className="text-ink-2" aria-hidden />
        <h2 className="panel-title">Inspector</h2>
        {sel && (
          <button type="button" className="ml-auto text-ink-3 hover:text-ink-1" onClick={() => useUI.getState().select(null)} aria-label="Clear selection">
            <X size={14} />
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!sel && (
          <div>
            <p className="text-[11.5px] leading-[16px] text-ink-2">Select a sensor marker, vehicle or zone in the twin to inspect it. Double-click to fly the camera to it.</p>
            {flagged.length > 0 && (
              <div className="mt-3">
                <div className="micro mb-1">Flagged sensors</div>
                {flagged.map((f) => (
                  <button key={f.id} type="button" className="flex w-full items-center gap-2 rounded-[4px] px-1.5 py-[5px] text-left hover:bg-surface-3" onClick={() => useUI.getState().select({ kind: 'sensor', id: f.id })}>
                    <StatusDot tone={SENSOR_STATUS_TONE[f.status]} size={6} pulse />
                    <span className="mono text-[11px] text-ink-1">{f.id}</span>
                    <span className="ml-auto text-[11px] text-ink-3">{SENSOR_STATUS_LABEL[f.status]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {sel?.kind === 'sensor' && <SensorView id={sel.id} />}
        {sel?.kind === 'asset' && <AssetView id={sel.id} />}
        {sel?.kind === 'zone' && <ZoneView id={sel.id} />}
        {sel?.kind === 'location' && <LocationView x={sel.x} z={sel.z} label={sel.label} />}
      </div>
    </aside>
  );
}
