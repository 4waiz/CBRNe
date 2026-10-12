import * as THREE from 'three';
import { useUI, type FeedSource } from '../store/ui';
import { engine } from '../simulation/engine';
import { isEffectLive } from '../simulation/effects';
import { FIRE_SITE } from '../simulation/locations';
import { assetVisual } from './AssetLayer';
import { DEG } from '../utils/math';

// Synthetic surveillance cameras inside the same three.js scene. Positions are fictional.

interface FixedCam {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
}

export const FIXED_CAMS: Record<'CAM-01' | 'CAM-02', FixedCam> = {
  'CAM-01': { pos: new THREE.Vector3(-560, 62, 52), target: new THREE.Vector3(-60, 18, -118), fov: 34 },
  'CAM-02': { pos: new THREE.Vector3(396, 16, 166), target: new THREE.Vector3(452, 1.4, 210), fov: 52 },
};

/** Synthetic stream descriptions (generic equipment classes, no real installation details). */
export const FEED_META: Record<FeedSource, { label: string; short: string; kind: string; fps: number; res: string; codec: string; kbps: number; link: string }> = {
  'CAM-01': { label: 'Exterior · Units 1–4', short: 'Units 1–4', kind: 'Fixed PTZ', fps: 25, res: '1920×1080', codec: 'H.265 · CBR', kbps: 6200, link: 'Fibre · campus LAN' },
  'CAM-02': { label: 'Service yard', short: 'Service yard', kind: 'Fixed PTZ', fps: 25, res: '1920×1080', codec: 'H.265 · CBR', kbps: 5400, link: 'Fibre · campus LAN' },
  'UGV-01': { label: 'Chemical Detection Sensor', short: 'Chem sensor', kind: 'Robot', fps: 25, res: '640×512 LWIR', codec: 'H.264 · 14-bit LWIR', kbps: 2400, link: 'Mesh radio · 2 hops' },
  'UAV-01': { label: 'Gimbal camera', short: 'Gimbal', kind: 'Aerial', fps: 30, res: '3840×2160', codec: 'H.265 · VBR', kbps: 11800, link: 'Air–ground datalink' },
};

const cams = new Map<string, THREE.PerspectiveCamera>();

export function getFeedCamera(key: string): THREE.PerspectiveCamera {
  let c = cams.get(key);
  if (!c) {
    c = new THREE.PerspectiveCamera(45, 16 / 9, 0.5, 9000);
    c.layers.set(0);
    cams.set(key, c);
  }
  return c;
}

const tmpDir = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
const directed: FixedCam = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 52 };

/**
 * Virtual repositioning of the fixed cameras (WASD in Live Feeds). The physical mount stays where it
 * is; the operator gets a movable "virtual view" that starts at the mount and can be reset to it.
 */
export const feedOffsets: Record<'CAM-01' | 'CAM-02', THREE.Vector3> = {
  'CAM-01': new THREE.Vector3(),
  'CAM-02': new THREE.Vector3(),
};

/** Current heading (radians, three.js convention) of a fixed camera including its PTZ pan. */
export function fixedCamYaw(source: 'CAM-01' | 'CAM-02', yawDeg: number) {
  const def = FIXED_CAMS[source];
  tmpDir.copy(def.target).sub(def.pos).normalize();
  return Math.atan2(tmpDir.x, tmpDir.z) + yawDeg * DEG;
}

export function resetFeedOffset(source: 'CAM-01' | 'CAM-02') {
  feedOffsets[source].set(0, 0, 0);
}

// ---- CAM-02 incident director: while the fire response runs, the PTZ follows it (fire → robot →
// decontamination shelter → dock), then hands back to the normal service-yard framing. Everything is a
// function of scene time, so replay frames the same shots; the operator's PTZ moves still apply on top.

const director = {
  target: new THREE.Vector3().copy(FIXED_CAMS['CAM-02'].target),
  fov: FIXED_CAMS['CAM-02'].fov,
  /** wall clock and scene time of the last update */
  last: 0,
  lastT: 0,
  active: false,
};
const shot = new THREE.Vector3();
const fireAt = new THREE.Vector3(FIRE_SITE.fire.x, 2.2, FIRE_SITE.fire.z);
const tentAt = new THREE.Vector3(FIRE_SITE.tent.x, 1.6, FIRE_SITE.tent.z);

