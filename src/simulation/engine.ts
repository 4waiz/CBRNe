import type {
  AssetId,
  AssetState,
  ChecklistItem,
  Evidence,
  Incident,
  Metrics,
  Observation,
  ResponseKpis,
  ScenarioParams,
  ScenarioRun,
  SensorState,
  SensorStatus,
  Severity,
  SimEvent,
  SystemHealthLevel,
  TimelineKind,
  Vec2,
} from '../types';
import { useSim } from '../store/sim';
import { SENSORS, NETWORK } from './sensors';
import { type Effect, type EffectKind, envelope, isEffectLive, radField, chemField, bioField } from './effects';
import { LOCATIONS, LOCATION_BY_ID, type ScenarioLocation } from './locations';
import { WeatherModel } from './weather';
import { ROADS, UgvController, UavController, TeamController, RESPONSE_VEHICLE_POSE, type Pose } from './assets';
import { history, HISTORY_CAPACITY } from './history';
import {
  buildScript,
  FIXED_LOCATION,
  PRESET_BY_ID,
  SEVERITY_FACTOR,
  routineEvents,
  windText,
  type IncidentSpec,
  type ObservationSpec,
  type ScriptContext,
  type ScriptStep,
  type ScriptVars,
  type EventSpec,
} from './scenarios';
import { SeededRandom } from '../utils/random';
import { clamp, smoothstep } from '../utils/math';
import { zoneAt } from '../data/site';

const TICK_MS = 1000;
const MAX_EVENTS = 240;
/** Record caps for long-running sessions; open records are never dropped, the oldest closed ones go first. */
const MAX_INCIDENTS = 60;
const MAX_OBSERVATIONS = 60;
const MAX_NOTE_LENGTH = 280;

/** Trims a newest-first record list to `max`, dropping the oldest closed records first. */
function capRecords<T>(list: T[], max: number, closed: (x: T) => boolean): T[] {
  let excess = list.length - max;
  if (excess <= 0) return list;
  const drop = new Set<T>();
  for (let i = list.length - 1; i >= 0 && excess > 0; i--) {
    if (closed(list[i])) {
      drop.add(list[i]);
      excess--;
    }
  }
  return drop.size ? list.filter((x) => !drop.has(x)) : list;
}

interface SensorRuntime {
  def: (typeof SENSORS)[number];
  rng: SeededRandom;
  ou: number;
  state: SensorState;
}

const GST = 4 * 3600 * 1000;
const mmdd = (t: number) => {
  const d = new Date(t + GST);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};

export class SimulationEngine {
  readonly bootTime = Date.now();
  now = this.bootTime;
  tickIndex = 0;
  readonly weather = new WeatherModel();
  readonly ugv: UgvController;
  readonly uav: UavController;
  readonly team: TeamController;
  effects: Effect[] = [];
  runs: ScenarioRun[] = [];
  activeRun: ScenarioRun | null = null;
  events: SimEvent[] = [];
  incidents: Incident[] = [];
  observations: Observation[] = [];

  private timer: ReturnType<typeof setInterval> | null = null;
  private autoplayTimer: ReturnType<typeof setTimeout> | null = null;
  private steps: ScriptStep[] = [];
  private ctx: ScriptContext | null = null;
  private sensorsRt = new Map<string, SensorRuntime>();
  private seq = { event: 0, incident: 0, obs: 27, entry: 0, run: 0, effect: 0 };
  private samplesPending = 2;
  private nextRoutineAt = 0;
  private routineCursor = 0;
  private rng = new SeededRandom('encirra-engine');
  private feedStale: Record<string, number | null> = { 'CAM-01': null, 'CAM-02': null, 'UGV-01': null, 'UAV-01': null };
  private teamTask: string | null = null;
  private ugvBattery = 86;
  private lastStepAt = 0;
  private started = false;
  private endedRunsNotified = new Set<string>();

  constructor() {
    const t0 = this.bootTime - HISTORY_CAPACITY * 1000;
    this.ugv = new UgvController(t0);
    this.ugv.segments[0] = { type: 'patrol', t0, s0: 905 - 3.6 * HISTORY_CAPACITY, speed: 3.6 };
    this.uav = new UavController(t0);
    this.uav.segments[0] = { type: 'perimeter', t0, s0: 2450 - 17 * HISTORY_CAPACITY, speed: 17, alt: 118 };
    this.team = new TeamController(t0);
    for (const def of SENSORS) {
      this.sensorsRt.set(def.id, {
        def,
        rng: new SeededRandom(`sensor:${def.id}`),
        ou: 0,
        state: { id: def.id, value: def.baseline, status: 'online', trend: 0, sigma: 0, updatedAt: t0, quality: 0.98 },
      });
    }
  }

  // ------------------------------------------------------------------------------------------ lifecycle

  start() {
    if (this.started) return;
    this.started = true;
    // backfill 30 minutes of synthetic history so charts open fully populated
    for (let i = HISTORY_CAPACITY; i >= 1; i--) {
      const t = this.bootTime - i * TICK_MS;
      this.step(t, false);
      if (i % 113 === 0 && i < 1300) this.emitRoutine(t);
    }
    this.nextRoutineAt = this.bootTime + 9000;
    this.step(Date.now(), true);
    this.publish();
    this.timer = setInterval(() => {
      this.step(Date.now(), true);
      this.publish();
    }, TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.autoplayTimer) clearTimeout(this.autoplayTimer);
    this.timer = null;
  }

  scheduleAutoplay(delayMs: number) {
    if (this.autoplayTimer) clearTimeout(this.autoplayTimer);
    this.autoplayTimer = setTimeout(() => {
      if (!this.activeRun) {
        this.trigger({
          preset: 'multi',
          severity: 'low',
          locationId: 'U3-EAST',
          windDir: this.weather.baseDir,
          windSpeed: this.weather.baseSpeed,
          duration: 0,
        });
      }
    }, delayMs);
  }

  cancelAutoplay() {
    if (this.autoplayTimer) clearTimeout(this.autoplayTimer);
    this.autoplayTimer = null;
  }

  // ------------------------------------------------------------------------------------------ simulation step

