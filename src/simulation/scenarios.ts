import type {
  AssetId,
  ChecklistItem,
  Evidence,
  EventCategory,
  FocusTarget,
  Incident,
  IncidentCategory,
  Observation,
  ObservationStatus,
  ScenarioId,
  ScenarioRun,
  Severity,
  SimEvent,
  TimelineKind,
  Tone,
  Vec2,
} from '../types';
import type { Effect, EffectKind } from './effects';
import { FIRE_SITE, type ScenarioLocation } from './locations';
import { fmtDuration } from '../utils/format';
import { compassLabel } from '../utils/math';

// ------------------------------------------------------------------------------------------------
// Scenario presets: each preset injects synthetic effects and runs a script that drives events,
// AI observations, incidents and asset tasking. Wording is deliberately cautious ("possible",
// "elevated trend", "review suggested") — the fusion layer never claims certainty.
// ------------------------------------------------------------------------------------------------

export interface PresetDef {
  id: ScenarioId;
  label: string;
  description: string;
  defaultLocation: string;
}

export const PRESETS: PresetDef[] = [
  { id: 'normal', label: 'Normal operations', description: 'Baseline synthetic telemetry, routine patrols and checks.', defaultLocation: 'U3-EAST' },
  { id: 'radiological', label: 'Radiological trend', description: 'Localized gamma dose-rate trend with UGV inspection.', defaultLocation: 'U3-EAST' },
  { id: 'chemical', label: 'Chemical plume', description: 'VOC release indication; plume follows the synthetic wind.', defaultLocation: 'SERVICE' },
  { id: 'biological', label: 'Biological aerosol', description: 'Aerosol screening anomaly; lab confirmation required.', defaultLocation: 'ADMIN' },
  { id: 'degraded', label: 'Sensor network degraded', description: 'Communication dropout across a sector and one stale CCTV stream.', defaultLocation: 'U1-WEST' },
  { id: 'thermal', label: 'Thermal hotspot', description: 'Equipment surface temperature rise, thermal inspection.', defaultLocation: 'SWITCHYARD' },
  { id: 'multi', label: 'Multi-source correlation', description: 'Gamma trend + thermal signature + wind model correlated by AI fusion.', defaultLocation: 'U3-EAST' },
  { id: 'fire', label: 'Fire response', description: 'Generator fire in the service yard: robot dog suppression, UAV overwatch, decontamination and recovery.', defaultLocation: 'YARD' },
];

/** Presets that always run at a fixed site (their layout is built around it). */
export const FIXED_LOCATION: Partial<Record<ScenarioId, string>> = { fire: 'YARD' };

export const PRESET_BY_ID = Object.fromEntries(PRESETS.map((p) => [p.id, p])) as Record<ScenarioId, PresetDef>;

export const SEVERITY_FACTOR: Record<Severity, number> = { low: 0.65, moderate: 1, high: 1.45 };

export interface ScriptVars {
  incidentId?: string;
  obsId?: string;
  detectedAt?: number;
  dispatchedAt?: number;
  arrivedAt?: number;
  [k: string]: unknown;
}

export interface EventSpec {
  category: EventCategory;
  tone: Tone;
  title: string;
  detail: string;
  confidence?: number;
  focus?: FocusTarget;
}

export interface ObservationSpec {
  title: string;
  summary: string;
  category: IncidentCategory;
  status: ObservationStatus;
  confidence: number;
  sources: string[];
  recommended: string[];
  evidence: Omit<Evidence, 'id' | 't'>[];
}

export interface IncidentSpec {
  title: string;
  category: IncidentCategory;
  severity: Severity;
  sensors: string[];
  checklist: Omit<ChecklistItem, 'done'>[];
}

export interface FirePlanTimes {
  sprayStart: number;
  sprayEnd: number;
  deconStart: number;
  deconEnd: number;
  chargeStart: number;
  chargeEnd: number;
}

export interface ScriptContext {
  run: ScenarioRun;
  loc: ScenarioLocation;
  sev: number;
  vars: ScriptVars;
  now(): number;
  effect(kind: EffectKind, opts: { amplitude: number; sigma: number; ramp?: number; delay?: number; x?: number; z?: number; sensors?: string[]; delays?: number[] }): Effect;
  event(e: EventSpec): SimEvent;
  incident(spec: IncidentSpec): Incident;
  timeline(kind: TimelineKind, text: string, actor: string, detail?: string, t?: number): void;
  check(itemId: string): void;
  observation(spec: ObservationSpec): Observation;
  evidence(ev: Omit<Evidence, 'id' | 't'>): void;
  observe(patch: Partial<Observation>): void;
  dispatchUgv(label: string): { distance: number; duration: number };
  orbitUav(label: string, x?: number, z?: number, opts?: { r?: number; alt?: number; speed?: number }): void;
  /** fire response: send the robot along the roads (fast), arrival is reported like dispatchUgv */
  ugvRespond(target: Vec2, lookAt: Vec2, label: string, vmax?: number): { distance: number; duration: number };
  /** fire response: schedule spray → decon → dock → patrol from the robot's position now */
  ugvFirePlan(o: { target: Vec2; toTent: Vec2[]; toDock: Vec2[]; spray: number; wash: number; charge: number }): FirePlanTimes;
  ugvDistanceTo(x: number, z: number): number;
  /** start an effect's ramp-down at time `at` (ms) */
  endEffect(id: string, at: number, rampDown: number): void;
  teamMuster(point: Vec2, face: Vec2, label: string): number;
  teamRelease(): void;
  uavResume(): void;
  /** the scenario resolves itself: incident closed by the system, run ended */
  resolveScenario(summary: string): void;
  /** flame temperature at the scenario location (°C) */
  fireTemp(): number;
  assignTeam(task: string): void;
  sensor(id: string): number | null;
  addSamples(n: number): void;
  setFeedStale(feed: string, stale: boolean): void;
  ambient(): number;
  windText(): string;
  hotspotTemp(): number;
}

