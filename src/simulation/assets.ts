import type { Vec2 } from '../types';
import { LoopPath, Polyline, RoadGraph, SITE, filletLoop, filletPath } from '../data/site';
import { angleDeltaRad, clamp, smoothstep } from '../utils/math';

// Analytic, replayable kinematics for the synthetic field assets. Every asset keeps an append-only
// list of plan segments, so its pose can be evaluated for any past time (timeline replay).

export const ROADS = new RoadGraph(SITE.roads);

export interface Pose {
  x: number;
  y: number;
  z: number;
  /** three.js rotation.y for a model whose forward axis is +z */
  heading: number;
  speed: number;
}

// ---------------------------------------------------------------------------------------------- UGV

export const UGV_PATROL = new LoopPath(
  filletLoop(
    [
      { x: -400, z: 0 },
      { x: 400, z: 0 },
      { x: 400, z: -222 },
      { x: -400, z: -222 },
    ],
    10,
  ),
);

export type UgvSegment =
  | { type: 'patrol'; t0: number; s0: number; speed: number }
  | {
      type: 'route';
      t0: number;
      path: Polyline;
      vmax: number;
      accel: number;
      duration: number;
      /** inspect / return: road dispatches · respond / tent / dock: fire-response legs (off-road where needed) */
      purpose: 'inspect' | 'return' | 'respond' | 'tent' | 'dock';
      lookAt: Vec2 | null;
      label: string;
    }
  | { type: 'hold'; t0: number; x: number; z: number; heading: number; lookAt: Vec2 | null; label: string; mode: 'inspecting' | 'holding' }
  /** stationary at the stand-off point, turret spraying water mist at `target` from t0 + 0.8 s to t0 + duration */
  | { type: 'suppress'; t0: number; x: number; z: number; heading: number; target: Vec2; duration: number; label: string }
  /** standing in the decontamination shelter while the wash runs */
  | { type: 'decon'; t0: number; x: number; z: number; heading: number; duration: number; label: string }
  /** sitting on the dock pad, recharging */
  | { type: 'charge'; t0: number; x: number; z: number; heading: number; duration: number; label: string };

/** What the robot's body is doing (drives the gait, turret and status light in the 3D layer). */
export interface UgvActivity {
  mode: 'walk' | 'stand' | 'spray' | 'sit';
  /** spray: the point the turret aims at, and whether water is flowing yet */
  target?: Vec2;
  spraying?: boolean;
  /** decon: wash running */
  washing?: boolean;
}

function routeDuration(L: number, vmax: number, a: number) {
  const ta = vmax / a;
  const da = 0.5 * a * ta * ta;
  if (L >= 2 * da) return 2 * ta + (L - 2 * da) / vmax;
  return 2 * Math.sqrt(L / a);
}

function routeS(tau: number, L: number, vmax: number, a: number) {
  const T = routeDuration(L, vmax, a);
  const t = clamp(tau, 0, T);
  const ta = vmax / a;
  const da = 0.5 * a * ta * ta;
  if (L >= 2 * da) {
    if (t < ta) return 0.5 * a * t * t;
    if (t < T - ta) return da + vmax * (t - ta);
    const r = T - t;
    return L - 0.5 * a * r * r;
  }
  const th = T / 2;
  if (t < th) return 0.5 * a * t * t;
  const r = T - t;
  return L - 0.5 * a * r * r;
}

function routeV(tau: number, L: number, vmax: number, a: number) {
  const T = routeDuration(L, vmax, a);
  if (tau <= 0 || tau >= T) return 0;
  return Math.min(vmax, a * tau, a * (T - tau));
}

