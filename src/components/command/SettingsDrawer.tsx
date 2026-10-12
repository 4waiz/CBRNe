import { useEffect } from 'react';
import { X, SlidersHorizontal, Monitor, Info, Play, RotateCcw, Wind, FlaskConical, Radiation, Biohazard, WifiOff, Flame, Waypoints, ShieldCheck, Keyboard } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useUI } from '../../store/ui';
import { useSim } from '../../store/sim';
import { engine } from '../../simulation/engine';
import { PRESETS, PRESET_BY_ID } from '../../simulation/scenarios';
import { LOCATIONS, LOCATION_BY_ID } from '../../simulation/locations';
import { Segmented, Toggle, cx, Kbd, useNow } from '../ui/primitives';
import { compassLabel } from '../../utils/math';
import { fmtDuration } from '../../utils/format';
import { BridgeLogo } from '../layout/Logo';
import type { ScenarioId, Severity } from '../../types';

const PRESET_ICON: Record<ScenarioId, LucideIcon> = {
  normal: ShieldCheck,
  radiological: Radiation,
  chemical: FlaskConical,
  biological: Biohazard,
  degraded: WifiOff,
  thermal: Flame,
  multi: Waypoints,
};

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="micro">{label}</span>
        {hint && <span className="text-[10.5px] text-ink-3">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function ScenarioTab() {
  const draft = useUI((s) => s.scenarioDraft);
  const set = useUI((s) => s.setScenarioDraft);
  const autoplay = useUI((s) => s.settings.autoplay);
  const run = useSim((s) => s.run);
  const now = useNow(1000);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-[7px] border border-line bg-surface-2/60 px-3 py-2.5">
        <div className="micro">Active scenario</div>
        {run ? (
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[13px] font-medium text-ink-1">{run.label}</span>
            <span className="text-[11px] text-ink-3">
              {LOCATION_BY_ID[run.locationId]?.short} · {run.severity} · {fmtDuration((now - run.startedAt) / 1000)}
            </span>
          </div>
        ) : (
          <div className="mt-1 text-[13px] text-ink-1">Normal operations</div>
        )}
      </div>

      <Field label="Scenario preset">
        <div className="grid grid-cols-2 gap-1.5">
          {PRESETS.map((p) => {
            const Icon = PRESET_ICON[p.id];
            const on = draft.preset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => set({ preset: p.id, locationId: p.defaultLocation })}
                className={cx('flex flex-col gap-0.5 rounded-[6px] border px-2.5 py-2 text-left transition-colors', on ? 'border-cyan/60 bg-[rgb(60_200_220/0.08)]' : 'border-line hover:bg-surface-2')}
                aria-pressed={on}
              >
                <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink-1">
                  <Icon size={13} className={on ? 'text-cyan' : 'text-ink-3'} aria-hidden /> {p.label}
                </span>
                <span className="text-[10.5px] leading-[13px] text-ink-3">{p.description}</span>
              </button>
            );
          })}
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Severity">
          <Segmented<Severity>
            label="Severity"
            value={draft.severity}
            onChange={(v) => set({ severity: v })}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'moderate', label: 'Moderate' },
              { value: 'high', label: 'High' },
            ]}
          />
        </Field>
        <Field label="Duration">
          <select
            value={draft.duration}
            onChange={(e) => set({ duration: Number(e.target.value) })}
            className="h-[26px] rounded-[5px] border border-line-strong bg-surface-2 px-2 text-[12px] text-ink-1"
            aria-label="Duration"
          >
            <option value={0}>Sustained until reset</option>
            <option value={2}>2 minutes</option>
            <option value={5}>5 minutes</option>
            <option value={10}>10 minutes</option>
          </select>
        </Field>
      </div>

      <Field label="Location">
        <select
          value={draft.locationId}
          onChange={(e) => set({ locationId: e.target.value })}
          className="h-[28px] rounded-[5px] border border-line-strong bg-surface-2 px-2 text-[12px] text-ink-1"
          aria-label="Location"
        >
          {LOCATIONS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Wind from" hint={`${compassLabel(draft.windDir)} ${Math.round(draft.windDir)}°`}>
          <input type="range" min={0} max={359} step={1} value={draft.windDir} onChange={(e) => set({ windDir: Number(e.target.value) })} className="accent-[var(--color-cyan)]" aria-label="Wind direction" />
        </Field>
        <Field label="Wind speed" hint={`${Math.round(draft.windSpeed)} km/h`}>
          <input type="range" min={2} max={45} step={1} value={draft.windSpeed} onChange={(e) => set({ windSpeed: Number(e.target.value) })} className="accent-[var(--color-cyan)]" aria-label="Wind speed" />
        </Field>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          className="ctl h-[30px] flex-1 border-cyan/60 bg-[rgb(60_200_220/0.12)] text-ink-1"
          onClick={() => {
            engine.trigger(draft);
            useUI.getState().notify(`${PRESET_BY_ID[draft.preset].label} · ${LOCATION_BY_ID[draft.locationId]?.short}`, 'info');
          }}
        >
          <Play size={13} /> {draft.preset === 'normal' ? 'Return to normal' : 'Trigger scenario'}
        </button>
        <button
          type="button"
          className="ctl h-[30px]"
          onClick={() => {
            engine.setWind(draft.windDir, draft.windSpeed);
            useUI.getState().notify(`Wind set to ${compassLabel(draft.windDir)} ${Math.round(draft.windSpeed)} km/h`, 'info');
          }}
        >
          <Wind size={13} /> Apply wind
        </button>
        <button
          type="button"
          className="ctl h-[30px]"
          onClick={() => {
            engine.reset();
            useUI.getState().notify('Scenario reset · normal operations', 'ok');
          }}
        >
          <RotateCcw size={13} /> Reset
        </button>
      </div>

      <label className="flex items-center justify-between rounded-[6px] border border-line px-3 py-2">
        <span>
          <span className="block text-[12px] text-ink-1">Play opening sequence on load</span>
          <span className="block text-[10.5px] text-ink-3">A mild multi-source event unfolds shortly after start-up.</span>
        </span>
        <Toggle checked={autoplay} onChange={(v) => useUI.getState().setSettings({ autoplay: v })} label="Opening sequence" />
      </label>
    </div>
  );
}