export interface ScriptStep {
  at?: number;
  when?: (c: ScriptContext) => boolean;
  run: (c: ScriptContext) => void;
  done?: boolean;
}

const loc = (c: ScriptContext): FocusTarget => ({ kind: 'location', x: c.loc.x, z: c.loc.z, label: c.loc.short, radius: 120 });
const UGV: FocusTarget = { kind: 'asset', id: 'UGV-01' };
const UAV: FocusTarget = { kind: 'asset', id: 'UAV-01' };
const sensorFocus = (id: string): FocusTarget => ({ kind: 'sensor', id });
const fmtGamma = (v: number | null) => (v === null ? '—' : v.toFixed(3));

const arrived = (c: ScriptContext, delayMs = 0) => c.vars.arrivedAt !== undefined && c.now() >= c.vars.arrivedAt + delayMs;

/** Confidence nudged slightly by severity (stronger signals correlate a little more clearly). */
const conf = (c: ScriptContext, base: number) => Math.min(0.95, Math.max(0.3, base + (c.sev - 1) * 0.04));

const RAD_CHECKLIST: Omit<ChecklistItem, 'done'>[] = [
  { id: 'calibration', text: 'Confirm monitor health & calibration record', priority: 'high' },
  { id: 'dispatch', text: 'Dispatch inspection asset', priority: 'high' },
  { id: 'evidence', text: 'Review thermal / visual evidence', priority: 'medium' },
  { id: 'supervisor', text: 'Notify shift supervisor', priority: 'high' },
  { id: 'personnel', text: 'Confirm personnel accountability', priority: 'medium' },
  { id: 'assessment', text: 'Record operator assessment', priority: 'medium' },
];

const CHEM_CHECKLIST: Omit<ChecklistItem, 'done'>[] = [
  { id: 'wind', text: 'Confirm plume axis with wind model', priority: 'high' },
  { id: 'aerial', text: 'Task UAV aerial survey', priority: 'medium' },
  { id: 'dispatch', text: 'Dispatch mobile sampling asset', priority: 'high' },
  { id: 'shelter', text: 'Review shelter-in-place advisory', priority: 'high' },
  { id: 'personnel', text: 'Confirm personnel accountability', priority: 'medium' },
  { id: 'assessment', text: 'Record operator assessment', priority: 'medium' },
];

const BIO_CHECKLIST: Omit<ChecklistItem, 'done'>[] = [
  { id: 'sample', text: 'Collect confirmatory sample', priority: 'high' },
  { id: 'lab', text: 'Submit sample for lab confirmation', priority: 'high' },
  { id: 'hvac', text: 'Review HVAC intake status', priority: 'medium' },
  { id: 'supervisor', text: 'Notify shift supervisor', priority: 'medium' },
  { id: 'assessment', text: 'Record operator assessment', priority: 'medium' },
];

const FIRE_CHECKLIST: Omit<ChecklistItem, 'done'>[] = [
  { id: 'detect', text: 'Detect · smoke flagged by CAM-02 analytics', priority: 'high' },
  { id: 'protect', text: 'Protect · withdraw personnel to the assembly point', priority: 'high' },
  { id: 'dispatch', text: 'Deploy · robot on scene with flames confirmed, UAV overwatch', priority: 'high' },
  { id: 'suppress', text: 'Suppress · knock down the fire, confirm on thermal', priority: 'high' },
  { id: 'decon', text: 'Decontaminate · robot through DECON-1', priority: 'medium' },
  { id: 'recover', text: 'Recover · recharge, return personnel, close out', priority: 'medium' },
];

const NET_CHECKLIST: Omit<ChecklistItem, 'done'>[] = [
  { id: 'segment', text: 'Verify network segment status', priority: 'high' },
  { id: 'dispatch', text: 'Deploy mobile sensing (UGV)', priority: 'medium' },
  { id: 'cctv', text: 'Confirm CCTV failover for CAM-02', priority: 'medium' },
  { id: 'ticket', text: 'Raise maintenance ticket', priority: 'low' },
];

const THERMAL_CHECKLIST: Omit<ChecklistItem, 'done'>[] = [
  { id: 'dispatch', text: 'Dispatch thermal inspection', priority: 'high' },
  { id: 'load', text: 'Review equipment load and cooling status', priority: 'high' },
  { id: 'maintenance', text: 'Notify electrical maintenance', priority: 'medium' },
  { id: 'assessment', text: 'Record operator assessment', priority: 'medium' },
];

// ------------------------------------------------------------------------------------------------