const findSegment = <T extends { t0: number }>(segs: T[], t: number) => {
  let lo = 0;
  let hi = segs.length - 1;
  if (t <= segs[0].t0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].t0 <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

/**
 * Drops plan segments that ended before `before` (the start of the replay window), keeping a couple
 * of predecessors because poses blend across segment boundaries. Keeps memory bounded in long sessions.
 */
function pruneSegments<T extends { t0: number }>(segs: T[], before: number, keep = 2) {
  const cut = findSegment(segs, before) - keep;
  if (cut > 0) segs.splice(0, cut);
}

export class UgvController {
  segments: UgvSegment[];
  readonly patrolSpeed = 3.6;

  constructor(t0: number) {
    this.segments = [{ type: 'patrol', t0, s0: 905, speed: this.patrolSpeed }];
  }

  current(t: number) {
    return this.segments[findSegment(this.segments, t)];
  }

  prune(before: number) {
    pruneSegments(this.segments, before);
  }

  pose(t: number): Pose {
    const seg = this.current(t);
    switch (seg.type) {
      case 'patrol': {
        const s = seg.s0 + (seg.speed * (t - seg.t0)) / 1000;
        const p = UGV_PATROL.at(s);
        return { x: p.x, y: 0, z: p.z, heading: UGV_PATROL.headingAt(s, 4), speed: seg.speed };
      }
      case 'route': {
        const tau = (t - seg.t0) / 1000;
        const L = seg.path.length;
        const s = routeS(tau, L, seg.vmax, seg.accel);
        const p = seg.path.at(s);
        let heading = seg.path.headingAt(Math.min(s, L - 0.5), 4);
        if (s >= L - 0.01 && seg.lookAt) heading = Math.atan2(seg.lookAt.x - p.x, seg.lookAt.z - p.z);
        return { x: p.x, y: 0, z: p.z, heading, speed: routeV(tau, L, seg.vmax, seg.accel) };
      }
      case 'hold': {
        let heading = seg.heading;
        if (seg.lookAt) {
          const target = Math.atan2(seg.lookAt.x - seg.x, seg.lookAt.z - seg.z);
          const k = smoothstep(0, 1, (t - seg.t0) / 2500);
          heading = seg.heading + angleDeltaRad(seg.heading, target) * k;
        }
        return { x: seg.x, y: 0, z: seg.z, heading, speed: 0 };
      }
      case 'suppress': {
        const target = Math.atan2(seg.target.x - seg.x, seg.target.z - seg.z);
        const k = smoothstep(0, 1, (t - seg.t0) / 900);
        return { x: seg.x, y: 0, z: seg.z, heading: seg.heading + angleDeltaRad(seg.heading, target) * k, speed: 0 };
      }
      case 'decon':
      case 'charge':
        return { x: seg.x, y: 0, z: seg.z, heading: seg.heading, speed: 0 };
    }
  }

  /** Body activity at time t (for the 3D model). */
  activity(t: number): UgvActivity {
    const seg = this.current(t);
    switch (seg.type) {
      case 'suppress': {
        const lt = (t - seg.t0) / 1000;
        return { mode: 'spray', target: seg.target, spraying: lt > 0.8 && lt < seg.duration - 0.6 };
      }
      case 'decon':
        return { mode: 'stand', washing: (t - seg.t0) / 1000 < seg.duration - 0.5 };
      case 'charge':
        return { mode: (t - seg.t0) / 1000 < seg.duration - 1.6 ? 'sit' : 'stand' };
      case 'hold':
        return { mode: 'stand' };
      case 'route': {
        const tau = (t - seg.t0) / 1000;
        return { mode: tau < seg.duration ? 'walk' : 'stand' };
      }
      default:
        return { mode: 'walk' };
    }
  }

  /** Drops plan segments scheduled after t, so a new plan replaces them (keeps t0 order). */
  private replan(t: number) {
    while (this.segments.length > 1 && this.segments[this.segments.length - 1].t0 > t) this.segments.pop();
  }

  /** Route end time for the active route segment (null when not routing). */
  arrivalTime(t: number): number | null {
    const seg = this.current(t);
    if (seg.type !== 'route') return null;
    return seg.t0 + seg.duration * 1000;
  }

  remaining(t: number): { distance: number; eta: number } | null {
    const seg = this.current(t);
    if (seg.type !== 'route') return null;
    const tau = (t - seg.t0) / 1000;
    const s = routeS(tau, seg.path.length, seg.vmax, seg.accel);
    return { distance: Math.max(0, seg.path.length - s), eta: Math.max(0, seg.duration - tau) };
  }

  dispatch(t: number, target: Vec2, lookAt: Vec2 | null, purpose: 'inspect' | 'return' | 'respond', label: string, vmax = 8) {
    const p = this.pose(t);
    this.replan(t);
    const raw = ROADS.route({ x: p.x, z: p.z }, target);
    const path = new Polyline(filletPath(raw, 9, 7));
    const accel = vmax > 8 ? 2.2 : 1.4;
    const duration = routeDuration(path.length, vmax, accel);
    this.segments.push({ type: 'route', t0: t, path, vmax, accel, duration, purpose, lookAt, label });
    return { distance: path.length, duration, path };
  }

  /** Walks a given path (off-road), starting at t0 (may be in the future). Returns the arrival time. */
  walk(t0: number, points: Vec2[], purpose: 'tent' | 'dock', label: string, vmax = 2.6) {
    const path = new Polyline(filletPath(points, 4, 6));
    const accel = 1.1;
    const duration = routeDuration(path.length, vmax, accel);
    this.segments.push({ type: 'route', t0, path, vmax, accel, duration, purpose, lookAt: null, label });
    return t0 + duration * 1000;
  }

  hold(t: number, mode: 'inspecting' | 'holding', label: string, lookAt: Vec2 | null) {
    const p = this.pose(t);
    this.replan(t);
    this.segments.push({ type: 'hold', t0: t, x: p.x, z: p.z, heading: p.heading, lookAt, label, mode });
  }

  /**
   * Fire-response plan from the stand-off point: spray, walk to the decontamination shelter, wash, walk to
   * the dock, recharge, then return to patrol. All segments are scheduled now (replayable); returns the
   * phase times (ms).
   */
  firePlan(t: number, o: { target: Vec2; toTent: Vec2[]; toDock: Vec2[]; spray: number; wash: number; charge: number }) {
    const p = this.pose(t);
    this.replan(t);
    this.segments.push({ type: 'suppress', t0: t, x: p.x, z: p.z, heading: p.heading, target: o.target, duration: o.spray, label: 'Suppressing · water mist' });
    const sprayStart = t + 800;
    const sprayEnd = t + o.spray * 1000;
    const toTent = [{ x: p.x, z: p.z }, ...o.toTent.slice(1)];
    const deconStart = this.walk(sprayEnd, toTent, 'tent', 'To decontamination · DECON-1');
    const last = toTent[toTent.length - 1];
    const prev = toTent[toTent.length - 2];
    const inHeading = Math.atan2(last.x - prev.x, last.z - prev.z);
    this.segments.push({ type: 'decon', t0: deconStart, x: last.x, z: last.z, heading: inHeading, duration: o.wash, label: 'Decontamination · DECON-1' });
    const deconEnd = deconStart + o.wash * 1000;
    const chargeStart = this.walk(deconEnd, o.toDock, 'dock', 'Returning to dock');
    const dock = o.toDock[o.toDock.length - 1];
    const before = o.toDock[o.toDock.length - 2];
    this.segments.push({ type: 'charge', t0: chargeStart, x: dock.x, z: dock.z, heading: Math.atan2(dock.x - before.x, dock.z - before.z), duration: o.charge, label: 'Recharging at dock' });
    const chargeEnd = chargeStart + o.charge * 1000;
    this.returnToPatrol(chargeEnd, false);
    return { sprayStart, sprayEnd, deconStart, deconEnd, chargeStart, chargeEnd };
  }

  /** Route back to the nearest point of the patrol loop, then resume patrolling from there. */
  returnToPatrol(t: number, replan = true) {
    if (replan) this.replan(t);
    const p = this.pose(t);
    let bestS = 0;
    let bestD = Infinity;
    for (let s = 0; s < UGV_PATROL.length; s += 6) {
      const q = UGV_PATROL.at(s);
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bestD) (bestD = d), (bestS = s);
    }
    if (bestD < 3) {
      this.segments.push({ type: 'patrol', t0: t, s0: bestS, speed: this.patrolSpeed });
      return;
    }
    const target = UGV_PATROL.at(bestS);
    const raw = ROADS.route({ x: p.x, z: p.z }, target);
    const path = new Polyline(filletPath(raw, 9, 7));
    const vmax = 8;
    const accel = 1.4;
    const duration = routeDuration(path.length, vmax, accel);
    this.segments.push({ type: 'route', t0: t, path, vmax, accel, duration, purpose: 'return', lookAt: null, label: 'Returning to patrol' });
    this.segments.push({ type: 'patrol', t0: t + duration * 1000, s0: bestS, speed: this.patrolSpeed });
  }

  /** Active route polyline (for drawing the planned path), if any. */
  activeRoute(t: number): Polyline | null {
    const seg = this.current(t);
    return seg.type === 'route' ? seg.path : null;
  }
}

