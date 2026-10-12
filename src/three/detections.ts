import * as THREE from 'three';
import { SITE } from '../data/site';
import { engine } from '../simulation/engine';
import { envelope } from '../simulation/effects';
import { assetVisual } from './AssetLayer';
import { RESPONSE_VEHICLE_POSE } from '../simulation/assets';
import { windVector } from '../utils/math';

// Synthetic object detection: known scene objects are projected into each feed camera and drawn as
// tracking boxes. Confidence values are generated locally.

export interface Detection {
  id: string;
  label: string;
  confidence: number;
  /** box in viewport pixels */
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'person' | 'robot' | 'vehicle' | 'structure' | 'hotspot' | 'aircraft' | 'fire' | 'smoke';
  extra?: string;
}

interface Trackable {
  id: string;
  label: string;
  kind: Detection['kind'];
  base: number;
  center: THREE.Vector3;
  size: THREE.Vector3;
  extra?: string;
  /** point used for the line-of-sight test (defaults to the centre) */
  probe?: THREE.Vector3;
}

/** Beyond these ranges (m) a class is too small for the synthetic detector to report. */
const MAX_RANGE: Record<Detection['kind'], number> = { person: 220, robot: 380, vehicle: 450, hotspot: 420, structure: 650, aircraft: 900, fire: 650, smoke: 1400 };

// Line-of-sight occluders: generalized building volumes from the shared layout plus the main blocks of
// each reactor unit (as authored by tools/blender/build_facility.py). Objects hidden behind them are
// not reported, so boxes never float over a facade.
interface Occluder {
  min: THREE.Vector3;
  max: THREE.Vector3;
  owner?: string;
}
const OCCLUDERS: Occluder[] = (() => {
  const out: Occluder[] = [];
  const add = (x: number, y: number, z: number, w: number, h: number, d: number, owner?: string) =>
    out.push({ min: new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2), max: new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2), owner });
  for (const b of SITE.buildings) add(b.x, b.h / 2, b.z, b.w, b.h, b.d);
  for (const u of SITE.units) {
    add(u.x, 12, u.z, 96, 24, 92);
    add(u.x, 15.5, u.z - 102, 70, 31, 88);
    add(u.x + 44, 9, u.z - 102, 18, 18, 80);
    add(u.x, 35, u.z, 53, 70, 53, `dome-${u.id}`);
  }
  return out;
})();

/** Does the segment a→b pass through an occluder (other than the target's own volume)? */
function occluded(a: THREE.Vector3, b: THREE.Vector3, owner: string) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  for (const o of OCCLUDERS) {
    if (o.owner === owner) continue;
    let t0 = 0.002;
    let t1 = 0.985;
    const slab = (p: number, d: number, lo: number, hi: number) => {
      if (Math.abs(d) < 1e-9) return p >= lo && p <= hi;
      let u = (lo - p) / d;
      let w = (hi - p) / d;
      if (u > w) [u, w] = [w, u];
      t0 = Math.max(t0, u);
      t1 = Math.min(t1, w);
      return t0 <= t1;
    };
    if (slab(a.x, dx, o.min.x, o.max.x) && slab(a.y, dy, o.min.y, o.max.y) && slab(a.z, dz, o.min.z, o.max.z)) return true;
  }
  return false;
}

const corners = Array.from({ length: 8 }, () => new THREE.Vector3());
const v = new THREE.Vector3();
const eye = new THREE.Vector3();