function radiologicalCore(withThermal: boolean): ScriptStep[] {
  return [
    {
      at: 0,
      run: (c) => {
        c.effect('rad', { amplitude: 0.21 * c.sev, sigma: 55, ramp: 38 });
        if (withThermal) c.effect('thermal', { amplitude: 27 * c.sev, sigma: 6, ramp: 55, delay: 3 });
      },
    },
    {
      at: 7,
      run: (c) => {
        const s = c.loc.sensors.rad[0];
        c.vars.detectedAt = c.now();
        c.event({ category: 'rad', tone: 'warn', title: 'Sensor trend flagged', detail: `${s} · rising gamma trend detected`, confidence: conf(c, 0.62), focus: sensorFocus(s) });
        c.observation({
          title: 'Elevated gamma trend',
          summary: `${s} dose rate is rising above its 15-minute synthetic baseline near ${c.loc.short}.`,
          category: withThermal ? 'multi' : 'rad',
          status: 'monitoring',
          confidence: conf(c, 0.62),
          sources: [s],
          recommended: [
            `Review ${s} trend against its calibration record`,
            'Dispatch an inspection asset to the area',
            'Maintain aerial overwatch until operator assessment',
            'Record operator validation decision',
          ],
          evidence: [{ source: s, sourceKind: 'sensor', summary: 'Rising dose-rate trend vs. 15-minute baseline', value: `${fmtGamma(c.sensor(s))} µSv/h`, weight: 0.62 }],
        });
      },
    },
    {
      at: 11,
      run: (c) => {
        const [s, , , down] = c.loc.sensors.rad;
        const downwind = down ?? c.loc.sensors.rad[1];
        c.event({ category: 'ai', tone: 'info', title: 'Cross-source correlation initiated', detail: `${s} · ${downwind} · wind model`, confidence: conf(c, 0.74), focus: loc(c) });
        c.evidence({ source: downwind, sourceKind: 'sensor', summary: 'Downwind monitor shows a smaller, consistent rise', value: `${fmtGamma(c.sensor(downwind))} µSv/h`, weight: 0.32 });
        c.evidence({ source: 'Wind model', sourceKind: 'model', summary: 'Dispersion pattern consistent with synthetic wind field', value: c.windText(), weight: 0.4 });
        c.observe({
          title: 'Radiological trend anomaly',
          status: 'review',
          confidence: conf(c, 0.74),
          sources: [s, downwind, 'Wind model'],
          summary: `Gamma trend at ${s} increased above the generated scenario baseline; downwind response and wind model are consistent with a localized source near ${c.loc.equipment.toLowerCase()}.`,
        });
        c.incident({
          title: `Localized radiological trend · ${c.loc.short}`,
          category: withThermal ? 'multi' : 'rad',
          severity: c.run.severity,
          sensors: [s, downwind],
          checklist: RAD_CHECKLIST,
        });
        c.timeline('detect', 'Anomaly identified', 'Fusion engine', `${s} rising gamma trend`, c.vars.detectedAt);
        c.timeline('ai', 'Cross-source correlation initiated', 'Fusion engine', `${s}, ${downwind}, wind model`);
      },
    },
    {
      at: 17,
      run: (c) => {
        const r = c.dispatchUgv(`Inspection · ${c.loc.short}`);
        c.event({ category: 'asset', tone: 'info', title: 'UGV-01 dispatched', detail: `Inspection task · ${Math.round(r.distance)} m route · ETA ${fmtDuration(r.duration)}`, focus: UGV });
        c.timeline('asset', 'UGV-01 assigned', 'Response coordinator', `Route ${Math.round(r.distance)} m · ETA ${fmtDuration(r.duration)}`);
        c.check('dispatch');
      },
    },
    {
      at: 21,
      run: (c) => {
        c.orbitUav(`Overwatch · ${c.loc.short}`);
        c.event({ category: 'asset', tone: 'info', title: 'UAV-01 re-tasked', detail: `Overwatch orbit · ${c.loc.sector}`, focus: UAV });
        c.timeline('asset', 'UAV-01 overwatch orbit', 'Response coordinator');
      },
    },
    {
      when: (c) => arrived(c),
      run: (c) => {
        const dose = c.sensor(c.loc.sensors.rad[0]);
        const ugvDose = dose === null ? null : dose * 0.92;
        if (withThermal) {
          const temp = c.hotspotTemp();
          const delta = temp - c.ambient();
          c.event({ category: 'asset', tone: 'warn', title: 'UGV thermal frame analysed', detail: `${c.loc.equipment} · ${temp.toFixed(1)} °C surface (+${delta.toFixed(0)} °C vs ambient)`, confidence: conf(c, 0.87), focus: UGV });
          c.evidence({ source: 'UGV-01 thermal', sourceKind: 'camera', summary: `Localized heat signature on ${c.loc.equipment.toLowerCase()}`, value: `${temp.toFixed(1)} °C`, weight: 0.55 });
          c.timeline('evidence', 'Thermal inspection available', 'UGV-01', `Hotspot ${temp.toFixed(1)} °C on ${c.loc.equipment.toLowerCase()}`);
        } else {
          c.event({ category: 'asset', tone: 'info', title: 'UGV thermal frame analysed', detail: 'No abnormal heat signature detected', confidence: conf(c, 0.88), focus: UGV });
          c.evidence({ source: 'UGV-01 thermal', sourceKind: 'camera', summary: 'No abnormal heat signature at the source area', value: 'Nominal', weight: 0.18 });
          c.timeline('evidence', 'Thermal inspection available', 'UGV-01', 'No abnormal heat signature');
        }
        c.event({ category: 'rad', tone: 'warn', title: 'UGV-01 onboard dosimeter', detail: `${fmtGamma(ugvDose)} µSv/h at stand-off position`, confidence: conf(c, 0.9), focus: UGV });
        c.evidence({ source: 'UGV-01 dosimeter', sourceKind: 'asset', summary: 'Onboard dosimeter consistent with fixed-monitor trend', value: `${fmtGamma(ugvDose)} µSv/h`, weight: 0.42 });
        c.observe({
          confidence: conf(c, withThermal ? 0.91 : 0.84),
          sources: withThermal ? [c.loc.sensors.rad[0], 'UGV-01 thermal', 'Wind model'] : [c.loc.sensors.rad[0], 'UGV-01 dosimeter', 'Wind model'],
        });
      },
    },
    {
      when: (c) => arrived(c, 6000),
      run: (c) => {
        const pct = Math.round(conf(c, withThermal ? 0.91 : 0.84) * 100);
        c.event({ category: 'ai', tone: 'watch', title: 'Human validation required', detail: `3 sources correlated · confidence ${pct}%`, confidence: pct / 100, focus: loc(c) });
        c.timeline('ai', 'Human review requested', 'Fusion engine', withThermal ? 'Sensor trend + thermal camera + wind model correlated' : 'Sensor trend + UGV dosimeter + wind model correlated');
        c.observe({ status: 'validation' });
      },
    },
  ];
}