// ---------------------------------------------------------------------------------------------- UAV

export const UAV_PERIMETER = new LoopPath(
  filletLoop(
    [
      { x: -680, z: -360 },
      { x: 680, z: -360 },
      { x: 680, z: 330 },
      { x: -680, z: 330 },
    ],
    110,
    10,
  ),
);

export type UavSegment =
  | { type: 'perimeter'; t0: number; s0: number; speed: number; alt: number }
  | { type: 'orbit'; t0: number; cx: number; cz: number; r: number; alt: number; omega: number; phase0: number; label: string };

const UAV_BLEND_MS = 14000;

export class UavController {
  segments: UavSegment[];

  constructor(t0: number) {
    this.segments = [{ type: 'perimeter', t0, s0: 2450, speed: 17, alt: 118 }];
  }

  current(t: number) {
    return this.segments[findSegment(this.segments, t)];
  }

  prune(before: number) {
    pruneSegments(this.segments, before);
  }

  private segPose(seg: UavSegment, t: number): Pose {
    if (seg.type === 'perimeter') {
      const s = seg.s0 + (seg.speed * (t - seg.t0)) / 1000;
      const p = UAV_PERIMETER.at(s);
      return { x: p.x, y: seg.alt, z: p.z, heading: UAV_PERIMETER.headingAt(s, 30), speed: seg.speed };
    }
    const ph = seg.phase0 + (seg.omega * (t - seg.t0)) / 1000;
    const x = seg.cx + seg.r * Math.cos(ph);
    const z = seg.cz + seg.r * Math.sin(ph);
    // tangent direction for positive omega
    const tx = -Math.sin(ph);
    const tz = Math.cos(ph);
    return { x, y: seg.alt, z, heading: Math.atan2(tx, tz), speed: Math.abs(seg.omega * seg.r) };
  }

