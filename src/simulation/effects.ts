import { smoothstep } from '../utils/math';

// Synthetic physical "effects" injected by scenarios. The same analytic field functions drive
// sensor readings in the engine and the GPU overlays in the digital twin, so what the operator
// sees on the map is exactly what the sensors are reporting.

export type EffectKind = 'rad' | 'chem' | 'bio' | 'thermal' | 'dropout' | 'fire' | 'decon';

export interface Effect {
  id: string;
  runId: string;
  kind: EffectKind;
  x: number;
  z: number;
  /**
   * rad: µSv/h peak · chem: ppm peak · bio: index points · thermal / fire: °C above ambient ·
   * decon: deployed shelter (1); the envelope is its inflation / pack-up
   */
  amplitude: number;
  /** characteristic spatial scale in metres */
  sigma: number;
  t0: number;
  /** seconds to reach full strength */
  ramp: number;
  endAt: number | null;
  rampDown: number;
  /** dropout: sensors affected and their stagger (seconds after t0) */
  sensors?: string[];
  delays?: number[];
}

export function envelope(e: Effect, t: number): number {
  if (t < e.t0) return 0;
  const up = smoothstep(0, 1, (t - e.t0) / (e.ramp * 1000));
  if (e.endAt !== null && t > e.endAt) {
    return up * (1 - smoothstep(0, 1, (t - e.endAt) / (e.rampDown * 1000)));
  }
  return up;
}

export function isEffectLive(e: Effect, t: number) {
  return t >= e.t0 && (e.endAt === null || t < e.endAt + e.rampDown * 1000);
}

export interface WindState {
  /** unit vector the air is moving towards (world x/z) */
  tx: number;
  tz: number;
  /** m/s */
  speed: number;
}

/** Elongated Gaussian dose-rate field with a sharper core at the source. */
export function radField(e: Effect, x: number, z: number, w: WindState, env: number): number {
  if (env <= 0) return 0;
  const dx = x - e.x;
  const dz = z - e.z;
  const along = dx * w.tx + dz * w.tz;
  const cross = -dx * w.tz + dz * w.tx;
  const s = e.sigma;
  const shift = 0.7 * s;
  const sa = 1.9 * s;
  const sc = 0.85 * s;
  const plume = Math.exp(-((along - shift) ** 2) / (2 * sa * sa) - (cross * cross) / (2 * sc * sc));
  const core = Math.exp(-(dx * dx + dz * dz) / (2 * (0.45 * s) ** 2));
  return e.amplitude * env * Math.min(1, 0.72 * plume + 0.55 * core);
}

/** Ground-level Gaussian plume with an advancing front (wind speed × elapsed time). */
export function chemField(e: Effect, x: number, z: number, w: WindState, env: number, t: number): number {
  if (env <= 0) return 0;
  const dx = x - e.x;
  const dz = z - e.z;
  const along = dx * w.tx + dz * w.tz;
  const cross = -dx * w.tz + dz * w.tx;
  const a = Math.max(along, 0);
  const upwind = along < 0 ? Math.exp(along / 14) : 1;
  const sy = 7 + 0.24 * a;
  const decay = 1 / (1 + a / 140);
  const reach = Math.max(25, w.speed * Math.max(0, (t - e.t0) / 1000) * 1.15);
  const front = 1 - smoothstep(reach - 15, reach + 35, along);
  return e.amplitude * env * upwind * decay * front * Math.exp(-(cross * cross) / (2 * sy * sy));
}

/** Broad, slightly downwind-shifted aerosol cloud. */
export function bioField(e: Effect, x: number, z: number, w: WindState, env: number): number {
  if (env <= 0) return 0;
  const cx = e.x + w.tx * 0.3 * e.sigma;
  const cz = e.z + w.tz * 0.3 * e.sigma;
  const d2 = (x - cx) ** 2 + (z - cz) ** 2;
  return e.amplitude * env * Math.exp(-d2 / (2 * e.sigma * e.sigma));
}
