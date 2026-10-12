import * as THREE from 'three';
import { useUI, type FeedSource } from '../store/ui';
import { engine } from '../simulation/engine';
import { assetVisual, UGV_SCALE } from './AssetLayer';
import { DEG } from '../utils/math';

// Synthetic surveillance cameras inside the same three.js scene. Positions are fictional.

interface FixedCam {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
}

export const FIXED_CAMS: Record<'CAM-01' | 'CAM-02', FixedCam> = {
  'CAM-01': { pos: new THREE.Vector3(-560, 62, 52), target: new THREE.Vector3(-60, 18, -118), fov: 34 },
  'CAM-02': { pos: new THREE.Vector3(396, 12.5, 166), target: new THREE.Vector3(452, 1.4, 210), fov: 52 },
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
    aimFixed(cam, FIXED_CAMS[source], p.yaw, p.pitch, p.zoom, feedOffsets[source]);
    return;
  }
  if (source === 'UGV-01') {
    const v = assetVisual.ugv;
    const h = v.heading;
    const mastBack = -0.52 * UGV_SCALE;
    const camX = v.x + Math.sin(h) * (mastBack + 0.3);
    const camZ = v.z + Math.cos(h) * (mastBack + 0.3);
    const shake = v.speed > 0.3 ? Math.sin(performance.now() / 55) * 0.012 : 0;
    cam.position.set(camX, 1.86 * UGV_SCALE + 0.15 + shake, camZ);
    const seg = engine.ugv.current(t);
    const lookAt = seg.type === 'hold' ? seg.lookAt : null;
    if (lookAt) cam.lookAt(lookAt.x, 1.6, lookAt.z);
    else cam.lookAt(camX + Math.sin(h) * 40, 0.6, camZ + Math.cos(h) * 40);
    if (Math.abs(cam.fov - 44) > 0.01) {
      cam.fov = 44;
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