  private step(t: number, live: boolean) {
    const dt = this.lastStepAt ? clamp((t - this.lastStepAt) / 1000, 0.2, 5) : 1;
    this.lastStepAt = t;
    this.now = t;
    this.tickIndex++;
    this.weather.step(t, dt);
    const wind = this.weather.windState();
    const liveEffects = this.effects.filter((e) => isEffectLive(e, t));
    const envs = new Map<Effect, number>(liveEffects.map((e) => [e, envelope(e, t)]));

    // ---- sensors
    for (const rt of this.sensorsRt.values()) {
      const d = rt.def;
      rt.ou += -0.15 * rt.ou * dt + d.noise * 0.55 * Math.sqrt(dt) * rt.rng.gauss();
      let v = d.kind === 'met' ? this.weather.current.windSpeed + rt.ou * 0.3 : d.baseline + rt.ou;
      for (const e of liveEffects) {
        const env = envs.get(e) ?? 0;
        if (e.kind === 'rad' && d.kind === 'rad') v += radField(e, d.x, d.z, wind, env);
        else if (e.kind === 'chem' && d.kind === 'chem') v += chemField(e, d.x, d.z, wind, env, t);
        else if (e.kind === 'bio' && d.kind === 'bio') v += bioField(e, d.x, d.z, wind, env);
      }
      v = d.kind === 'bio' ? clamp(v, 0, 100) : Math.max(0, v);
      const offline = liveEffects.some((e) => {
        if (e.kind !== 'dropout' || !e.sensors) return false;
        const idx = e.sensors.indexOf(d.id);
        if (idx < 0) return false;
        const from = e.t0 + (e.delays?.[idx] ?? 0) * 1000;
        return t >= from && (e.endAt === null || t < e.endAt + (e.delays?.[idx] ?? 0) * 400);
      });
      const series = history.series(`sensor:${d.id}`);
      if (offline) {
        rt.state = { ...rt.state, value: null, status: 'offline', quality: 0 };
        series.push(t, Number.NaN);
        continue;
      }
      const past = series.valueAtTime(t - 300_000);
      const trend = past && Number.isFinite(past) && past > 0 ? ((v - past) / past) * 100 : 0;
      const status: SensorStatus = d.kind === 'met' ? 'online' : v >= d.alertAt ? 'alert' : v >= d.reviewAt ? 'elevated' : 'online';
      rt.state = {
        id: d.id,
        value: v,
        status,
        trend,
        sigma: (v - d.baseline) / Math.max(1e-6, d.noise),
        updatedAt: t,
        quality: clamp(0.97 + rt.rng.range(-0.02, 0.02), 0, 1),
      };
      series.push(t, v);
    }

    // ---- assets (arrival detection first so scripts see it this tick)
    if (live) this.updateAssets(t, dt);

    // ---- scenario scripts
    if (live && this.activeRun && this.ctx) {
      const run = this.activeRun;
      for (const s of this.steps) {
        // a step may close the run (the fire response resolves itself): stop there
        if (this.activeRun !== run || !this.ctx) break;
        if (s.done) continue;
        const due = s.at !== undefined ? t >= run.startedAt + s.at * 1000 : s.when ? s.when(this.ctx) : false;
        if (due) {
          s.done = true;
          s.run(this.ctx);
        }
      }
      if (this.activeRun === run && this.ctx && run.endsAt !== null && t >= run.endsAt && !this.endedRunsNotified.has(run.runId)) {
        this.endedRunsNotified.add(run.runId);
        for (const e of this.effects) if (e.runId === run.runId && e.endAt === null) e.endAt = run.endsAt;
        this.pushEvent({ category: 'system', tone: 'ok', title: 'Readings returning to baseline', detail: `${PRESET_BY_ID[run.preset].label} conditions easing`, incidentId: this.ctx.vars.incidentId });
        if (this.ctx.vars.incidentId) this.addTimeline(this.ctx.vars.incidentId, 'system', 'Readings returning to baseline', 'Fusion engine');
      }
    }

    // ---- routine (non-alert) activity
    if (live && t >= this.nextRoutineAt) {
      const quiet = !this.activeRun;
      if (quiet || this.rng.float() < 0.35) this.emitRoutine(t);
      this.nextRoutineAt = t + this.rng.range(24000, 42000);
    }

    // ---- auto checklist: personnel accountability completes once head-count recovers
    if (live) {
      for (const inc of this.incidents) {
        if (inc.status === 'resolved') continue;
        const item = inc.checklist.find((c) => c.id === 'personnel');
        if (item && !item.done && t - inc.createdAt > 56000) this.setChecklist(inc.id, 'personnel', true, false);
      }
    }

    // ---- bounded memory: prune vehicle plans and closed records once a minute
    if (live && this.tickIndex % 60 === 0) this.pruneRecords(t);

    // ---- aggregates
    const metrics = this.computeMetrics(t);
    const kpis = this.computeKpis(t);
    history.push('voc', t, metrics.voc);
    history.push('aerosol', t, metrics.aerosol);
    history.push('gamma', t, metrics.gamma);
    history.push('readiness', t, metrics.readiness);
    history.push('sensorsOnline', t, metrics.sensorsOnline);
    history.push('gasOnline', t, metrics.gasOnline);
    history.push('dosimeters', t, metrics.dosimetersOnline);
    history.push('commsUp', t, metrics.commsUp);
    history.push('checklist', t, metrics.checklistPct);
    history.push('samples', t, metrics.samplesPending);
    history.push('ppe', t, metrics.ppe);
    history.push('videoUp', t, metrics.videoUp);
    history.push('latency', t, metrics.latencyMs);
    history.push('networkHealth', t, metrics.networkHealth);
    history.push('chemAlerts', t, metrics.chemAlerts);
    history.push('radAlerts', t, metrics.radAlerts);
    history.push('bioAlerts', t, metrics.bioAlerts);
    history.push('coverage', t, kpis.remoteCoverage);
    history.push('personnel', t, kpis.personnelPct);
    history.push('openActions', t, kpis.openActions);
    history.push('ack', t, kpis.ackSeconds ?? 0);
    history.push('windDir', t, this.weather.smoothDir);
    history.push('windSpeed', t, this.weather.current.windSpeed);
    history.push('temperature', t, this.weather.current.temperature);
    for (const o of this.observations) {
      if (o.status !== 'cleared') history.push(`obs:${o.id}`, t, o.confidence);
    }
    this.lastMetrics = metrics;
    this.lastKpis = kpis;
  }

  private lastMetrics: Metrics | null = null;
  private lastKpis: ResponseKpis | null = null;

  private pruneRecords(t: number) {
    const before = t - HISTORY_CAPACITY * 1000;
    this.ugv.prune(before);
    this.uav.prune(before);
    this.team.prune(before);
    this.incidents = capRecords(this.incidents, MAX_INCIDENTS, (i) => i.status === 'resolved');
    const kept = capRecords(this.observations, MAX_OBSERVATIONS, (o) => o.status === 'cleared' || o.status === 'validated');
    if (kept !== this.observations) {
      const ids = new Set(kept.map((o) => o.id));
      for (const o of this.observations) if (!ids.has(o.id)) history.delete(`obs:${o.id}`);
      this.observations = kept;
    }
  }