/** The shot CAM-02 should hold at scene time t, or null for its normal framing. */
function cam02Shot(t: number): { target: THREE.Vector3; fov: number } | null {
  const scene = engine.effects.some((e) => (e.kind === 'fire' || e.kind === 'decon') && isEffectLive(e, t));
  if (!scene) return null;
  const seg = engine.ugv.current(t);
  const dog = engine.ugvPose(t);
  const toFire = Math.hypot(dog.x - fireAt.x, dog.z - fireAt.z);
  if (seg.type === 'suppress' || (seg.type === 'route' && seg.purpose === 'respond' && toFire < 75)) {
    // robot and fire together
    shot.set((dog.x + fireAt.x) / 2, 1.8, (dog.z + fireAt.z) / 2);
    const range = shot.distanceTo(FIXED_CAMS['CAM-02'].pos);
    return { target: shot, fov: Math.min(34, Math.max(15, (2 * Math.atan((toFire / 2 + 9) / range)) / DEG)) };
  }
  if (seg.type === 'route' && seg.purpose === 'tent') return { target: shot.set(dog.x, 1.4, dog.z), fov: 18 };
  if (seg.type === 'decon') return { target: tentAt, fov: 12.5 };
  if ((seg.type === 'route' && seg.purpose === 'dock') || seg.type === 'charge') return { target: shot.set(FIRE_SITE.dock.x, 1.2, (FIRE_SITE.dock.z + FIRE_SITE.tent.z) / 2), fov: 19 };
  if (seg.type === 'route' && seg.purpose === 'respond') return { target: shot.set(470, 3.5, 220), fov: 34 };
  // before dispatch or after the robot has gone: the whole scene, fire to shelter
  return { target: shot.set(452, 2, 232), fov: 40 };
}

/** Is CAM-02 currently being steered by the incident director? */
export function cam02Directed() {
  return director.active;
}

function updateDirector(t: number) {
  const now = performance.now();
  // cut straight to the shot on the first frame, after the feed was off screen, or when replay jumps
  const cut = director.last === 0 || now - director.last > 1000 || Math.abs(t - director.lastT) > 5000;
  const dt = Math.min(0.1, (now - director.last) / 1000);
  director.last = now;
  director.lastT = t;
  const want = cam02Shot(t);
  director.active = want !== null;
  const def = FIXED_CAMS['CAM-02'];
  const k = cut ? 1 : 1 - Math.exp(-dt * 1.4);
  director.target.lerp(want ? want.target : def.target, k);
  director.fov += ((want ? want.fov : def.fov) - director.fov) * k;
}

function aimFixed(cam: THREE.PerspectiveCamera, def: FixedCam, yawDeg: number, pitchDeg: number, zoom: number, offset?: THREE.Vector3) {
  cam.position.copy(def.pos);
  if (offset) cam.position.add(offset);
  tmpDir.copy(def.target).sub(def.pos).normalize();
  const yaw = Math.atan2(tmpDir.x, tmpDir.z) + yawDeg * DEG;
  const pitch = Math.asin(Math.max(-0.99, Math.min(0.99, tmpDir.y))) + pitchDeg * DEG;
  const look = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  cam.up.copy(up);
  cam.lookAt(look.add(cam.position));
  const fov = def.fov / Math.max(1, zoom);
  if (Math.abs(cam.fov - fov) > 0.01) {
    cam.fov = fov;
    cam.updateProjectionMatrix();
  }
}

export function updateSourceCamera(source: FeedSource, t: number, cam: THREE.PerspectiveCamera) {
  if (source === 'CAM-01' || source === 'CAM-02') {
    const p = useUI.getState().ptz[source];
    if (source === 'CAM-02') {
      updateDirector(t);
      const def = FIXED_CAMS['CAM-02'];
      directed.pos.copy(def.pos);
      directed.target.copy(director.target);
      directed.fov = director.fov;
      aimFixed(cam, directed, p.yaw, p.pitch, p.zoom, feedOffsets[source]);
      return;
    }
    aimFixed(cam, FIXED_CAMS[source], p.yaw, p.pitch, p.zoom, feedOffsets[source]);
    return;
  }
  if (source === 'UGV-01') {
    // the robot's head camera: low, rides the gait; locks onto what it is working on
    const v = assetVisual.ugv;
    cam.position.copy(v.cam);
    const seg = engine.ugv.current(t);
    if (seg.type === 'hold' && seg.lookAt) cam.lookAt(seg.lookAt.x, 1.6, seg.lookAt.z);
    else if (seg.type === 'suppress') cam.lookAt(seg.target.x, 1.5, seg.target.z);
    else cam.lookAt(v.cam.x + v.camDir.x * 40, v.cam.y + v.camDir.y * 40, v.cam.z + v.camDir.z * 40);
    if (Math.abs(cam.fov - 52) > 0.01) {
      cam.fov = 52;
      cam.updateProjectionMatrix();
    }
    return;
  }
  // UAV gimbal
  const u = assetVisual.uav;
  cam.position.set(u.x, u.y - 1.4, u.z);
  const target = engine.uav.lookTarget(t);
  cam.lookAt(target.x, target.y, target.z);
  if (Math.abs(cam.fov - 52) > 0.01) {
    cam.fov = 52;
    cam.updateProjectionMatrix();
  }
}

/** Slowly orbiting picture-in-picture view of a location (twin preview, not a CCTV). */
export function updatePipCamera(cam: THREE.PerspectiveCamera, center: { x: number; z: number }) {
  const a = performance.now() / 1000 * 0.05;
  cam.position.set(center.x + Math.cos(a) * 240, 150, center.z + Math.sin(a) * 240);
  cam.lookAt(center.x, 12, center.z);
  if (Math.abs(cam.fov - 34) > 0.01) {
    cam.fov = 34;
    cam.updateProjectionMatrix();
  }
}
