import { Box, Cctv, BrainCircuit, LayoutDashboard, Siren, Settings, Command, ShieldCheck, ShieldAlert, TriangleAlert, Radio } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useSim } from '../../store/sim';
import { useUI, type Screen } from '../../store/ui';
import { BridgeLogo } from './Logo';
import { fmtClock, fmtDate } from '../../utils/format';
import { cx, IconButton, useNow } from '../ui/primitives';
import { TONE_HEX } from '../ui/tone';
import type { SystemHealthLevel } from '../../types';

const NAV: { id: Screen; label: string; icon: LucideIcon }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'twin', label: '3D Twin', icon: Box },
  { id: 'feeds', label: 'Live Feeds', icon: Cctv },
  { id: 'insights', label: 'AI Insights', icon: BrainCircuit },
  { id: 'incidents', label: 'Incidents', icon: Siren },
];

const HEALTH: Record<SystemHealthLevel, { tone: keyof typeof TONE_HEX; icon: LucideIcon }> = {
  nominal: { tone: 'ok', icon: ShieldCheck },
  watch: { tone: 'watch', icon: ShieldAlert },
  degraded: { tone: 'watch', icon: TriangleAlert },
  alert: { tone: 'warn', icon: TriangleAlert },
};

function NavBadge({ screen }: { screen: Screen }) {
  const count = useSim((s) =>
    screen === 'incidents'
      ? s.incidents.filter((i) => i.status !== 'resolved').length
      : screen === 'insights'
        ? s.observations.filter((o) => o.status === 'validation' || o.status === 'review').length
        : 0,
  );
  const urgent = useSim((s) => (screen === 'incidents' ? s.incidents.some((i) => i.status === 'new') : false));
  if (!count) return null;
  return (
    <span
      className="ml-0.5 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-[3px] px-1 font-mono text-[9.5px] font-medium"
      style={{ background: urgent ? TONE_HEX.warn : 'rgb(148 163 184 / 0.2)', color: urgent ? '#0b0f14' : 'var(--color-ink-1)' }}
    >
      {count}
    </span>
  );
}

function Clock() {
  const now = useNow(1000);
  return (
    <div className="flex flex-col items-end leading-none">
      <span className="mono text-[13px] font-medium tracking-[0.02em] text-ink-1">
        {fmtClock(now)} <span className="text-[10px] text-ink-3">GST</span>
      </span>
      <span className="mt-[3px] font-cond text-[10px] uppercase tracking-[0.1em] text-ink-3 max-[1500px]:hidden">{fmtDate(now)}</span>
    </div>
  );
}

function Freshness() {
  const now = useNow(500);
  const last = useSim((s) => s.lastUpdate);
  const age = last ? Math.max(0, (now - last) / 1000) : 99;
  const tone = age < 2.5 ? 'ok' : age < 6 ? 'watch' : 'warn';
  return (
    <div className="flex shrink-0 items-center gap-2 whitespace-nowrap" title="Time since the last synthetic telemetry update">
      <Radio size={14} strokeWidth={1.8} style={{ color: TONE_HEX[tone] }} aria-hidden />
      <div className="flex flex-col leading-none">
        <span className="font-cond text-[10px] uppercase tracking-[0.1em] text-ink-3 max-[1500px]:hidden">Data age</span>
        <span className="mono mt-[3px] text-[12px] text-ink-1">{age < 2 ? '< 2 s' : `${age.toFixed(0)} s`}</span>
      </div>
    </div>
  );
}

function Health() {
  const health = useSim((s) => s.health);
  const h = HEALTH[health.level];
  const c = TONE_HEX[h.tone];
  const Icon = h.icon;
  return (
    <button
      type="button"
      onClick={() => useUI.getState().setScreen(health.level === 'nominal' ? 'overview' : 'incidents')}
      className="flex shrink-0 items-center gap-2 rounded-[6px] border px-2 py-1 text-left transition-colors hover:bg-surface-2"
      style={{ borderColor: `${c}40`, background: `${c}0d` }}
      title={`System health: ${health.label}`}
    >
      <Icon size={15} strokeWidth={1.9} style={{ color: c }} aria-hidden />
      <span className="flex flex-col leading-none">
        <span className="font-cond text-[10px] uppercase tracking-[0.1em]" style={{ color: c }}>
          {health.level === 'nominal' ? 'System health' : health.level}
        </span>
        <span className="mt-[3px] max-w-[150px] truncate text-[11.5px] text-ink-1 max-[1500px]:max-w-[130px] max-[1440px]:hidden min-[1800px]:max-w-[220px]">{health.label}</span>
      </span>
    </button>
  );
}

export function Header() {
  const screen = useUI((s) => s.screen);
  const setScreen = useUI((s) => s.setScreen);
  return (
    <header className="relative z-20 flex h-[52px] shrink-0 items-center gap-3 border-b border-line bg-bg-1/95 px-4">
      <div className="flex shrink-0 items-center gap-3">
        <BridgeLogo height={22} />
        <span className="h-7 w-px bg-line-strong" aria-hidden />
        <div className="hidden flex-col leading-none lg:flex">
          <span className="whitespace-nowrap font-cond text-[13.5px] font-semibold tracking-[0.13em] text-ink-1 max-[1500px]:text-[12px]">CBRN COMMAND CENTER</span>
        </div>
      </div>

      <nav className="mx-auto flex h-full items-stretch" aria-label="Primary">
        {NAV.map((n) => {
          const active = screen === n.id;
          const Icon = n.icon;
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => setScreen(n.id)}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'group relative flex items-center gap-1.5 px-2.5 font-cond text-[12.5px] font-semibold uppercase tracking-[0.08em] transition-colors min-[1800px]:gap-2 min-[1800px]:px-3.5',
                active ? 'text-ink-1' : 'text-ink-3 hover:text-ink-1',
              )}
            >
              <Icon size={15} strokeWidth={1.9} className={cx(active ? 'text-cyan' : 'text-ink-3 group-hover:text-ink-2', 'max-[1440px]:hidden')} aria-hidden />
              <span className="whitespace-nowrap max-[1440px]:text-[11.5px]">{n.label}</span>
              <NavBadge screen={n.id} />
              <span
                className={cx('absolute inset-x-2 bottom-0 h-[2px] rounded-full transition-opacity', active ? 'opacity-100' : 'opacity-0')}
                style={{ background: 'linear-gradient(90deg, transparent, var(--color-cyan) 25%, var(--color-cyan) 75%, transparent)' }}
              />
            </button>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center gap-3.5">
        <Clock />
        <span className="h-7 w-px bg-line" aria-hidden />
        <Freshness />
        <Health />
        <button
          type="button"
          onClick={() => useUI.getState().setPaletteOpen(true)}
          className="ctl hidden h-[26px] gap-1.5 min-[1700px]:inline-flex"
          title="Command palette (Ctrl+K)"
        >
          <Command size={13} strokeWidth={1.9} aria-hidden />
          <span className="text-[11px]">Ctrl K</span>
        </button>
        <IconButton icon={Settings} label="Settings" size={28} onClick={() => useUI.getState().openSettings()} />
      </div>
    </header>
  );
}