function chemicalScript(): ScriptStep[] {
  return [
    { at: 0, run: (c) => void c.effect('chem', { amplitude: 2.4 * c.sev, sigma: 40, ramp: 24 }) },
    {
      at: 6,
      run: (c) => {
        const s = c.loc.sensors.chem[0];
        c.vars.detectedAt = c.now();
        c.event({ category: 'chem', tone: 'warn', title: 'VOC rise detected', detail: `${s} · ${(c.sensor(s) ?? 0).toFixed(2)} ppm and rising`, confidence: conf(c, 0.6), focus: sensorFocus(s) });
        c.observation({
          title: 'Possible VOC release',
          summary: `${s} reports a volatile-organics rise above baseline near ${c.loc.short}.`,
          category: 'chem',
          status: 'monitoring',
          confidence: conf(c, 0.6),
          sources: [s],
          recommended: [
            'Verify plume axis against the wind model',
            'Review shelter-in-place advisory (no automatic action)',
            `Hold non-essential movement through ${c.loc.short} pending review`,
            'Record operator validation decision',
          ],
          evidence: [{ source: s, sourceKind: 'sensor', summary: 'VOC concentration above baseline band', value: `${(c.sensor(s) ?? 0).toFixed(2)} ppm`, weight: 0.6 }],
        });
      },
    },
    {
      at: 11,
      run: (c) => {
        const [s, s2] = c.loc.sensors.chem;
        c.event({ category: 'ai', tone: 'info', title: 'Plume model correlated', detail: `Axis consistent with ${c.windText()}`, confidence: conf(c, 0.72), focus: loc(c) });
        c.evidence({ source: 'Wind model', sourceKind: 'model', summary: 'Plume axis aligned with synthetic wind', value: c.windText(), weight: 0.45 });
        c.evidence({ source: s2, sourceKind: 'sensor', summary: 'Downwind sensor trending upward', value: `${(c.sensor(s2) ?? 0).toFixed(2)} ppm`, weight: 0.25 });
        c.observe({ title: 'Chemical plume indication', status: 'review', confidence: conf(c, 0.72), sources: [s, s2, 'Wind model'] });
        c.incident({ title: `Chemical plume indication · ${c.loc.short}`, category: 'chem', severity: c.run.severity, sensors: [s, s2], checklist: CHEM_CHECKLIST });
        c.timeline('detect', 'VOC anomaly identified', 'Fusion engine', `${s} above baseline`, c.vars.detectedAt);
        c.timeline('ai', 'Plume model correlation', 'Fusion engine', c.windText());
        c.check('wind');
      },
    },
    {
      at: 15,
      run: (c) => {
        c.orbitUav(`Plume survey · ${c.loc.short}`);
        c.event({ category: 'asset', tone: 'info', title: 'UAV-01 re-tasked', detail: 'Aerial plume survey orbit', focus: UAV });
        c.timeline('asset', 'UAV-01 aerial survey', 'Response coordinator');
        c.check('aerial');
      },
    },
    {
      at: 19,
      run: (c) => {
        const r = c.dispatchUgv(`Mobile sampling · ${c.loc.short}`);
        c.event({ category: 'asset', tone: 'info', title: 'UGV-01 dispatched', detail: `Mobile sampling · ${Math.round(r.distance)} m · ETA ${fmtDuration(r.duration)}`, focus: UGV });
        c.timeline('asset', 'UGV-01 assigned', 'Response coordinator', `Route ${Math.round(r.distance)} m`);
        c.check('dispatch');
      },
    },
    {
      when: (c) => arrived(c),
      run: (c) => {
        const v = (c.sensor(c.loc.sensors.chem[0]) ?? 0.4) * 1.35;
        c.event({ category: 'chem', tone: 'warn', title: 'UGV-01 PID sample', detail: `${v.toFixed(2)} ppm VOC at plume edge`, confidence: conf(c, 0.84), focus: UGV });
        c.evidence({ source: 'UGV-01 PID', sourceKind: 'asset', summary: 'Mobile sample confirms elevated VOC at plume edge', value: `${v.toFixed(2)} ppm`, weight: 0.5 });
        c.timeline('evidence', 'Mobile sample available', 'UGV-01', `${v.toFixed(2)} ppm VOC`);
        c.observe({ confidence: conf(c, 0.86) });
      },
    },
    {
      when: (c) => arrived(c, 6000),
      run: (c) => {
        const pct = Math.round(conf(c, 0.86) * 100);
        c.event({ category: 'ai', tone: 'watch', title: 'Human validation required', detail: `2 sensors + UGV sample + wind model · confidence ${pct}%`, confidence: pct / 100, focus: loc(c) });
        c.timeline('ai', 'Human review requested', 'Fusion engine', 'Shelter-in-place advisory review suggested');
        c.observe({ status: 'validation' });
      },
    },
  ];
}