  private updateAssets(t: number, dt: number) {
    const seg = this.ugv.current(t);
    if (seg.type === 'route' && seg.purpose === 'inspect') {
      const arrival = seg.t0 + seg.duration * 1000;
      if (t >= arrival) {
        this.ugv.hold(arrival, 'inspecting', seg.label, seg.lookAt);
        if (this.ctx && this.ctx.vars.dispatchedAt !== undefined && this.ctx.vars.dispatchedAt <= seg.t0 + 1) {
          this.ctx.vars.arrivedAt = arrival;
        }
      }
    }
    // fire response: the script schedules what happens at the stand-off, so arrival is only reported
    if (this.ctx && seg.type === 'route' && seg.purpose === 'respond' && t >= seg.t0 + seg.duration * 1000 && this.ctx.vars.arrivedAt === undefined) {
      if (this.ctx.vars.dispatchedAt !== undefined && this.ctx.vars.dispatchedAt <= seg.t0 + 1) this.ctx.vars.arrivedAt = seg.t0 + seg.duration * 1000;
    }
    const p = this.ugv.pose(t);
    if (seg.type === 'charge') this.ugvBattery = clamp(this.ugvBattery + dt * 0.9, 18, 100);
    else this.ugvBattery = clamp(this.ugvBattery - dt * (p.speed > 0.4 ? 0.011 * (p.speed > 6 ? 2.2 : 1) : seg.type === 'suppress' ? 0.02 : 0.002), 18, 100);
  }

  private emitRoutine(t: number) {
    const sensorIds = SENSORS.filter((s) => s.kind !== 'met').map((s) => s.id);
    const pool = routineEvents(
      windText(this.weather.current.windDir, this.weather.current.windSpeed) + ` · stability ${this.weather.current.stability}`,
      sensorIds[this.routineCursor % sensorIds.length],
      (this.routineCursor % 12) + 1,
    );
    const spec = pool[(this.routineCursor * 7) % pool.length];
    this.routineCursor++;
    this.pushEvent(spec, t);
  }

  // ------------------------------------------------------------------------------------------ aggregates

  private computeMetrics(t: number): Metrics {
    let voc = 0;
    let vocSensor = '';
    let aerosol = 0;
    let aerosolSensor = '';
    let gamma = 0;
    let gammaSensor = '';
    let chemAlerts = 0;
    let radAlerts = 0;
    let bioAlerts = 0;
    let chemOff = 0;
    let bioOff = 0;
    let radOff = 0;
    for (const rt of this.sensorsRt.values()) {
      const s = rt.state;
      const k = rt.def.kind;
      if (s.status === 'offline') {
        if (k === 'chem') chemOff++;
        if (k === 'bio') bioOff++;
        if (k === 'rad') radOff++;
        continue;
      }
      const v = s.value ?? 0;
      const flagged = s.status === 'elevated' || s.status === 'alert';
      if (k === 'chem') {
        if (v > voc) (voc = v), (vocSensor = rt.def.id);
        if (flagged) chemAlerts++;
      } else if (k === 'bio') {
        if (v > aerosol) (aerosol = v), (aerosolSensor = rt.def.id);
        if (flagged) bioAlerts++;
      } else if (k === 'rad') {
        if (v > gamma) (gamma = v), (gammaSensor = rt.def.id);
        if (flagged) radAlerts++;
      }
    }
    const dropoutLive = this.effects.some((e) => e.kind === 'dropout' && isEffectLive(e, t) && t >= e.t0 + 2000);
    const stale = Object.values(this.feedStale).filter((v) => v !== null).length;
    const active = this.incidents.filter((i) => i.status !== 'resolved');
    const items = active.flatMap((i) => i.checklist);
    const wobble = (k: number) => Math.sin(t / 47000 + k) * 0.5 + Math.sin(t / 13000 + k * 2.1) * 0.3;
    const offlineCount = chemOff + bioOff + radOff;
    return {
      voc,
      vocSensor,
      gasOnline: NETWORK.gasTotal - chemOff - (dropoutLive ? 1 : 0),
      gasTotal: NETWORK.gasTotal,
      chemAlerts,
      aerosol,
      aerosolSensor,
      samplesPending: this.samplesPending,
      bioOnline: NETWORK.bioTotal - bioOff,
      bioTotal: NETWORK.bioTotal,
      bioAlerts,
      gamma,
      gammaSensor,
      dosimetersOnline: NETWORK.dosimetersTotal - (dropoutLive ? 3 : 0),
      dosimetersTotal: NETWORK.dosimetersTotal,
      radAlerts,
      readiness: clamp(96.1 + wobble(1) * 1.2 - (active.some((i) => i.status === 'new') ? 0.9 : 0), 92, 99),
      commsUp: dropoutLive ? 3 : 4,
      commsTotal: NETWORK.commsTotal,
      checklistPct: items.length ? (items.filter((c) => c.done).length / items.length) * 100 : clamp(94 + wobble(2) * 2, 90, 97),
      drillClosedPct: 92,
      sensorsOnline: NETWORK.sensorsTotal - NETWORK.baselineOffline - offlineCount - (dropoutLive ? 9 : 0),
      sensorsTotal: NETWORK.sensorsTotal,
      videoUp: NETWORK.videoTotal - stale,
      videoTotal: NETWORK.videoTotal,
      staleFeeds: stale,
      ppe: clamp(97 + wobble(3) * 1.4, 94, 99.5),
      networkHealth: clamp((dropoutLive ? 91.4 : 99.2) + wobble(4) * 0.4, 80, 100),
      latencyMs: Math.round((dropoutLive ? 520 : 240) + wobble(5) * 22),
    };
  }

