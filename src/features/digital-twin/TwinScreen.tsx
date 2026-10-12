import { Layers, Siren, Wind, CircleCheck, Crosshair, ArrowUpRight, SlidersHorizontal, PanelLeftClose, PanelLeftOpen, Minimize2 } from 'lucide-react';
import { useState } from 'react';
import { useSim } from '../../store/sim';
import { useUI } from '../../store/ui';
import { engine } from '../../simulation/engine';
import { TwinViewport } from '../../components/twin/TwinViewport';
import { TwinHud, LAYER_DEFS } from '../../components/twin/TwinHud';
import { Inspector } from './Inspector';
import { Timeline } from './Timeline';
import { focusOn } from '../../three/CameraRig';
import { Chip, Toggle, cx, useNow } from '../../components/ui/primitives';
import { SEVERITY_LABEL, SEVERITY_TONE, TONE_HEX, INCIDENT_CATEGORY_LABEL } from '../../components/ui/tone';
import { compassLabel } from '../../utils/math';
import { fmtDuration } from '../../utils/format';
import type { ChecklistItem } from '../../types';

const LAYER_DESC: Record<string, string> = {
  radiation: 'Gamma dose-rate field + contours',
  chemical: 'Wind-driven VOC plume model',
  biological: 'Aerosol screening volume',
  assets: 'Vehicle tags, routes, tasking',
  weather: 'Wind field and met mast vane',
  zones: 'Generalized operational sectors',
};

function Section({ icon: Icon, title, children, right }: { icon: typeof Layers; title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border-b border-line px-3 py-2.5 last:border-b-0">
      <div className="mb-2 flex items-center gap-2">
        <Icon size={13} className="text-ink-2" aria-hidden />
        <h3 className="panel-title text-[11.5px]">{title}</h3>
        <div className="ml-auto">{right}</div>
      </div>
      {children}
    </section>
  );
}

/** Fire response phases, in order (checklist ids). */
const RESPONSE_PHASES: [string, string][] = [
  ['detect', 'Detect'],
  ['protect', 'Protect'],
  ['dispatch', 'Deploy'],
  ['suppress', 'Suppress'],
  ['decon', 'Decon'],
  ['recover', 'Recover'],
];

/** Six-step bar for the fire response: done steps green, the step under way amber. */
function PhaseStepper({ checklist }: { checklist: ChecklistItem[] }) {
  const done = RESPONSE_PHASES.map(([id]) => !!checklist.find((c) => c.id === id)?.done);
  const current = done.indexOf(false);
  return (
    <div className="mt-2">
      <ol className="flex gap-[3px]" aria-label="Response phases">
        {RESPONSE_PHASES.map(([id, name], k) => (
          <li
            key={id}
            title={name}
            aria-label={`${name}: ${done[k] ? 'done' : k === current ? 'under way' : 'pending'}`}
            className={cx('h-[4px] flex-1 rounded-full', done[k] ? 'bg-green' : k === current ? 'animate-pulse bg-amber' : 'bg-line-strong')}
          />
        ))}
      </ol>
      <div className="mt-1 flex items-baseline justify-between gap-2 text-[10.5px]">
        <span className="truncate text-ink-3">
          {current === -1 ? (
            'All phases complete'
          ) : (
            <>
              Phase <span className="text-ink-1">{RESPONSE_PHASES[current][1]}</span>
            </>
          )}
        </span>
        <span className="mono shrink-0 text-ink-3">
          {done.filter(Boolean).length}/{RESPONSE_PHASES.length}
        </span>
      </div>
    </div>
  );
}