function biologicalScript(): ScriptStep[] {
  return [
    { at: 0, run: (c) => void c.effect('bio', { amplitude: 38 * c.sev, sigma: 110, ramp: 45 }) },
    {
      at: 9,
      run: (c) => {
        const s = c.loc.sensors.bio[0];
        c.vars.detectedAt = c.now();
        c.event({ category: 'bio', tone: 'watch', title: 'Aerosol particle count elevated', detail: `${s} · screening only · lab confirmation required`, confidence: conf(c, 0.5), focus: sensorFocus(s) });
        c.observation({
          title: 'Aerosol screening anomaly',
          summary: `${s} particle-size trigger is above its background band. Screening result only — laboratory confirmation is required before any conclusion.`,
          category: 'bio',
          status: 'monitoring',
          confidence: conf(c, 0.5),
          sources: [s],
          recommended: [
            'Treat as a screening result only — await lab confirmation',
            'Review HVAC intake status for the admin block',
            `Track ${s} trend for 15 minutes`,
            'Record operator validation decision',
          ],
          evidence: [{ source: s, sourceKind: 'sensor', summary: 'Particle count above seasonal background band', value: `${Math.round(c.sensor(s) ?? 0)} / 100`, weight: 0.5 }],
        });
      },
    },
    {
      at: 14,
      run: (c) => {
        const s = c.loc.sensors.bio[0];
        c.addSamples(1);
        c.event({ category: 'bio', tone: 'info', title: 'Sample collected', detail: `${s} cartridge sealed · awaiting lab`, focus: sensorFocus(s) });
        c.evidence({ source: `${s} sampler`, sourceKind: 'lab', summary: 'Automatic sampler collected filter cartridge', value: 'Pending lab', weight: 0.15 });
        c.incident({ title: `Aerosol screening anomaly · ${c.loc.short}`, category: 'bio', severity: c.run.severity === 'high' ? 'moderate' : 'low', sensors: [s], checklist: BIO_CHECKLIST });
        c.timeline('detect', 'Aerosol anomaly identified', 'Fusion engine', `${s} above background`, c.vars.detectedAt);
        c.timeline('evidence', 'Sample collected', s, 'Awaiting lab confirmation');
        c.check('sample');
        c.observe({ status: 'review', confidence: conf(c, 0.55) });
      },
    },
    {
      at: 18,
      run: (c) => {
        c.orbitUav(`Rooftop check · ${c.loc.short}`);
        c.event({ category: 'asset', tone: 'info', title: 'UAV-01 re-tasked', detail: 'Visual check of rooftop intakes', focus: UAV });
        c.timeline('asset', 'UAV-01 visual check', 'Response coordinator');
      },
    },
    {
      at: 23,
      run: (c) => {
        c.assignTeam('Sample transfer to lab');
        c.event({ category: 'asset', tone: 'info', title: 'Survey team assigned', detail: 'Sample transfer to laboratory', focus: { kind: 'asset', id: 'TEAM-1' } });
        c.timeline('asset', 'Survey team assigned', 'Response coordinator', 'Sample transfer to laboratory');
        c.check('lab');
      },
    },
    {
      at: 40,
      run: (c) => {
        const pct = Math.round(conf(c, 0.58) * 100);
        c.event({ category: 'ai', tone: 'watch', title: 'Human validation required', detail: `Screening only · confidence ${pct}% · lab pending`, confidence: pct / 100, focus: loc(c) });
        c.timeline('ai', 'Human review requested', 'Fusion engine', 'Screening result — lab confirmation pending');
        c.observe({ status: 'validation', confidence: conf(c, 0.58) });
      },
    },
  ];
}

function degradedScript(): ScriptStep[] {
  const dropped = ['RAD-S10', 'RAD-S12', 'RAD-S11', 'AIR-C05', 'BIO-A11'];
  return [
    { at: 0, run: (c) => void c.effect('dropout', { amplitude: 1, sigma: 0, ramp: 1, sensors: dropped, delays: [0, 3, 5, 8, 11] }) },
    {
      at: 2,
      run: (c) => {
        c.vars.detectedAt = c.now();
        c.event({ category: 'system', tone: 'warn', title: 'Telemetry dropout detected', detail: `${dropped[0]} not reporting · Sector A`, focus: sensorFocus(dropped[0]) });
      },
    },
    {
      at: 6,
      run: (c) => {
        c.setFeedStale('CAM-02', true);
        c.event({ category: 'system', tone: 'warn', title: 'CAM-02 stream stale', detail: 'Last frame held · failover pending', focus: { kind: 'location', x: 452, z: 205, label: 'Service yard' } });
      },
    },
    {
      at: 12,
      run: (c) => {
        c.event({ category: 'system', tone: 'warn', title: 'Sensor network degraded', detail: `${dropped.length} sources offline in Sector A · comms 3/4`, focus: { kind: 'zone', id: 'SEC-A' } });
        c.observation({
          title: 'Communication dropout pattern',
          summary: 'Dropouts are clustered on one network segment in Sector A and are not accompanied by any correlated CBRN rise on neighbouring sensors.',
          category: 'network',
          status: 'review',
          confidence: 0.77,
          sources: [...dropped.slice(0, 3), 'Network monitor'],
          recommended: ['Check network segment status (Sector A)', 'Keep UGV-01 mobile coverage until links restore', 'Raise maintenance ticket for CAM-02 stream', 'Record operator assessment'],
          evidence: [
            { source: 'Network monitor', sourceKind: 'network', summary: 'Dropouts share one synthetic network segment', value: '5 sources', weight: 0.55 },
            { source: 'RAD-S15', sourceKind: 'sensor', summary: 'No correlated rise on neighbouring monitors', value: 'Nominal', weight: 0.3 },
          ],
        });
        c.incident({ title: 'Sensor network degradation · Sector A', category: 'network', severity: 'low', sensors: dropped, checklist: NET_CHECKLIST });
        c.timeline('detect', 'Telemetry dropout identified', 'Network monitor', `${dropped[0]} not reporting`, c.vars.detectedAt);
        c.timeline('system', 'CAM-02 stream stale', 'Video management');
      },
    },
    {
      at: 18,
      run: (c) => {
        const r = c.dispatchUgv('Mobile sensing · Sector A');
        c.event({ category: 'asset', tone: 'info', title: 'UGV-01 dispatched', detail: `Temporary coverage · ${Math.round(r.distance)} m · ETA ${fmtDuration(r.duration)}`, focus: UGV });
        c.timeline('asset', 'UGV-01 assigned', 'Response coordinator', 'Mobile sensing coverage');
        c.check('dispatch');
      },
    },
    {
      when: (c) => arrived(c),
      run: (c) => {
        c.event({ category: 'asset', tone: 'ok', title: 'UGV-01 providing mobile coverage', detail: 'Gamma / VOC readings streaming from Sector A', confidence: 0.92, focus: UGV });
        c.evidence({ source: 'UGV-01', sourceKind: 'asset', summary: 'Mobile readings nominal inside the dropout area', value: 'Nominal', weight: 0.4 });
        c.timeline('evidence', 'Mobile coverage restored', 'UGV-01');
        c.observe({ confidence: 0.82, status: 'validation' });
      },
    },
  ];
}