  private computeKpis(t: number): ResponseKpis {
    const active = this.incidents.filter((i) => i.status !== 'resolved').sort((a, b) => b.createdAt - a.createdAt);
    const latest = active[0];
    let ackSeconds: number | null = null;
    let ackRunning = false;
    if (latest) {
      if (latest.acknowledgedAt) ackSeconds = (latest.acknowledgedAt - latest.createdAt) / 1000;
      else {
        ackSeconds = (t - latest.createdAt) / 1000;
        ackRunning = true;
      }
    } else {
      const last = this.incidents.find((i) => i.acknowledgedAt);
      if (last && last.acknowledgedAt) ackSeconds = (last.acknowledgedAt - last.createdAt) / 1000;
    }
    let deficit = 0;
    for (const inc of active) {
      const age = t - inc.createdAt;
      if (age < 60000) deficit = Math.max(deficit, Math.ceil(5 * (1 - smoothstep(0, 56000, age))));
    }
    const present = NETWORK.personnelTotal - deficit;
    const items = active.flatMap((i) => i.checklist).filter((c) => !c.done);
    const ugvSeg = this.ugv.current(t);
    const dropoutLive = this.effects.some((e) => e.kind === 'dropout' && isEffectLive(e, t) && t >= e.t0 + 2000);
    const stale = Object.values(this.feedStale).filter((v) => v !== null).length;
    const coverage = clamp(
      86 + (this.uav.isOrbiting(t) ? 3 : 0) + (ugvSeg.type === 'hold' ? 2 : 0) - stale * 6 - (dropoutLive ? 5 : 0) + Math.sin(t / 31000) * 0.6,
      50,
      99,
    );
    return {
      ackSeconds,
      ackRunning,
      personnelPct: (present / NETWORK.personnelTotal) * 100,
      personnelPresent: present,
      personnelTotal: NETWORK.personnelTotal,
      remoteCoverage: coverage,
      openActions: items.length,
      openHigh: items.filter((c) => c.priority === 'high').length,
      openMedium: items.filter((c) => c.priority !== 'high').length,
    };
  }

  private computeHealth(t: number): { level: SystemHealthLevel; label: string } {
    const active = this.incidents.filter((i) => i.status !== 'resolved');
    const unacked = active.filter((i) => i.status === 'new');
    const dropoutLive = this.effects.some((e) => e.kind === 'dropout' && isEffectLive(e, t) && t >= e.t0 + 2000);
    if (unacked.length) return { level: 'alert', label: `${unacked.length} incident${unacked.length > 1 ? 's' : ''} · ack pending` };
    if (dropoutLive) return { level: 'degraded', label: 'Sensor network degraded' };
    if (active.length) return { level: 'watch', label: `${active.length} incident${active.length > 1 ? 's' : ''} · investigating` };
    if (this.observations.some((o) => o.status === 'monitoring' || o.status === 'review' || o.status === 'validation'))
      return { level: 'watch', label: 'AI observation under review' };
    return { level: 'nominal', label: 'All systems nominal' };
  }

  private assetSnapshot(t: number): Record<AssetId, AssetState> {
    const ugSeg = this.ugv.current(t);
    const ugp = this.ugv.pose(t);
    let status = 'Patrolling';
    let tone: AssetState['tone'] = 'ok';
    let task = 'Perimeter road patrol';
    let eta: number | null = null;
    let distance: number | null = null;
    if (ugSeg.type === 'route') {
      const rem = this.ugv.remaining(t);
      status = ugSeg.purpose === 'inspect' ? 'En route' : 'Returning';
      tone = 'info';
      task = ugSeg.label;
      eta = rem?.eta ?? null;
      distance = rem?.distance ?? null;
    } else if (ugSeg.type === 'hold') {
      status = ugSeg.mode === 'inspecting' ? 'Inspecting' : 'Holding';
      tone = 'watch';
      task = ugSeg.label;
    } else if (ugSeg.type === 'suppress') {
      status = 'Suppressing';
      tone = 'warn';
      task = ugSeg.label;
    } else if (ugSeg.type === 'decon') {
      status = 'Decontaminating';
      tone = 'info';
      task = ugSeg.label;
    } else if (ugSeg.type === 'charge') {
      status = 'Recharging';
      tone = 'info';
      task = ugSeg.label;
    }
    if (ugSeg.type === 'route' && ugSeg.purpose === 'respond') {
      status = 'Responding';
      tone = 'warn';
    } else if (ugSeg.type === 'route' && (ugSeg.purpose === 'tent' || ugSeg.purpose === 'dock')) {
      status = ugSeg.purpose === 'tent' ? 'To decon' : 'To dock';
      tone = 'info';
    }
    const uaSeg = this.uav.current(t);
    const uap = this.uav.pose(t);
    const uavBattery = clamp(74 - (t - this.bootTime) / 1000 * 0.006, 35, 100);
    const team = this.team.pose(0, t);
    const teamSeg = this.team.current(t);
    const anyActive = this.incidents.some((i) => i.status !== 'resolved' && i.assigned.includes('RV-02'));
    return {
      'UGV-01': {
        id: 'UGV-01',
        kind: 'ugv',
        name: 'UGV-01',
        status,
        tone,
        task,
        area: zoneAt(ugp.x, ugp.z)?.short ?? 'Site roads',
        battery: this.ugvBattery,
        speed: ugp.speed,
        eta,
        distance,
        signal: 94 + Math.sin(t / 7000) * 3,
        x: ugp.x,
        z: ugp.z,
      },
      'UAV-01': {
        id: 'UAV-01',
        kind: 'uav',
        name: 'UAV-01',
        status: uaSeg.type === 'orbit' ? 'Overwatch' : 'Surveying',
        tone: uaSeg.type === 'orbit' ? 'info' : 'ok',
        task: uaSeg.type === 'orbit' ? uaSeg.label : 'Perimeter route',
        area: zoneAt(uap.x, uap.z)?.short ?? 'Perimeter',
        battery: uavBattery,
        speed: uap.speed,
        eta: null,
        distance: null,
        signal: 91 + Math.sin(t / 5300) * 4,
        x: uap.x,
        z: uap.z,
      },
      'TEAM-1': {
        id: 'TEAM-1',
        kind: 'team',
        name: 'Survey Team',
        status: teamSeg.type === 'muster' ? 'Mustered' : teamSeg.type === 'return' ? 'Returning' : this.teamTask ? 'Assigned' : 'Accounted',
        tone: teamSeg.type === 'muster' ? 'watch' : this.teamTask ? 'info' : 'ok',
        task: teamSeg.type === 'muster' ? teamSeg.label : this.teamTask ?? 'Service yard survey',
        area: teamSeg.type === 'muster' ? 'Assembly point AP-2' : 'Service zone',
        battery: null,
        speed: 1.1,
        eta: null,
        distance: null,
        signal: 97,
        x: team.x,
        z: team.z,
        headcount: { present: 3, total: 3 },
      },
      'RV-02': {
        id: 'RV-02',
        kind: 'vehicle',
        name: 'RV-02',
        status: anyActive ? 'Standing by' : 'Staged',
        tone: anyActive ? 'info' : 'neutral',
        task: 'Response vehicle · service yard',
        area: 'Service zone',
        battery: null,
        speed: 0,
        eta: null,
        distance: null,
        signal: 99,
        x: RESPONSE_VEHICLE_POSE.x,
        z: RESPONSE_VEHICLE_POSE.z,
      },
    };
  }