  pose(t: number, index?: number): Pose {
    const i = index ?? findSegment(this.segments, t);
    const seg = this.segments[i];
    const p = this.segPose(seg, t);
    if (i > 0 && t - seg.t0 < UAV_BLEND_MS) {
      const q = this.pose(t, i - 1);
      const k = smoothstep(0, 1, (t - seg.t0) / UAV_BLEND_MS);
      return {
        x: q.x + (p.x - q.x) * k,
        y: q.y + (p.y - q.y) * k,
        z: q.z + (p.z - q.z) * k,
        heading: q.heading + angleDeltaRad(q.heading, p.heading) * k,
        speed: q.speed + (p.speed - q.speed) * k,
      };
    }
    return p;
  }

  /** Ground point the gimbal camera looks at. */
  lookTarget(t: number): Vec2 & { y: number } {
    const seg = this.current(t);
    const p = this.pose(t);
    if (seg.type === 'orbit') {
      const k = smoothstep(0, 1, (t - seg.t0) / UAV_BLEND_MS);
      const fx = p.x + Math.sin(p.heading) * 130;
      const fz = p.z + Math.cos(p.heading) * 130;
      return { x: fx + (seg.cx - fx) * k, y: 0, z: fz + (seg.cz - fz) * k };
    }
    // perimeter: look forward-down, biased towards the site centre
    const fx = p.x + Math.sin(p.heading) * 110;
    const fz = p.z + Math.cos(p.heading) * 110;
    return { x: fx * 0.82, y: 0, z: fz * 0.82 - 20 };
  }

  orbit(t: number, cx: number, cz: number, label: string, o: { r?: number; alt?: number; speed?: number } = {}) {
    const p = this.pose(t);
    const r = o.r ?? 150;
    const v = o.speed ?? 14;
    const phase0 = Math.atan2(p.z - cz, p.x - cx);
    this.segments.push({ type: 'orbit', t0: t, cx, cz, r, alt: o.alt ?? 96, omega: v / r, phase0, label });
  }

  resumePerimeter(t: number) {
    const p = this.pose(t);
    let bestS = 0;
    let bestD = Infinity;
    for (let s = 0; s < UAV_PERIMETER.length; s += 20) {
      const q = UAV_PERIMETER.at(s);
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bestD) (bestD = d), (bestS = s);
    }
    this.segments.push({ type: 'perimeter', t0: t, s0: bestS, speed: 17, alt: 118 });
  }

  isOrbiting(t: number) {
    return this.current(t).type === 'orbit';
  }
}

// ---------------------------------------------------------------------------------------------- Team & vehicle

const TEAM_LOOP = new LoopPath(
  filletLoop(
    [
      { x: 420, z: 188 },
      { x: 486, z: 188 },
      { x: 486, z: 212 },
      { x: 420, z: 212 },
    ],
    5,
  ),
);