function thermalScript(): ScriptStep[] {
  return [
    { at: 0, run: (c) => void c.effect('thermal', { amplitude: 30 * c.sev, sigma: 6, ramp: 40 }) },
    {
      at: 10,
      run: (c) => {
        c.vars.detectedAt = c.now();
        c.event({ category: 'asset', tone: 'warn', title: 'UAV-01 thermal anomaly flagged', detail: `${c.loc.equipment} · elevated surface temperature`, confidence: conf(c, 0.66), focus: loc(c) });
        c.observation({
          title: 'Thermal anomaly on equipment',
          summary: `Aerial thermal pass indicates an elevated surface temperature at ${c.loc.equipment.toLowerCase()}. No correlated CBRN readings so far.`,
          category: 'thermal',
          status: 'monitoring',
          confidence: conf(c, 0.66),
          sources: ['UAV-01 thermal'],
          recommended: ['Review equipment load and cooling status', 'Keep UGV-01 thermal watch until the temperature trends down', 'Notify electrical maintenance', 'Record operator validation decision'],
          evidence: [{ source: 'UAV-01 thermal', sourceKind: 'camera', summary: 'Elevated surface temperature in aerial frame', value: 'Above ambient', weight: 0.55 }],
        });
      },
    },
    {
      at: 15,
      run: (c) => {
        c.incident({ title: `Thermal hotspot · ${c.loc.short}`, category: 'thermal', severity: c.run.severity, sensors: [], checklist: THERMAL_CHECKLIST });
        c.timeline('detect', 'Thermal anomaly identified', 'UAV-01', c.loc.equipment, c.vars.detectedAt);
        c.observe({ status: 'review' });
      },
    },
    {
      at: 18,
      run: (c) => {
        const r = c.dispatchUgv(`Thermal inspection · ${c.loc.short}`);
        c.event({ category: 'asset', tone: 'info', title: 'UGV-01 dispatched', detail: `Thermal inspection · ${Math.round(r.distance)} m · ETA ${fmtDuration(r.duration)}`, focus: UGV });
        c.timeline('asset', 'UGV-01 assigned', 'Response coordinator', `Route ${Math.round(r.distance)} m`);
        c.check('dispatch');
      },
    },
    {
      at: 21,
      run: (c) => {
        c.orbitUav(`Thermal overwatch · ${c.loc.short}`);
        c.timeline('asset', 'UAV-01 overwatch orbit', 'Response coordinator');
      },
    },
    {
      when: (c) => arrived(c),
      run: (c) => {
        const temp = c.hotspotTemp();
        c.event({ category: 'asset', tone: 'warn', title: 'UGV thermal frame analysed', detail: `${c.loc.equipment} · ${temp.toFixed(1)} °C (+${(temp - c.ambient()).toFixed(0)} °C vs ambient)`, confidence: conf(c, 0.86), focus: UGV });
        c.evidence({ source: 'UGV-01 thermal', sourceKind: 'camera', summary: 'Ground-level thermal frame confirms hotspot', value: `${temp.toFixed(1)} °C`, weight: 0.6 });
        c.evidence({ source: 'RAD-S18 · AIR-C09', sourceKind: 'sensor', summary: 'No correlated radiological or chemical rise', value: 'Nominal', weight: 0.2 });
        c.timeline('evidence', 'Thermal inspection available', 'UGV-01', `${temp.toFixed(1)} °C surface`);
        c.observe({ confidence: conf(c, 0.84), sources: ['UAV-01 thermal', 'UGV-01 thermal', 'RAD-S18'] });
      },
    },
    {
      when: (c) => arrived(c, 6000),
      run: (c) => {
        const pct = Math.round(conf(c, 0.84) * 100);
        c.event({ category: 'ai', tone: 'watch', title: 'Human validation required', detail: `Thermal-only anomaly · confidence ${pct}%`, confidence: pct / 100, focus: loc(c) });
        c.timeline('ai', 'Human review requested', 'Fusion engine', 'Electrical maintenance review suggested');
        c.observe({ status: 'validation' });
      },
    },
  ];
}

const TEAM: FocusTarget = { kind: 'asset', id: 'TEAM-1' };
const plan = (c: ScriptContext) => c.vars.plan as FirePlanTimes | undefined;
const after = (c: ScriptContext, key: keyof FirePlanTimes, delayMs = 0) => {
  const p = plan(c);
  return !!p && c.now() >= p[key] + delayMs;
};

/**
 * Fire response, end to end: a generator skid in the service yard catches fire. CAM-02 analytics see the
 * smoke, personnel withdraw upwind, the robot dog is sent with its water-mist payload while UAV-01 circles
 * low, the robot confirms the flames on camera, knocks the fire down, walks through the inflatable
 * decontamination shelter, recharges at its dock, and the incident closes itself once everyone is back.
 */