function trackables(t: number): Trackable[] {
  const out: Trackable[] = [];
  const ugv = assetVisual.ugv;
  out.push({ id: 'ugv', label: 'Robot', kind: 'robot', base: 0.96, center: new THREE.Vector3(ugv.x, 0.72, ugv.z), size: new THREE.Vector3(1.6, 1.45, 1.6) });
  assetVisual.team.forEach((p, i) =>
    out.push({ id: `person-${i}`, label: 'Person', kind: 'person', base: 0.97 + (i === 1 ? 0.01 : 0), center: new THREE.Vector3(p.x, 0.9, p.z), size: new THREE.Vector3(0.75, 1.85, 0.75) }),
  );
  out.push({ id: 'rv', label: 'Vehicle', kind: 'vehicle', base: 0.94, center: new THREE.Vector3(RESPONSE_VEHICLE_POSE.x, 1.6, RESPONSE_VEHICLE_POSE.z), size: new THREE.Vector3(8.6, 3.2, 2.6) });
  const uav = assetVisual.uav;
  out.push({ id: 'uav', label: 'UAV', kind: 'aircraft', base: 0.91, center: new THREE.Vector3(uav.x, uav.y, uav.z), size: new THREE.Vector3(3, 0.9, 3) });
  for (const u of SITE.units) {
    out.push({ id: `dome-${u.id}`, label: 'Structure', kind: 'structure', base: 0.99, center: new THREE.Vector3(u.x, 34, u.z), size: new THREE.Vector3(55, 68, 55), probe: new THREE.Vector3(u.x, 60, u.z) });
  }
  for (const e of engine.effects) {
    if (e.kind !== 'fire' || t < e.t0) continue;
    // open flame over the generator skid, then the smoke column bent downwind (steam once it is out)
    const env = envelope(e, t);
    const temp = engine.weather.current.temperature + engine.fireTempAt(e, t);
    if (env > 0.2) {
      out.push({
        id: `fire-${e.id}`,
        label: 'Fire',
        kind: 'fire',
        base: 0.86 + 0.11 * env,
        center: new THREE.Vector3(e.x - 0.8, 1.2 + 2.4 * env, e.z),
        size: new THREE.Vector3(5.2, 2.4 + 4.8 * env, 4.4),
        extra: `${Math.round(temp)} °C`,
      });
    }
    const since = (t - e.t0) / 1000;
    const out_ = e.endAt === null ? null : (t - e.endAt) / 1000;
    const plume = Math.min(1, since / 12) * (out_ === null || out_ < 0 ? 1 : Math.exp(-out_ / 30));
    if (plume > 0.3) {
      const w = windVector(engine.windDirAt(t));
      const drift = (engine.windSpeedAt(t) / 3.6) * 2.4;
      const steam = out_ !== null && out_ > 2;
      out.push({
        id: `smoke-${e.id}`,
        label: steam ? 'Steam' : 'Smoke',
        kind: 'smoke',
        base: steam ? 0.74 + 0.1 * plume : 0.84 + 0.1 * plume,
        center: new THREE.Vector3(e.x + w.x * drift, 9.5, e.z + w.z * drift),
        size: new THREE.Vector3(8 + drift, 12, 8 + drift),
        probe: new THREE.Vector3(e.x + w.x * drift, 13, e.z + w.z * drift),
      });
    }
  }
  for (const e of engine.liveEffects(t)) {
    if (e.kind !== 'thermal') continue;
    const env = envelope(e, t);
    if (env < 0.25) continue;
    const temp = engine.weather.current.temperature + e.amplitude * env;
    out.push({
      id: `hot-${e.id}`,
      label: 'Hotspot',
      kind: 'hotspot',
      base: 0.7 + 0.18 * env,
      center: new THREE.Vector3(e.x, 1.6, e.z),
      size: new THREE.Vector3(7.5, 3.4, 6),
      extra: `${temp.toFixed(1)} °C`,
    });
  }
  return out;
}

export function detect(camera: THREE.PerspectiveCamera, width: number, height: number, t: number, exclude?: string): Detection[] {
  const out: Detection[] = [];
  camera.updateMatrixWorld();
  camera.getWorldPosition(eye);
  const jitter = (id: string) => Math.sin(t / 900 + id.length * 1.7) * 0.006;
  for (const tr of trackables(t)) {
    if (tr.id === exclude) continue;
    // in front of the camera, within the class's detection range and in line of sight?
    v.copy(tr.center).applyMatrix4(camera.matrixWorldInverse);
    if (v.z > -1) continue;
    if (eye.distanceTo(tr.center) > MAX_RANGE[tr.kind]) continue;
    if (occluded(eye, tr.probe ?? tr.center, tr.id)) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let k = 0;
    for (let ix = -1; ix <= 1; ix += 2)
      for (let iy = -1; iy <= 1; iy += 2)
        for (let iz = -1; iz <= 1; iz += 2) {
          const c = corners[k++];
          c.set(tr.center.x + (ix * tr.size.x) / 2, tr.center.y + (iy * tr.size.y) / 2, tr.center.z + (iz * tr.size.z) / 2).project(camera);
          minX = Math.min(minX, c.x);
          maxX = Math.max(maxX, c.x);
          minY = Math.min(minY, c.y);
          maxY = Math.max(maxY, c.y);
        }
    const x0 = ((minX + 1) / 2) * width;
    const x1 = ((maxX + 1) / 2) * width;
    const y0 = ((1 - maxY) / 2) * height;
    const y1 = ((1 - minY) / 2) * height;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    if (cx < 0 || cx > width || cy < 0 || cy > height) continue;
    const w = x1 - x0;
    const h = y1 - y0;
    if (w * h < (tr.kind === 'person' ? 30 : 60) || w > width * 0.85 || h > height * 0.9) continue;
    const cx0 = Math.max(1, x0);
    const cy0 = Math.max(1, y0);
    out.push({
      id: tr.id,
      label: tr.label,
      kind: tr.kind,
      confidence: Math.min(0.989, tr.base + jitter(tr.id)),
      x: cx0,
      y: cy0,
      w: Math.min(width - 1, x1) - cx0,
      h: Math.min(height - 1, y1) - cy0,
      extra: tr.extra,
    });
  }
  return out;
}