  private publish() {
    const t = this.now;
    const sensors: Record<string, SensorState> = {};
    for (const rt of this.sensorsRt.values()) sensors[rt.def.id] = rt.state;
    const feeds: Record<string, { stale: boolean; staleSince: number | null }> = {};
    for (const [k, v] of Object.entries(this.feedStale)) feeds[k] = { stale: v !== null, staleSince: v };
    useSim.setState({
      ready: true,
      now: t,
      tick: this.tickIndex,
      lastUpdate: t,
      run: this.activeRun,
      metrics: this.lastMetrics ?? useSim.getState().metrics,
      weather: { ...this.weather.current },
      kpis: this.lastKpis ?? useSim.getState().kpis,
      sensors,
      assets: this.assetSnapshot(t),
      events: this.events,
      incidents: this.incidents,
      observations: this.observations,
      health: this.computeHealth(t),
      feeds,
      historyVersion: this.tickIndex,
    });
  }

  /** Publish immediately after an operator action so the UI reacts without waiting for a tick. */
  private commit() {
    this.lastKpis = this.computeKpis(this.now);
    this.publish();
  }

  // ------------------------------------------------------------------------------------------ records

  private pushEvent(spec: EventSpec & { incidentId?: string; observationId?: string }, t = this.now): SimEvent {
    const ev: SimEvent = { id: `E${++this.seq.event}`, t, ...spec };
    // keep newest-first ordering even for backfilled events
    if (!this.events.length || this.events[0].t <= t) this.events = [ev, ...this.events];
    else this.events = [...this.events, ev].sort((a, b) => b.t - a.t);
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(0, MAX_EVENTS);
    return ev;
  }

  private addEffect(run: ScenarioRun, loc: ScenarioLocation, kind: EffectKind, o: { amplitude: number; sigma: number; ramp?: number; delay?: number; x?: number; z?: number; sensors?: string[]; delays?: number[] }) {
    const e: Effect = {
      id: `FX${++this.seq.effect}`,
      runId: run.runId,
      kind,
      x: o.x ?? loc.x,
      z: o.z ?? loc.z,
      amplitude: o.amplitude,
      sigma: o.sigma,
      t0: this.now + (o.delay ?? 0) * 1000,
      ramp: o.ramp ?? 30,
      endAt: run.endsAt,
      rampDown: 22,
      sensors: o.sensors,
      delays: o.delays,
    };
    this.effects.push(e);
    // prune long-finished effects (bounded memory); keep the last 30 minutes for replay
    this.effects = this.effects.filter((x) => x.endAt === null || this.now - x.endAt < HISTORY_CAPACITY * 1000);
    return e;
  }

  private createIncident(spec: IncidentSpec, run: ScenarioRun, loc: ScenarioLocation, obsId?: string): Incident {
    this.seq.incident++;
    const inc: Incident = {
      id: `INC-${mmdd(this.now)}-${String(this.seq.incident).padStart(2, '0')}`,
      title: spec.title,
      category: spec.category,
      severity: spec.severity,
      status: 'new',
      createdAt: this.now,
      location: { x: loc.x, z: loc.z, label: loc.label, zoneId: loc.zoneId },
      assigned: [],
      timeline: [],
      checklist: spec.checklist.map((c) => ({ ...c, done: false })),
      sensors: spec.sensors,
      observationId: obsId,
      scenarioRunId: run.runId,
    };
    this.incidents = [inc, ...this.incidents];
    this.pushEvent({ category: 'system', tone: spec.severity === 'low' ? 'watch' : 'warn', title: 'Incident opened', detail: `${inc.id} · ${spec.title}`, incidentId: inc.id, focus: { kind: 'location', x: loc.x, z: loc.z, label: loc.short, radius: 120 } });
    return inc;
  }

  private patchIncident(id: string, fn: (i: Incident) => Incident) {
    this.incidents = this.incidents.map((i) => (i.id === id ? fn(i) : i));
  }

  addTimeline(incidentId: string, kind: TimelineKind, text: string, actor: string, detail?: string, t?: number) {
    const entry = { id: `T${++this.seq.entry}`, t: t ?? this.now, kind, text, actor, detail };
    this.patchIncident(incidentId, (i) => ({ ...i, timeline: [...i.timeline, entry].sort((a, b) => a.t - b.t) }));
  }

  private setChecklist(incidentId: string, itemId: string, done: boolean, log = false) {
    let changed: ChecklistItem | undefined;
    this.patchIncident(incidentId, (i) => ({
      ...i,
      checklist: i.checklist.map((c) => {
        if (c.id !== itemId || c.done === done) return c;
        changed = { ...c, done, doneAt: done ? this.now : undefined };
        return changed;
      }),
    }));
    if (changed && log) this.addTimeline(incidentId, 'operator', `${done ? 'Completed' : 'Reopened'}: ${changed.text}`, 'Operator');
  }

  private markAssigned(incidentId: string | undefined, asset: AssetId) {
    if (!incidentId) return;
    this.patchIncident(incidentId, (i) => ({
      ...i,
      assigned: i.assigned.includes(asset) ? i.assigned : [...i.assigned, asset],
      status: i.status === 'acknowledged' ? 'investigating' : i.status,
    }));
  }

  private createObservation(spec: ObservationSpec, run: ScenarioRun, loc: ScenarioLocation): Observation {
    const obs: Observation = {
      id: `OBS-${String(++this.seq.obs).padStart(3, '0')}`,
      title: spec.title,
      summary: spec.summary,
      category: spec.category,
      status: spec.status,
      confidence: spec.confidence,
      sources: spec.sources,
      evidence: spec.evidence.map((e, k) => ({ ...e, id: `EV${this.seq.obs}-${k}`, t: this.now })),
      recommended: spec.recommended,
      location: { x: loc.x, z: loc.z, label: loc.label, zoneId: loc.zoneId },
      createdAt: this.now,
      updatedAt: this.now,
      scenarioRunId: run.runId,
    };
    this.observations = [obs, ...this.observations];
    history.push(`obs:${obs.id}`, this.now, obs.confidence);
    return obs;
  }

  private patchObservation(id: string, fn: (o: Observation) => Observation) {
    this.observations = this.observations.map((o) => (o.id === id ? fn(o) : o));
  }

  private addEvidence(obsId: string, ev: Omit<Evidence, 'id' | 't'>) {
    this.patchObservation(obsId, (o) => ({
      ...o,
      evidence: [...o.evidence, { ...ev, id: `EV${o.id}-${o.evidence.length}`, t: this.now }],
      updatedAt: this.now,
    }));
  }