function fireScript(): ScriptStep[] {
  const site = FIRE_SITE;
  const tentFocus: FocusTarget = { kind: 'location', x: site.tent.x, z: site.tent.z, label: 'DECON-1', radius: 60 };
  return [
    {
      at: 0,
      run: (c) => {
        c.vars.fireId = c.effect('fire', { amplitude: 560 * c.sev, sigma: 2.6, ramp: 16, x: site.fire.x, z: site.fire.z }).id;
      },
    },
    {
      at: 3,
      run: (c) => {
        c.vars.detectedAt = c.now();
        c.event({ category: 'fire', tone: 'warn', title: 'CAM-02 analytics: smoke detected', detail: `${c.loc.equipment} · service yard`, confidence: 0.88, focus: loc(c) });
        c.observation({
          title: 'Fire at generator skid',
          summary: `CAM-02 video analytics show smoke rising from ${c.loc.equipment.toLowerCase()} in the service yard. Robot and UAV confirmation requested before suppression.`,
          category: 'fire',
          status: 'review',
          confidence: 0.88,
          sources: ['CAM-02 analytics'],
          recommended: [
            'Withdraw service-yard personnel to assembly point AP-2 (upwind)',
            'Send UGV-01 with the water-mist payload to the upwind stand-off',
            'Hold UAV-01 in a low thermal orbit over the skid',
            'Decontaminate UGV-01 at DECON-1 before it returns to the dock',
          ],
          evidence: [{ source: 'CAM-02', sourceKind: 'camera', summary: 'Smoke plume over the generator skid', value: 'Smoke 88%', weight: 0.5 }],
        });
        c.incident({ title: `Fire · ${c.loc.equipment}`, category: 'fire', severity: c.run.severity, sensors: [], checklist: FIRE_CHECKLIST });
        c.timeline('detect', 'Smoke detected over the generator skid', 'CAM-02 analytics', c.loc.equipment, c.vars.detectedAt);
        c.check('detect');
      },
    },
    {
      at: 5,
      run: (c) => {
        const arrive = c.teamMuster(site.assembly, site.fire, 'Assembly point AP-2');
        c.vars.musteredAt = arrive;
        c.event({ category: 'system', tone: 'warn', title: 'Personnel withdrawing to AP-2', detail: 'Survey Team · assembly point upwind of the yard', focus: TEAM });
        c.timeline('operator', 'Service yard cleared · personnel to AP-2', 'Shift supervisor');
      },
    },
    {
      at: 6,
      run: (c) => {
        const r = c.ugvRespond(site.standoff, site.fire, `Fire response · ${c.loc.equipment}`, 9);
        c.event({ category: 'asset', tone: 'info', title: 'UGV-01 dispatched · water-mist payload', detail: `${Math.round(r.distance)} m · ETA ${fmtDuration(r.duration)}`, focus: UGV });
        c.timeline('asset', 'UGV-01 assigned · suppression payload', 'Response coordinator', `Route ${Math.round(r.distance)} m · upwind stand-off`);
      },
    },
    {
      at: 8,
      run: (c) => {
        c.orbitUav(`Thermal overwatch · ${c.loc.short}`, site.fire.x, site.fire.z, { r: 46, alt: 36, speed: 11 });
        c.event({ category: 'asset', tone: 'info', title: 'UAV-01 circling the fire', detail: 'Low orbit · thermal mapping of the skid', focus: UAV });
        c.timeline('asset', 'UAV-01 low thermal orbit', 'Response coordinator');
      },
    },
    {
      at: 10,
      run: (c) => {
        c.vars.tentId = c.effect('decon', { amplitude: 1, sigma: 5, ramp: 9, x: site.tent.x, z: site.tent.z }).id;
        c.event({ category: 'system', tone: 'info', title: 'DECON-1 deploying', detail: 'Inflatable decontamination shelter · west of the robotics garage', focus: tentFocus });
        c.timeline('system', 'Decontamination line DECON-1 set up', 'Response coordinator');
      },
    },
    {
      when: (c) => c.vars.musteredAt !== undefined && c.now() >= (c.vars.musteredAt as number),
      run: (c) => {
        c.event({ category: 'system', tone: 'ok', title: 'Personnel accounted for at AP-2', detail: '3 / 3 · upwind of the fire', focus: TEAM });
        c.timeline('operator', 'Personnel accounted for · 3 / 3', 'Shift supervisor');
        c.check('protect');
      },
    },
    {
      // the robot sees it: its camera has the skid in view on the approach
      when: (c) => c.vars.dispatchedAt !== undefined && c.ugvDistanceTo(site.fire.x, site.fire.z) < 64,
      run: (c) => {
        const temp = c.fireTemp();
        c.event({ category: 'fire', tone: 'critical', title: 'UGV-01 confirms open flame', detail: `Fire 97% · ${temp.toFixed(0)} °C on ${c.loc.equipment.toLowerCase()}`, confidence: 0.97, focus: UGV });
        c.evidence({ source: 'UGV-01 camera', sourceKind: 'camera', summary: 'Open flame on the generator skid', value: 'Fire 97%', weight: 0.62 });
        c.evidence({ source: 'UAV-01 thermal', sourceKind: 'camera', summary: 'Flame temperature from the overwatch orbit', value: `${temp.toFixed(0)} °C`, weight: 0.55 });
        c.observe({ confidence: 0.97, status: 'validation', sources: ['CAM-02 analytics', 'UGV-01 camera', 'UAV-01 thermal'] });
        c.timeline('detect', 'Fire confirmed by UGV-01 camera', 'UGV-01', `${temp.toFixed(0)} °C`);
      },
    },
    {
      when: (c) => arrived(c),
      run: (c) => {
        const times = c.ugvFirePlan({ target: site.fire, toTent: [...site.toTent], toDock: [...site.toDock], spray: 15, wash: 16, charge: 14 });
        c.vars.plan = times;
        // the flames start dying as soon as water reaches them
        c.endEffect(c.vars.fireId as string, times.sprayStart + 1200, 9);
        c.timeline('operator', 'Suppression authorised', 'Shift supervisor', 'UGV-01 water mist from the upwind stand-off');
        c.observe({ status: 'validated' });
        c.event({ category: 'fire', tone: 'warn', title: 'UGV-01 suppressing · water mist', detail: 'Upwind stand-off · 12 m from the skid', focus: UGV });
        c.check('dispatch');
      },
    },
    {
      when: (c) => after(c, 'sprayStart', 7000),
      run: (c) => {
        c.event({ category: 'fire', tone: 'watch', title: 'Fire knocked down', detail: `Flames out · ${c.fireTemp().toFixed(0)} °C and falling`, confidence: 0.94, focus: loc(c) });
        c.timeline('evidence', 'Knock-down confirmed on UAV-01 thermal', 'UAV-01');
      },
    },
    {
      when: (c) => after(c, 'sprayEnd'),
      run: (c) => {
        c.event({ category: 'fire', tone: 'ok', title: 'Fire extinguished', detail: `Skid surface ${c.fireTemp().toFixed(0)} °C · steam only`, confidence: 0.96, focus: loc(c) });
        c.timeline('evidence', 'Fire extinguished · surface cooling', 'UGV-01');
        c.check('suppress');
      },
    },
    {
      when: (c) => after(c, 'deconStart'),
      run: (c) => {
        c.event({ category: 'asset', tone: 'info', title: 'UGV-01 in DECON-1', detail: 'Wash cycle · soot and runoff contained', focus: tentFocus });
        c.timeline('asset', 'UGV-01 entered DECON-1', 'UGV-01');
      },
    },
    {
      when: (c) => after(c, 'deconEnd'),
      run: (c) => {
        c.event({ category: 'asset', tone: 'ok', title: 'Decontamination complete', detail: 'UGV-01 swab clear · leaving by the clean side', focus: UGV });
        c.timeline('asset', 'UGV-01 decontaminated', 'DECON-1');
        c.check('decon');
      },
    },
    {
      when: (c) => after(c, 'chargeStart'),
      run: (c) => {
        c.event({ category: 'asset', tone: 'info', title: 'UGV-01 docked · recharging', detail: 'Robotics apron dock', focus: UGV });
        c.uavResume();
        c.teamRelease();
        c.event({ category: 'system', tone: 'ok', title: 'Personnel returning to the yard', detail: 'All clear from the fire scene', focus: TEAM });
        c.timeline('operator', 'All clear · personnel back to routine', 'Shift supervisor');
      },
    },
    {
      when: (c) => after(c, 'chargeEnd', 2500),
      run: (c) => {
        c.check('recover');
        c.timeline('system', 'Recovery complete', 'Response coordinator', 'Fire out · UGV-01 decontaminated and recharged · personnel back to routine');
        c.endEffect(c.vars.tentId as string, c.now() + 15000, 8);
        c.resolveScenario('Fire out · robot decontaminated · area recovered');
      },
    },
  ];
}