function DisplayTab() {
  const settings = useUI((s) => s.settings);
  const set = useUI((s) => s.setSettings);
  const rows: [string, string, React.ReactNode][] = [
    ['Render quality', 'High uses full resolution, 4× MSAA and 4K shadows.', <Segmented key="q" label="Render quality" value={settings.quality} onChange={(v) => set({ quality: v })} options={[{ value: 'high', label: 'High' }, { value: 'balanced', label: 'Balanced' }]} />],
    ['Sensor markers in 3D', 'Show sensor badges and ground rings.', <Toggle key="l" checked={settings.labels} onChange={(v) => set({ labels: v })} label="Sensor markers" />],
    ['Frame new incidents', 'Bring a new incident into the 3D view unless the camera was moved in the last 20 s.', <Toggle key="f" checked={settings.autoFrame} onChange={(v) => set({ autoFrame: v })} label="Frame new incidents" />],
    ['Reduce motion', 'Minimise UI animation (honours the OS setting too).', <Toggle key="r" checked={settings.reduceMotion} onChange={(v) => set({ reduceMotion: v })} label="Reduce motion" />],
    ['Thermal palette', 'Colour map for thermal feeds.', <Segmented key="p" label="Thermal palette" value={settings.palette} onChange={(v) => set({ palette: v })} options={[{ value: 'ironbow', label: 'Ironbow' }, { value: 'whitehot', label: 'White-hot' }]} />],
  ];
  return (
    <div className="flex flex-col gap-1">
      {rows.map(([label, hint, ctl]) => (
        <div key={label} className="flex items-center justify-between gap-4 border-b border-line py-2.5">
          <span>
            <span className="block text-[12px] text-ink-1">{label}</span>
            <span className="block text-[10.5px] text-ink-3">{hint}</span>
          </span>
          {ctl}
        </div>
      ))}
      <div className="mt-3">
        <div className="micro mb-1.5 flex items-center gap-1.5">
          <Keyboard size={12} /> Keyboard
        </div>
        {[
          ['Command palette', ['Ctrl', 'K']],
          ['Move twin / feed camera', ['W', 'A', 'S', 'D']],
          ['Camera height · faster', ['Q', 'E', 'Shift']],
          ['Switch screen', ['Alt', '1–5']],
          ['Close dialog / clear selection', ['Esc']],
        ].map(([l, keys]) => (
          <div key={l as string} className="flex items-center justify-between py-1 text-[11.5px] text-ink-2">
            {l}
            <span className="flex gap-1">
              {(keys as string[]).map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AboutTab() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-start gap-2">
        <BridgeLogo height={28} />
        <div className="text-[11.5px] leading-[16px] text-ink-3">Integrated CBRN Situational Awareness · version 1.0</div>
      </div>
      <p className="text-[12.5px] leading-[19px] text-ink-2">
        BRIDGE brings chemical, biological, radiological and nuclear-readiness monitoring together with an interactive 3D digital twin, synthetic camera and robot feeds, AI-assisted correlation and an incident-response workflow.
      </p>
      <div className="rounded-[7px] border border-line-strong bg-surface-2/70 px-3.5 py-3">
        <div className="micro mb-1">Disclosure</div>
        <p className="text-[12.5px] leading-[19px] text-ink-1">
          Conceptual situational-awareness environment using synthetic local data. No connection to operational Barakah systems.
        </p>
        <p className="mt-2 text-[11.5px] leading-[17px] text-ink-3">
          Every reading, event, camera image and AI observation is generated in your browser by a seeded scenario engine. The 3D campus is a generalized, artistic layout and does not represent real buildings, security zones, sensor or camera locations, or access routes.
        </p>
      </div>
      <div className="text-[11.5px] leading-[18px] text-ink-3">
        Built with React, three.js / React Three Fiber and Blender-generated assets.
      </div>
      <div className="border-t border-line pt-3 text-[12px] text-ink-2">
        BRIDGE for Barakah • Developed by{' '}
        <a href="https://kanbanstudios.ae/team-kanban" target="_blank" rel="noreferrer" className="text-ink-1 underline decoration-ink-4 underline-offset-2 hover:decoration-cyan">
          Awaiz Ahmed
        </a>
      </div>
    </div>
  );
}

export function SettingsDrawer() {
  const open = useUI((s) => s.settingsOpen);
  const tab = useUI((s) => s.settingsTab);
  const close = useUI((s) => s.closeSettings);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);
  if (!open) return null;
  const tabs: { id: typeof tab; label: string; icon: LucideIcon }[] = [
    { id: 'scenario', label: 'Scenario control', icon: SlidersHorizontal },
    { id: 'display', label: 'Display', icon: Monitor },
    { id: 'about', label: 'About BRIDGE', icon: Info },
  ];
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-bg-0/45" onMouseDown={close}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex h-full w-[440px] max-w-[96vw] flex-col border-l border-line-strong bg-surface-1 shadow-[-24px_0_60px_rgb(0_0_0/0.45)] animate-fade-in"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4">
          <h2 className="panel-title text-[13.5px]">Settings</h2>
          <button type="button" className="ml-auto text-ink-3 hover:text-ink-1" onClick={close} aria-label="Close settings">
            <X size={16} />
          </button>
        </header>
        <nav className="flex shrink-0 gap-1 border-b border-line px-3 pt-2" aria-label="Settings sections">
          {tabs.map((t) => {
            const Icon = t.icon;
            const on = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => useUI.getState().openSettings(t.id)}
                aria-current={on ? 'page' : undefined}
                className={cx('relative flex items-center gap-1.5 px-2.5 pb-2 pt-1 text-[12px] transition-colors', on ? 'text-ink-1' : 'text-ink-3 hover:text-ink-1')}
              >
                <Icon size={13} aria-hidden /> {t.label}
                {on && <span className="absolute inset-x-1 bottom-0 h-[2px] rounded-full bg-cyan" />}
              </button>
            );
          })}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'scenario' && <ScenarioTab />}
          {tab === 'display' && <DisplayTab />}
          {tab === 'about' && <AboutTab />}
        </div>
      </aside>
    </div>
  );
}