  private hotspotTemp(x: number, z: number) {
    let delta = 0;
    for (const e of this.effects) {
      if (e.kind !== 'thermal' && e.kind !== 'fire') continue;
      const d = Math.hypot(e.x - x, e.z - z);
      if (d < 40) delta = Math.max(delta, e.amplitude * envelope(e, this.now) + (e.kind === 'fire' ? this.fireResidual(e, this.now) : 0));
    }
    return this.weather.current.temperature + delta;
  }

  /** After the flames are out the skid keeps cooling for a while (°C above ambient). */
  private fireResidual(e: Effect, t: number) {
    if (e.endAt === null || t < e.endAt) return 0;
    const since = (t - e.endAt) / 1000;
    return 70 * Math.exp(-since / 45) * Math.min(1, since / 4);
  }

  private makeContext(run: ScenarioRun, loc: ScenarioLocation): ScriptContext {
    const vars: ScriptVars = {};
    return {
      run,
      loc,
      sev: SEVERITY_FACTOR[run.severity],
      vars,
      now: () => this.now,
      effect: (kind, o) => this.addEffect(run, loc, kind, o),
      event: (e) => this.pushEvent({ ...e, incidentId: vars.incidentId, observationId: vars.obsId }),
      incident: (spec) => {
        const inc = this.createIncident(spec, run, loc, vars.obsId);
        vars.incidentId = inc.id;
        if (vars.obsId) this.patchObservation(vars.obsId, (o) => ({ ...o, incidentId: inc.id }));
        return inc;
      },
      timeline: (kind, text, actor, detail, t) => {
        if (vars.incidentId) this.addTimeline(vars.incidentId, kind, text, actor, detail, t);
      },
      check: (itemId) => {
        if (vars.incidentId) this.setChecklist(vars.incidentId, itemId, true);
      },
      observation: (spec) => {
        const o = this.createObservation(spec, run, loc);
        vars.obsId = o.id;
        return o;
      },
      evidence: (ev) => {
        if (vars.obsId) this.addEvidence(vars.obsId, ev);
      },
      observe: (patch) => {
        if (vars.obsId) this.patchObservation(vars.obsId, (o) => ({ ...o, ...patch, updatedAt: this.now }));
      },
      dispatchUgv: (label) => {
        const r = this.ugv.dispatch(this.now, loc.inspect, { x: loc.x, z: loc.z }, 'inspect', label);
        vars.dispatchedAt = this.now;
        vars.arrivedAt = undefined;
        this.markAssigned(vars.incidentId, 'UGV-01');
        return { distance: r.distance, duration: r.duration };
      },
      orbitUav: (label, x, z, opts) => {
        this.uav.orbit(this.now, x ?? loc.x, z ?? loc.z, label, opts);
        this.markAssigned(vars.incidentId, 'UAV-01');
      },
      ugvRespond: (target, lookAt, label, vmax) => {
        const r = this.ugv.dispatch(this.now, target, lookAt, 'respond', label, vmax);
        vars.dispatchedAt = this.now;
        vars.arrivedAt = undefined;
        this.markAssigned(vars.incidentId, 'UGV-01');
        return { distance: r.distance, duration: r.duration };
      },
      ugvFirePlan: (o) => this.ugv.firePlan(this.now, o),
      ugvDistanceTo: (x, z) => {
        const p = this.ugv.pose(this.now);
        return Math.hypot(p.x - x, p.z - z);
      },
      endEffect: (id, at, rampDown) => {
        const e = this.effects.find((x) => x.id === id);
        if (!e) return;
        e.endAt = at;
        e.rampDown = rampDown;
      },
      teamMuster: (point, face, label) => {
        this.markAssigned(vars.incidentId, 'TEAM-1');
        return this.team.muster(this.now, point, face, label);
      },
      teamRelease: () => this.team.release(this.now),
      uavResume: () => {
        if (this.uav.isOrbiting(this.now)) this.uav.resumePerimeter(this.now);
      },
      resolveScenario: (summary) => this.closeRun(summary),
      fireTemp: () => {
        let delta = 0;
        for (const e of this.effects) {
          if (e.kind !== 'fire' || e.runId !== run.runId) continue;
          delta = Math.max(delta, e.amplitude * envelope(e, this.now) + this.fireResidual(e, this.now));
        }
        return this.weather.current.temperature + delta;
      },
      assignTeam: (task) => {
        this.teamTask = task;
        this.markAssigned(vars.incidentId, 'TEAM-1');
      },
      sensor: (id) => this.sensorsRt.get(id)?.state.value ?? null,
      addSamples: (n) => {
        this.samplesPending += n;
      },
      setFeedStale: (feed, stale) => {
        this.feedStale[feed] = stale ? this.now : null;
      },
      ambient: () => this.weather.current.temperature,
      windText: () => windText(this.weather.current.windDir, this.weather.current.windSpeed),
      hotspotTemp: () => this.hotspotTemp(loc.x, loc.z),
    };
  }

  // ------------------------------------------------------------------------------------------ scenario control

  trigger(params: ScenarioParams) {
    this.cancelAutoplay();
    this.weather.setBaseline(params.windDir, params.windSpeed);
    if (params.preset === 'normal') {
      this.reset();
      return;
    }
    this.windDown('Superseded by new scenario conditions');
    const loc = LOCATION_BY_ID[FIXED_LOCATION[params.preset] ?? params.locationId] ?? LOCATIONS[0];
    const now = Date.now();
    this.now = now;
    const run: ScenarioRun = {
      runId: `RUN-${++this.seq.run}`,
      preset: params.preset,
      label: PRESET_BY_ID[params.preset].label,
      severity: params.severity,
      locationId: loc.id,
      startedAt: now,
      endsAt: params.duration > 0 ? now + params.duration * 60_000 : null,
    };
    this.runs.push(run);
    this.activeRun = run;
    this.steps = buildScript(params.preset).map((s) => ({ ...s, done: false }));
    this.ctx = this.makeContext(run, loc);
    // run the t=0 step immediately so effects start ramping now
    this.step(now, true);
    this.publish();
  }

  /** Ramp down active effects, close open incidents/observations and recall assets. */
  private windDown(reason: string) {
    const now = Date.now();
    this.now = now;
    for (const e of this.effects) if (e.endAt === null || e.endAt > now) e.endAt = now;
    for (const inc of this.incidents) {
      if (inc.status === 'resolved') continue;
      this.addTimeline(inc.id, 'system', reason, 'Scenario control');
      this.patchIncident(inc.id, (i) => ({ ...i, status: 'resolved', resolvedAt: now }));
    }
    this.observations = this.observations.map((o) => (o.status === 'validated' || o.status === 'cleared' ? o : { ...o, status: 'cleared', updatedAt: now }));
    this.recallAssets(now);
    this.team.release(now);
    for (const k of Object.keys(this.feedStale)) this.feedStale[k] = null;
    this.teamTask = null;
    this.activeRun = null;
    this.steps = [];
    this.ctx = null;
  }