export function buildScript(preset: ScenarioId): ScriptStep[] {
  switch (preset) {
    case 'radiological':
      return radiologicalCore(false);
    case 'multi':
      return radiologicalCore(true);
    case 'chemical':
      return chemicalScript();
    case 'biological':
      return biologicalScript();
    case 'degraded':
      return degradedScript();
    case 'thermal':
      return thermalScript();
    case 'fire':
      return fireScript();
    default:
      return [];
  }
}

// ------------------------------------------------------------------------------------------------
// Routine (non-alert) activity for normal operations
// ------------------------------------------------------------------------------------------------

export interface RoutineEvent extends EventSpec {
  focusAsset?: AssetId;
}

export function routineEvents(windText: string, sensorId: string, checkpoint: number): RoutineEvent[] {
  return [
    { category: 'asset', tone: 'ok', title: 'PPE check complete', detail: '2 persons detected in service yard · PPE compliant', confidence: 0.97, focus: { kind: 'location', x: 452, z: 205, label: 'Service yard', radius: 60 } },
    { category: 'asset', tone: 'info', title: 'UAV-01 perimeter pass complete', detail: 'No anomalies flagged on coastal sector', confidence: 0.94, focus: UAV },
    { category: 'system', tone: 'info', title: 'Sensor self-test passed', detail: `${sensorId} · drift within tolerance`, focus: sensorFocus(sensorId) },
    { category: 'system', tone: 'info', title: 'Telemetry integrity check', detail: '196/200 sources nominal · 4 in scheduled maintenance' },
    { category: 'asset', tone: 'info', title: 'UGV-01 patrol checkpoint', detail: `Checkpoint ${checkpoint} reached · route nominal`, focus: UGV },
    { category: 'system', tone: 'info', title: 'Wind model updated', detail: windText },
    { category: 'rad', tone: 'ok', title: 'Dosimeter network sync', detail: '48/48 personal dosimeters reporting' },
    { category: 'chem', tone: 'ok', title: 'Gas network baseline confirmed', detail: '24/24 VOC sensors within baseline band' },
    { category: 'bio', tone: 'ok', title: 'Aerosol background update', detail: 'Particle counts within seasonal background' },
    { category: 'ai', tone: 'info', title: 'Fusion model heartbeat', detail: 'No anomalies above review threshold', confidence: 0.96 },
  ];
}

export const windText = (dir: number, speed: number) => `${compassLabel(dir)} ${Math.round(speed)} km/h`;
