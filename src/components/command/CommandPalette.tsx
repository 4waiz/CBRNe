import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  LayoutDashboard,
  Box,
  Cctv,
  BrainCircuit,
  Siren,
  Bot,
  Drone,
  FlaskConical,
  Radiation,
  Biohazard,
  RotateCcw,
  Layers,
  Settings,
  Info,
  Flame,
  WifiOff,
  Waypoints,
  Crosshair,
  Thermometer,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useUI, type Screen } from '../../store/ui';
import { engine } from '../../simulation/engine';
import { focusOn, resetView } from '../../three/CameraRig';
import { PRESET_BY_ID } from '../../simulation/scenarios';
import { SENSORS } from '../../simulation/sensors';
import { LAYER_DEFS } from '../twin/TwinHud';
import type { ScenarioId } from '../../types';
import { cx, Kbd } from '../ui/primitives';

interface Cmd {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
}

function trigger(preset: ScenarioId) {
  const ui = useUI.getState();
  const draft = ui.scenarioDraft;
  engine.trigger({ ...draft, preset, locationId: PRESET_BY_ID[preset].defaultLocation });
  ui.notify(`${PRESET_BY_ID[preset].label} scenario started`, 'info');
}

function go(screen: Screen) {
  useUI.getState().setScreen(screen);
}

function focusAsset(id: 'UGV-01' | 'UAV-01') {
  const ui = useUI.getState();
  if (ui.screen !== 'overview' && ui.screen !== 'twin') ui.setScreen('twin');
  ui.select({ kind: 'asset', id });
  focusOn({ kind: 'asset', id });
}

function buildCommands(): Cmd[] {
  const cmds: Cmd[] = [
    { id: 'go-overview', group: 'Navigate', label: 'Go to Overview', icon: LayoutDashboard, run: () => go('overview') },
    { id: 'go-twin', group: 'Navigate', label: 'Open Digital Twin', icon: Box, run: () => go('twin') },
    { id: 'go-feeds', group: 'Navigate', label: 'Open Live Feeds', icon: Cctv, run: () => go('feeds') },
    { id: 'go-insights', group: 'Navigate', label: 'Open AI Insights', icon: BrainCircuit, run: () => go('insights') },
    { id: 'go-incidents', group: 'Navigate', label: 'Open Incidents', icon: Siren, run: () => go('incidents') },
    { id: 'focus-ugv', group: 'Focus', label: 'Focus UGV-01', hint: 'fly camera + follow', icon: Bot, run: () => focusAsset('UGV-01') },
    { id: 'focus-uav', group: 'Focus', label: 'Focus UAV-01', hint: 'fly camera + follow', icon: Drone, run: () => focusAsset('UAV-01') },
    { id: 'reset-view', group: 'Focus', label: 'Reset 3D view', icon: Crosshair, run: () => resetView() },
    { id: 'ugv-thermal', group: 'Focus', label: 'Open UGV-01 thermal feed', icon: Thermometer, run: () => { const ui = useUI.getState(); ui.setFeedMain('UGV-01'); ui.setFeedMode('UGV-01', 'thermal'); ui.setScreen('feeds'); } },
    { id: 'sc-chem', group: 'Scenarios', label: 'Trigger Chemical Scenario', icon: FlaskConical, run: () => trigger('chemical') },
    { id: 'sc-rad', group: 'Scenarios', label: 'Trigger Radiological Scenario', icon: Radiation, run: () => trigger('radiological') },
    { id: 'sc-bio', group: 'Scenarios', label: 'Trigger Biological Scenario', icon: Biohazard, run: () => trigger('biological') },
    { id: 'sc-multi', group: 'Scenarios', label: 'Trigger Multi-source Scenario', icon: Waypoints, run: () => trigger('multi') },
    { id: 'sc-thermal', group: 'Scenarios', label: 'Trigger Thermal Hotspot', icon: Flame, run: () => trigger('thermal') },
    { id: 'sc-degraded', group: 'Scenarios', label: 'Trigger Sensor Network Degraded', icon: WifiOff, run: () => trigger('degraded') },
    { id: 'sc-reset', group: 'Scenarios', label: 'Reset Scenario', hint: 'return to normal operations', icon: RotateCcw, run: () => { engine.reset(); useUI.getState().notify('Returned to normal operations', 'ok'); } },
    ...LAYER_DEFS.map((l) => ({ id: `layer-${l.id}`, group: 'Layers', label: `Toggle ${l.label} layer`, icon: Layers, run: () => useUI.getState().toggleLayer(l.id) })),
    ...SENSORS.map((s) => ({
      id: `sensor-${s.id}`,
      group: 'Sensors',
      label: `Inspect ${s.id}`,
      hint: s.name,
      icon: s.kind === 'rad' ? Radiation : s.kind === 'chem' ? FlaskConical : s.kind === 'bio' ? Biohazard : Layers,
      run: () => {
        const ui = useUI.getState();
        ui.setScreen('twin');
        ui.select({ kind: 'sensor', id: s.id });
        focusOn({ kind: 'sensor', id: s.id });
      },
    })),
    { id: 'settings', group: 'System', label: 'Open Settings · Scenario Control', icon: Settings, run: () => useUI.getState().openSettings('scenario') },
    { id: 'about', group: 'System', label: 'About BRIDGE', icon: Info, run: () => useUI.getState().openSettings('about') },
  ];
  return cmds;
}