  /** A scenario that ran its course: close its incident as resolved by the response team and end the run. */
  private closeRun(summary: string) {
    const run = this.activeRun;
    if (!run) return;
    const now = this.now;
    for (const inc of this.incidents) {
      if (inc.scenarioRunId !== run.runId || inc.status === 'resolved') continue;
      this.addTimeline(inc.id, 'system', 'Incident closed', 'Response coordinator', summary);
      this.patchIncident(inc.id, (i) => ({ ...i, status: 'resolved', resolvedAt: now, acknowledgedAt: i.acknowledgedAt ?? now }));
      this.pushEvent({ category: 'system', tone: 'ok', title: 'Incident closed', detail: `${inc.id} · ${summary}`, incidentId: inc.id });
    }
    this.pushEvent({ category: 'system', tone: 'ok', title: 'Scenario complete', detail: `${run.label} · normal operations resumed` });
    for (const k of Object.keys(this.feedStale)) this.feedStale[k] = null;
    this.teamTask = null;
    this.activeRun = null;
    this.steps = [];
    this.ctx = null;
  }

  reset() {
    this.cancelAutoplay();
    const hadActivity = this.activeRun !== null || this.incidents.some((i) => i.status !== 'resolved');
    this.windDown('Returned to normal operations');
    this.samplesPending = 2;
    if (hadActivity) this.pushEvent({ category: 'system', tone: 'ok', title: 'Normal operations', detail: 'Conditions returning to baseline · assets resuming routine tasks' });
    this.commit();
  }

  setWind(dir: number, speed: number) {
    this.weather.setBaseline(dir, speed);
    this.commit();
  }

  private recallAssets(t: number) {
    const seg = this.ugv.current(t);
    if (seg.type !== 'patrol' && !(seg.type === 'route' && seg.purpose === 'return')) this.ugv.returnToPatrol(t);
    if (this.uav.isOrbiting(t)) this.uav.resumePerimeter(t);
  }

  // ------------------------------------------------------------------------------------------ operator actions

  acknowledge(id: string) {
    const inc = this.incidents.find((i) => i.id === id);
    if (!inc || inc.status !== 'new') return;
    this.now = Date.now();
    this.patchIncident(id, (i) => ({ ...i, status: i.assigned.length ? 'investigating' : 'acknowledged', acknowledgedAt: this.now }));
    this.addTimeline(id, 'operator', 'Incident acknowledged', 'Operator');
    this.pushEvent({ category: 'system', tone: 'ok', title: 'Incident acknowledged', detail: `${id} · response time ${Math.round((this.now - inc.createdAt) / 1000)} s`, incidentId: id });
    this.commit();
  }

  assign(id: string, asset: AssetId) {
    const inc = this.incidents.find((i) => i.id === id);
    if (!inc || inc.status === 'resolved') return;
    this.now = Date.now();
    const loc = LOCATIONS.find((l) => Math.hypot(l.x - inc.location.x, l.z - inc.location.z) < 5);
    const target: Vec2 = loc ? loc.inspect : ROADS.project(inc.location).point;
    if (asset === 'UGV-01') {
      const r = this.ugv.dispatch(this.now, target, { x: inc.location.x, z: inc.location.z }, 'inspect', `Inspection · ${loc?.short ?? inc.location.label}`);
      if (this.ctx && this.activeRun?.runId === inc.scenarioRunId) {
        this.ctx.vars.dispatchedAt = this.now;
        this.ctx.vars.arrivedAt = undefined;
      }
      this.addTimeline(id, 'asset', 'UGV-01 assigned', 'Operator', `Route ${Math.round(r.distance)} m`);
    } else if (asset === 'UAV-01') {
      this.uav.orbit(this.now, inc.location.x, inc.location.z, `Overwatch · ${loc?.short ?? inc.location.label}`);
      this.addTimeline(id, 'asset', 'UAV-01 assigned', 'Operator', 'Overwatch orbit');
    } else if (asset === 'TEAM-1') {
      this.teamTask = `Field check · ${loc?.short ?? inc.location.label}`;
      this.addTimeline(id, 'asset', 'Survey Team assigned', 'Operator');
    } else {
      this.addTimeline(id, 'asset', 'RV-02 placed on standby', 'Operator');
    }
    this.patchIncident(id, (i) => ({
      ...i,
      assigned: i.assigned.includes(asset) ? i.assigned : [...i.assigned, asset],
      status: i.status === 'new' ? 'new' : 'investigating',
    }));
    if (inc.checklist.some((c) => c.id === 'dispatch')) this.setChecklist(id, 'dispatch', true);
    this.pushEvent({ category: 'asset', tone: 'info', title: `${asset} assigned`, detail: `${id} · ${inc.location.label}`, incidentId: id, focus: { kind: 'asset', id: asset } });
    this.commit();
  }

  /** Operator recall: UGV back to patrol, UAV back to its perimeter route, team released. */
  recall(asset: AssetId) {
    this.now = Date.now();
    if (asset === 'UGV-01') {
      const seg = this.ugv.current(this.now);
      if (seg.type === 'patrol' || (seg.type === 'route' && seg.purpose === 'return')) return;
      this.ugv.returnToPatrol(this.now);
    } else if (asset === 'UAV-01') {
      if (!this.uav.isOrbiting(this.now)) return;
      this.uav.resumePerimeter(this.now);
    } else if (asset === 'TEAM-1') {
      this.teamTask = null;
    } else return;
    this.pushEvent({ category: 'asset', tone: 'info', title: `${asset} recalled`, detail: 'Resuming routine tasking', focus: { kind: 'asset', id: asset } });
    this.commit();
  }

  /** Operator tasking from the inspector: send an asset to an arbitrary location. */
  taskAsset(asset: AssetId, x: number, z: number, label: string) {
    this.now = Date.now();
    if (asset === 'UGV-01') {
      const target = ROADS.project({ x, z }).point;
      const r = this.ugv.dispatch(this.now, target, { x, z }, 'inspect', `Inspection · ${label}`);
      this.pushEvent({ category: 'asset', tone: 'info', title: 'UGV-01 tasked', detail: `${label} · ${Math.round(r.distance)} m`, focus: { kind: 'asset', id: asset } });
    } else if (asset === 'UAV-01') {
      this.uav.orbit(this.now, x, z, `Overwatch · ${label}`);
      this.pushEvent({ category: 'asset', tone: 'info', title: 'UAV-01 tasked', detail: `Overwatch orbit · ${label}`, focus: { kind: 'asset', id: asset } });
    }
    this.commit();
  }