function IncidentStatus() {
  const now = useNow(1000);
  const incidents = useSim((s) => s.incidents);
  const active = incidents.filter((i) => i.status !== 'resolved');
  if (!active.length)
    return (
      <div className="flex items-center gap-2 text-[11.5px] text-ink-2">
        <CircleCheck size={14} className="text-green" aria-hidden /> No active incidents
      </div>
    );
  return (
    <div className="flex flex-col gap-1.5">
      {active.slice(0, 2).map((i) => {
        const tone = SEVERITY_TONE[i.severity];
        return (
          <div key={i.id} className="rounded-[6px] border px-2.5 py-2" style={{ borderColor: `${TONE_HEX[tone]}50`, background: `${TONE_HEX[tone]}0c` }}>
            <div className="flex items-center gap-2">
              <span className="mono text-[11px] text-ink-1">{i.id}</span>
              <Chip tone={tone}>{SEVERITY_LABEL[i.severity]}</Chip>
              <span className="mono ml-auto text-[10.5px] text-ink-3">{fmtDuration((now - i.createdAt) / 1000)}</span>
            </div>
            <div className="mt-1 text-[12px] font-medium leading-[15px] text-ink-1">{i.title}</div>
            <div className="mt-0.5 text-[10.5px] text-ink-3">
              {INCIDENT_CATEGORY_LABEL[i.category]} · {i.status === 'new' ? 'Awaiting acknowledgement' : i.status === 'acknowledged' ? 'Acknowledged' : 'Investigating'}
            </div>
            {i.category === 'fire' && <PhaseStepper checklist={i.checklist} />}
            {/* the primary action gets its own full-width row: three buttons never fit this card's width */}
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {i.status === 'new' && (
                <button type="button" className="ctl col-span-2 h-[24px] border-amber/50 text-amber" onClick={() => engine.acknowledge(i.id)}>
                  Acknowledge
                </button>
              )}
              <button type="button" className="ctl h-[24px]" onClick={() => focusOn({ kind: 'location', x: i.location.x, z: i.location.z, radius: 120 })}>
                <Crosshair size={12} /> Focus
              </button>
              <button
                type="button"
                className="ctl h-[24px]"
                onClick={() => {
                  useUI.getState().selectIncident(i.id);
                  useUI.getState().setScreen('incidents');
                }}
              >
                Open <ArrowUpRight size={12} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Environment() {
  const w = useSim((s) => s.weather);
  const rows: [string, string][] = [
    ['Wind', `${compassLabel(w.windDir)} ${Math.round(w.windDir)}° · ${w.windSpeed.toFixed(1)} km/h`],
    ['Gusts', `${w.gust.toFixed(1)} km/h`],
    ['Temperature', `${w.temperature.toFixed(1)} °C`],
    ['Humidity', `${Math.round(w.humidity)} %`],
    ['Pressure', `${w.pressure.toFixed(1)} hPa`],
    ['Visibility', `${w.visibility.toFixed(1)} km`],
    ['Stability class', w.stability],
  ];
  return (
    <div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between py-[3px]">
          <span className="text-[11px] text-ink-3">{k}</span>
          <span className="num text-[11.5px] text-ink-1">{v}</span>
        </div>
      ))}
    </div>
  );
}

function LeftPanel({ className, width }: { className?: string; width: number }) {
  const layers = useUI((s) => s.layers);
  const setLayer = useUI((s) => s.setLayer);
  return (
    <aside data-twin-obstacle className={cx('panel overflow-y-auto shadow-[0_16px_40px_rgb(0_0_0/0.45)]', className)} style={{ width }} aria-label="Twin controls">
      <Section icon={Layers} title="Layers">
        <div className="flex flex-col gap-1">
          {LAYER_DEFS.map((l) => {
            const Icon = l.icon;
            return (
              <label key={l.id} className="flex cursor-pointer items-center gap-2.5 rounded-[5px] px-1.5 py-[5px] hover:bg-surface-2">
                <Icon size={14} style={{ color: layers[l.id] ? l.color : 'var(--color-ink-4)' }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] text-ink-1">{l.label}</span>
                  <span className="block truncate text-[10.5px] text-ink-3">{LAYER_DESC[l.id]}</span>
                </span>
                <Toggle checked={layers[l.id]} onChange={(v) => setLayer(l.id, v)} label={`${l.label} layer`} color={l.color} />
              </label>
            );
          })}
        </div>
      </Section>
      <Section icon={Siren} title="Incident status">
        <IncidentStatus />
      </Section>
      <Section
        icon={Wind}
        title="Environment"
        right={
          <button type="button" className="ctl h-[20px] px-1.5" onClick={() => useUI.getState().openSettings('scenario')} title="Adjust synthetic wind in Scenario Control">
            <SlidersHorizontal size={11} />
          </button>
        }
      >
        <Environment />
      </Section>
    </aside>
  );
}

export function TwinScreen() {
  const immersive = useUI((s) => s.twinImmersive);
  const [leftOpen, setLeftOpen] = useState(true);
  const leftW = 276;
  const rightW = 330;
  return (
    <div className="absolute inset-0 flex flex-col gap-2 p-2">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-[8px] border border-line">
        <TwinViewport
          hud={<TwinHud leftInset={leftOpen ? leftW + 22 : 52} rightInset={rightW + 22} />}
        />
        {leftOpen ? (
          <LeftPanel width={leftW} className="absolute bottom-3 left-3 top-3 z-20" />
        ) : null}
        <div data-twin-obstacle className="absolute left-3 top-3 z-30" style={{ left: leftOpen ? leftW - 18 : 12 }}>
          <button
            type="button"
            className="ctl ctl-icon h-[24px] w-[24px] bg-surface-1/90"
            onClick={() => setLeftOpen(!leftOpen)}
            aria-label={leftOpen ? 'Collapse controls panel' : 'Expand controls panel'}
            title={leftOpen ? 'Collapse panel' : 'Expand panel'}
          >
            {leftOpen ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
          </button>
        </div>
        <Inspector width={rightW} className="absolute right-3 top-3 z-20 max-h-[calc(100%-24px)]" />
        {immersive && (
          <button
            type="button"
            data-twin-obstacle
            className="ctl absolute bottom-3 left-1/2 z-30 -translate-x-1/2 bg-surface-1/90"
            onClick={() => {
              useUI.getState().setTwinImmersive(false);
              if (document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
            }}
          >
            <Minimize2 size={12} /> Exit fullscreen
          </button>
        )}
      </div>
      <div className="panel h-[104px] shrink-0">
        <Timeline />
      </div>
    </div>
  );
}
