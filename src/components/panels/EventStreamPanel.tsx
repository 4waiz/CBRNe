import { useMemo, useState, type ReactNode } from 'react';
import { ListChecks, Radiation, FlaskConical, Biohazard, Flame, Bot, Cpu, BrainCircuit, ChevronRight, ChevronDown, Crosshair, Siren, Inbox } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useSim } from '../../store/sim';
import { useUI, type EventFilter } from '../../store/ui';
import { focusOn } from '../../three/CameraRig';
import { Panel, Segmented, EmptyState, cx } from '../ui/primitives';
import { CATEGORY_HEX, TONE_HEX, EVENT_CATEGORY_LABEL } from '../ui/tone';
import { fmtClock } from '../../utils/format';
import type { EventCategory, SimEvent } from '../../types';

export const EVENT_ICON: Record<EventCategory, LucideIcon> = {
  chem: FlaskConical,
  bio: Biohazard,
  rad: Radiation,
  fire: Flame,
  asset: Bot,
  system: Cpu,
  ai: BrainCircuit,
};

const FILTERS: { value: EventFilter; label: ReactNode; title: string; color?: string }[] = [
  { value: 'all', label: 'All', title: 'All events' },
  { value: 'chem', label: 'C', title: 'Chemical', color: CATEGORY_HEX.chem },
  { value: 'bio', label: 'B', title: 'Biological', color: CATEGORY_HEX.bio },
  { value: 'rad', label: 'R', title: 'Radiological', color: CATEGORY_HEX.rad },
  {
    value: 'assets',
    label: (
      <>
        <Bot size={12} strokeWidth={2.1} className="@min-[380px]:hidden" aria-hidden />
        <span className="sr-only @min-[380px]:not-sr-only">Assets</span>
      </>
    ),
    title: 'Field assets',
  },
];

export function matchesFilter(e: SimEvent, f: EventFilter) {
  if (f === 'all') return true;
  if (f === 'assets') return e.category === 'asset';
  return e.category === f;
}

export function focusEvent(e: SimEvent) {
  const ui = useUI.getState();
  if (!e.focus) return;
  if (ui.screen !== 'overview' && ui.screen !== 'twin') ui.setScreen('twin');
  if (e.focus.kind === 'sensor') ui.select({ kind: 'sensor', id: e.focus.id });
  else if (e.focus.kind === 'asset') ui.select({ kind: 'asset', id: e.focus.id });
  else if (e.focus.kind === 'zone') ui.select({ kind: 'zone', id: e.focus.id });
  else ui.select({ kind: 'location', x: e.focus.x, z: e.focus.z, label: e.focus.label ?? 'Location' });
  focusOn(e.focus);
}

export function EventRow({ e, expanded, onToggle, isNew }: { e: SimEvent; expanded: boolean; onToggle: () => void; isNew: boolean }) {
  const Icon = EVENT_ICON[e.category];
  const color = e.category === 'asset' ? '#4c94ff' : e.category === 'system' ? '#a7b1bb' : e.category === 'ai' ? '#b4a8ff' : CATEGORY_HEX[e.category];
  const tone = TONE_HEX[e.tone];
  const playback = useUI.getState;
  return (
    <li className={cx('relative border-b border-line', isNew && 'animate-slide-in')}>
      <span className="absolute inset-y-1 left-0 w-[2px] rounded-full" style={{ background: e.tone === 'info' || e.tone === 'neutral' ? 'transparent' : tone }} aria-hidden />
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-2.5 px-3 py-[7px] text-left transition-colors hover:bg-surface-2" aria-expanded={expanded}>
        <span className="mono mt-[1px] w-[52px] shrink-0 text-[10.5px] text-ink-3">{fmtClock(e.t)}</span>
        <span className="mt-[1px] flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px]" style={{ background: `${color}1c`, boxShadow: `inset 0 0 0 1px ${color}38` }}>
          <Icon size={12} strokeWidth={2} style={{ color }} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cx('block text-[12px] font-medium leading-[15px] text-ink-1', !expanded && 'truncate')}>{e.title}</span>
          <span className={cx('block text-[11px] leading-[14px] text-ink-2', !expanded && 'truncate')} title={expanded ? undefined : e.detail}>
            {e.detail}
          </span>
          {e.confidence !== undefined && <span className="block text-[10.5px] leading-[13px] text-ink-3">Confidence {Math.round(e.confidence * 100)}%</span>}
        </span>
        {expanded ? <ChevronDown size={14} className="mt-1 text-ink-3" aria-hidden /> : <ChevronRight size={14} className="mt-1 text-ink-4" aria-hidden />}
      </button>
      {expanded && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2 pl-[88px]">
          <span className="text-[10.5px] text-ink-3">{EVENT_CATEGORY_LABEL[e.category]}</span>
          {e.focus && (
            <button type="button" className="ctl h-[22px]" onClick={() => focusEvent(e)}>
              <Crosshair size={12} /> Focus in twin
            </button>
          )}
          {e.incidentId && (
            <button
              type="button"
              className="ctl h-[22px]"
              onClick={() => {
                const ui = useUI.getState();
                ui.selectIncident(e.incidentId ?? null);
                ui.setScreen('incidents');
              }}
            >
              <Siren size={12} /> {e.incidentId}
            </button>
          )}
          <button
            type="button"
            className="ctl h-[22px]"
            onClick={() => {
              const ui = playback();
              ui.setPlayback({ mode: 'replay', cursor: e.t - 5000, playing: false });
              ui.setScreen('twin');
              if (e.focus) focusOn(e.focus);
            }}
          >
            Replay from here
          </button>
        </div>
      )}
    </li>
  );
}

export function EventStreamPanel({ className }: { className?: string }) {
  const events = useSim((s) => s.events);
  const filter = useUI((s) => s.eventFilter);
  const setFilter = useUI((s) => s.setEventFilter);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [seenAt] = useState(() => Date.now());
  const list = useMemo(() => events.filter((e) => matchesFilter(e, filter)).slice(0, 60), [events, filter]);
  return (
    <Panel
      title={
        <>
          <span className="hidden @min-[350px]:inline">AI </span>Event stream
        </>
      }
      icon={ListChecks}
      className={cx('@container', className)}
      actions={<Segmented options={FILTERS} value={filter} onChange={setFilter} label="Filter events" />}
    >
      {list.length ? (
        <ul className="absolute inset-0 overflow-y-auto" aria-live="polite" aria-label="Event stream">
          {list.map((e) => (
            <EventRow
              key={e.id}
              e={e}
              isNew={e.t > seenAt}
              expanded={expanded === e.id}
              onToggle={() => {
                setExpanded(expanded === e.id ? null : e.id);
                if (expanded !== e.id && e.focus) focusEvent(e);
              }}
            />
          ))}
        </ul>
      ) : (
        <EmptyState icon={Inbox} title="No events" detail="No events match this filter in the retained window." />
      )}
    </Panel>
  );
}