  setSeverity(id: string, severity: Severity) {
    const inc = this.incidents.find((i) => i.id === id);
    if (!inc || inc.severity === severity) return;
    this.now = Date.now();
    this.patchIncident(id, (i) => ({ ...i, severity }));
    this.addTimeline(id, 'operator', `Severity set to ${severity}`, 'Operator');
    this.commit();
  }

  /** Operator log entry on an incident timeline (free text, trimmed and length-limited). */
  addNote(id: string, text: string) {
    const note = text.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_LENGTH);
    const inc = this.incidents.find((i) => i.id === id);
    if (!note || !inc) return false;
    this.now = Date.now();
    this.addTimeline(id, 'operator', 'Operator note', 'Operator', note);
    this.commit();
    return true;
  }

  toggleChecklist(id: string, itemId: string) {
    const inc = this.incidents.find((i) => i.id === id);
    const item = inc?.checklist.find((c) => c.id === itemId);
    if (!inc || !item) return;
    this.now = Date.now();
    this.setChecklist(id, itemId, !item.done, true);
    this.commit();
  }

  resolve(id: string) {
    const inc = this.incidents.find((i) => i.id === id);
    if (!inc || inc.status === 'resolved') return;
    this.now = Date.now();
    const now = this.now;
    this.addTimeline(id, 'operator', 'Incident resolved', 'Operator', 'Conditions returning to baseline');
    this.patchIncident(id, (i) => ({ ...i, status: 'resolved', resolvedAt: now, acknowledgedAt: i.acknowledgedAt ?? now }));
    for (const e of this.effects) if (e.runId === inc.scenarioRunId && (e.endAt === null || e.endAt > now)) e.endAt = now;
    if (inc.observationId) this.patchObservation(inc.observationId, (o) => (o.status === 'validated' ? o : { ...o, status: 'cleared', updatedAt: now }));
    if (this.activeRun?.runId === inc.scenarioRunId) {
      for (const k of Object.keys(this.feedStale)) this.feedStale[k] = null;
      this.team.release(now);
      this.teamTask = null;
      this.activeRun = null;
      this.steps = [];
      this.ctx = null;
    }
    if (!this.incidents.some((i) => i.status !== 'resolved')) this.recallAssets(now);
    this.pushEvent({ category: 'system', tone: 'ok', title: 'Incident resolved', detail: `${id} · assets returning to routine tasks`, incidentId: id });
    this.commit();
  }

  validateObservation(obsId: string) {
    const obs = this.observations.find((o) => o.id === obsId);
    if (!obs || obs.status === 'validated' || obs.status === 'cleared') return;
    this.now = Date.now();
    this.patchObservation(obsId, (o) => ({ ...o, status: 'validated', updatedAt: this.now }));
    if (obs.incidentId) this.addTimeline(obs.incidentId, 'operator', 'AI observation validated by operator', 'Operator', `${obs.id} · ${Math.round(obs.confidence * 100)}%`);
    this.pushEvent({ category: 'ai', tone: 'ok', title: 'Observation validated', detail: `${obs.id} · ${obs.title}`, observationId: obsId, incidentId: obs.incidentId });
    this.commit();
  }

  /** Returns the incident linked to an observation, creating one if needed. */
  createIncidentFromObservation(obsId: string): string | null {
    const obs = this.observations.find((o) => o.id === obsId);
    if (!obs) return null;
    if (obs.incidentId) return obs.incidentId;
    this.now = Date.now();
    const run = this.runs.find((r) => r.runId === obs.scenarioRunId) ?? this.runs[this.runs.length - 1];
    const loc = LOCATIONS.find((l) => Math.hypot(l.x - obs.location.x, l.z - obs.location.z) < 5) ?? LOCATIONS[0];
    if (!run) return null;
    const inc = this.createIncident({ title: `${obs.title} · ${loc.short}`, category: obs.category, severity: 'moderate', sensors: obs.sources.filter((s) => /^(RAD|AIR|BIO)-/.test(s)), checklist: [
      { id: 'evidence', text: 'Review AI evidence and sources', priority: 'high' },
      { id: 'dispatch', text: 'Dispatch inspection asset', priority: 'medium' },
      { id: 'assessment', text: 'Record operator assessment', priority: 'medium' },
    ] }, run, loc, obs.id);
    this.patchObservation(obsId, (o) => ({ ...o, incidentId: inc.id }));
    this.addTimeline(inc.id, 'operator', 'Incident created from AI observation', 'Operator', obs.id);
    if (this.ctx && this.ctx.vars.obsId === obsId) this.ctx.vars.incidentId = inc.id;
    this.commit();
    return inc.id;
  }

  // ------------------------------------------------------------------------------------------ queries for the 3D layer / replay

  liveEffects(t: number) {
    return this.effects.filter((e) => isEffectLive(e, t));
  }

  /** Fire: °C above ambient at its seat, including the cooling equipment once the flames are out. */
  fireTempAt(e: Effect, t: number) {
    return e.amplitude * envelope(e, t) + this.fireResidual(e, t);
  }

  windDirAt(t: number): number {
    if (t >= this.now - 500) return this.weather.smoothDir;
    return history.get('windDir')?.sample(t) ?? this.weather.smoothDir;
  }

  windSpeedAt(t: number): number {
    if (t >= this.now - 500) return this.weather.current.windSpeed;
    return history.get('windSpeed')?.sample(t) ?? this.weather.current.windSpeed;
  }

  ugvPose(t: number): Pose {
    return this.ugv.pose(t);
  }

  uavPose(t: number): Pose {
    return this.uav.pose(t);
  }

  teamPose(i: number, t: number): Pose {
    return this.team.pose(i, t);
  }

  isFeedStale(id: string) {
    return this.feedStale[id] !== null && this.feedStale[id] !== undefined;
  }

  sensorValueAt(id: string, t: number): number | null {
    if (t >= this.now - 500) return this.sensorsRt.get(id)?.state.value ?? null;
    const v = history.get(`sensor:${id}`)?.valueAtTime(t);
    return v === null || v === undefined || Number.isNaN(v) ? null : v;
  }

  location(id: string) {
    return LOCATION_BY_ID[id];
  }
}

export const engine = new SimulationEngine();