export const TEAM_MEMBERS = [
  { id: 'TM-1', role: 'Survey lead' },
  { id: 'TM-2', role: 'Radiation protection technician' },
  { id: 'TM-3', role: 'Field technician' },
];

export function teamPose(index: number, t: number): Pose {
  if (index === 0) {
    const s = (1.15 * t) / 1000;
    const p = TEAM_LOOP.at(s);
    return { x: p.x, y: 0, z: p.z, heading: TEAM_LOOP.headingAt(s, 1.5), speed: 1.15 };
  }
  // two technicians working by the robotics apron, shifting weight occasionally
  const base = index === 1 ? { x: 437, z: 214.5, h: 2.6 } : { x: 439.2, z: 216.2, h: -2.2 };
  const sway = Math.sin(t / 2300 + index) * 0.25;
  return { x: base.x, y: 0, z: base.z, heading: base.h + sway, speed: 0 };
}

export const RESPONSE_VEHICLE_POSE: Pose = { x: 470, y: 0, z: 192.5, heading: -Math.PI / 2, speed: 0 };

type TeamSegment = { type: 'routine'; t0: number } | { type: 'muster'; t0: number; from: Vec2[]; to: Vec2[]; face: Vec2; label: string } | { type: 'return'; t0: number; from: Vec2[] };

const WALK = 1.7; // m/s, brisk walk
/** Spots the three members take at an assembly point: a short line facing the incident. */
const MUSTER_SLOTS = [
  { x: 0, z: 0 },
  { x: -1.6, z: 1.1 },
  { x: 1.5, z: 1.3 },
];

/** Survey team: routine yard work, or a withdrawal to an assembly point and back (replayable plan). */
export class TeamController {
  segments: TeamSegment[];

  constructor(t0: number) {
    this.segments = [{ type: 'routine', t0 }];
  }

  current(t: number) {
    return this.segments[findSegment(this.segments, t)];
  }

  prune(before: number) {
    pruneSegments(this.segments, before);
  }

  pose(i: number, t: number): Pose {
    const seg = this.current(t);
    if (seg.type === 'routine') return teamPose(i, t);
    if (seg.type === 'muster') return walkTo(seg.from[i], seg.to[i], (t - seg.t0) / 1000, Math.atan2(seg.face.x - seg.to[i].x, seg.face.z - seg.to[i].z));
    // return: walk back to the member's routine position (member 1 keeps walking its loop, so chase it)
    const goal = teamPose(i, t);
    const p = walkTo(seg.from[i], { x: goal.x, z: goal.z }, (t - seg.t0) / 1000, goal.heading);
    return p.speed > 0 ? p : goal;
  }

  /** Is anyone still walking (or mustered)? */
  mustered(t: number) {
    return this.current(t).type === 'muster';
  }

  muster(t: number, point: Vec2, face: Vec2, label: string) {
    const from = [0, 1, 2].map((i) => {
      const p = this.pose(i, t);
      return { x: p.x, z: p.z };
    });
    const to = MUSTER_SLOTS.map((o) => ({ x: point.x + o.x, z: point.z + o.z }));
    while (this.segments.length > 1 && this.segments[this.segments.length - 1].t0 > t) this.segments.pop();
    this.segments.push({ type: 'muster', t0: t, from, to, face, label });
    return t + (Math.max(...from.map((f, i) => Math.hypot(to[i].x - f.x, to[i].z - f.z))) / WALK) * 1000;
  }

  release(t: number) {
    if (this.current(t).type !== 'muster') return;
    const from = [0, 1, 2].map((i) => {
      const p = this.pose(i, t);
      return { x: p.x, z: p.z };
    });
    this.segments.push({ type: 'return', t0: t, from });
    // back on routine once the farthest member is home
    const far = Math.max(...from.map((f, i) => {
      const g = teamPose(i, t + 30000);
      return Math.hypot(g.x - f.x, g.z - f.z);
    }));
    this.segments.push({ type: 'routine', t0: t + (far / WALK + 4) * 1000 });
  }
}

function walkTo(from: Vec2, to: Vec2, tau: number, faceAfter: number): Pose {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const L = Math.hypot(dx, dz);
  const s = Math.min(L, Math.max(0, tau) * WALK);
  if (L < 0.01 || s >= L) return { x: to.x, y: 0, z: to.z, heading: faceAfter, speed: 0 };
  return { x: from.x + (dx / L) * s, y: 0, z: from.z + (dz / L) * s, heading: Math.atan2(dx, dz), speed: WALK };
}