function score(q: string, text: string) {
  const t = text.toLowerCase();
  const query = q.toLowerCase().trim();
  if (!query) return 1;
  if (t.includes(query)) return 3 - t.indexOf(query) / 100;
  // subsequence match
  let i = 0;
  for (const ch of t) if (ch === query[i]) i++;
  return i === query.length ? 1 : 0;
}

export function CommandPalette() {
  const open = useUI((s) => s.paletteOpen);
  const setOpen = useUI((s) => s.setPaletteOpen);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const commands = useMemo(buildCommands, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!useUI.getState().paletteOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);

  const results = useMemo(() => {
    const scored = commands.map((c) => ({ c, s: Math.max(score(q, c.label), score(q, `${c.group} ${c.hint ?? ''}`) * 0.6) })).filter((x) => x.s > 0);
    if (q.trim()) scored.sort((a, b) => b.s - a.s);
    return (q.trim() ? scored : scored.filter((x) => x.c.group !== 'Sensors')).map((x) => x.c);
  }, [q, commands]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;
  const run = (c: Cmd) => {
    setOpen(false);
    c.run();
  };
  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-bg-0/60 pt-[12vh] backdrop-blur-[2px]" onMouseDown={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-[600px] max-w-[92vw] overflow-hidden rounded-[10px] border border-line-strong bg-surface-1 shadow-[0_24px_70px_rgb(0_0_0/0.6)] animate-fade-in"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-3.5">
          <Search size={16} className="text-ink-3" aria-hidden />
          <input
            ref={inputRef}
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(results.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                const c = results[active];
                if (c) run(c);
              } else if (e.key === 'Escape') setOpen(false);
            }}
            placeholder="Type a command, screen, asset or sensor…"
            className="h-[48px] flex-1 bg-transparent text-[14px] text-ink-1 outline-none placeholder:text-ink-3"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmd-list"
            aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={listRef} id="cmd-list" role="listbox" className="max-h-[52vh] overflow-y-auto p-1.5">
          {results.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-ink-3">No matching commands</div>}
          {results.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            const Icon = c.icon;
            return (
              <div key={c.id}>
                {header && <div className="micro px-2.5 pb-1 pt-2">{header}</div>}
                <button
                  id={`cmd-${c.id}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(c)}
                  className={cx('flex w-full items-center gap-3 rounded-[6px] px-2.5 py-2 text-left', i === active ? 'bg-surface-3 text-ink-1' : 'text-ink-2')}
                >
                  <Icon size={15} className={i === active ? 'text-cyan' : 'text-ink-3'} aria-hidden />
                  <span className="text-[13px]">{c.label}</span>
                  {c.hint && <span className="truncate text-[11.5px] text-ink-3">{c.hint}</span>}
                  {i === active && <span className="ml-auto text-[10.5px] text-ink-3">Enter</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[10.5px] text-ink-3">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Enter</Kbd> run
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd> toggle
          </span>
        </div>
      </div>
    </div>
  );
}
