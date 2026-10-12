import * as THREE from 'three';
import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { CameraControls } from '@react-three/drei';
import type CameraControlsImpl from 'camera-controls';
import { useViewports } from './viewports';
import { useUI, type Selection } from '../store/ui';
import { useSim } from '../store/sim';
import { SENSOR_BY_ID } from '../simulation/sensors';
import { zoneById } from '../data/site';
import { assetVisual } from './AssetLayer';
import type { AssetId, FocusTarget } from '../types';
import { RESPONSE_VEHICLE_POSE } from '../simulation/assets';
import { installMovementKeys, movementAxes, clearMovementKeys } from './movementKeys';
import { FIXED_CAMS, feedOffsets, fixedCamYaw } from './feedCameras';
import { clamp } from '../utils/math';

/** Initial oblique aerial view from over the sea, looking south-east across the campus. */
export const HOME = { pos: new THREE.Vector3(-970, 505, -1110), target: new THREE.Vector3(30, 0, -40) };

/** A new incident is framed automatically only if the operator hasn't moved the camera this recently. */
const AUTO_FRAME_IDLE_MS = 20_000;

const rig: { controls: CameraControlsImpl | null; lastManual: number } = { controls: null, lastManual: -Infinity };

/** Any operator-driven camera change (drag, wheel, keys, focus buttons) defers auto-framing. */
const markManual = () => {
  rig.lastManual = performance.now();
};

function lookAtFrom(target: THREE.Vector3, distance: number, polar: number, smooth = true) {
  const c = rig.controls;
  if (!c) return;
  const az = c.azimuthAngle;
  const pos = new THREE.Vector3(
    target.x + distance * Math.sin(polar) * Math.sin(az),
    target.y + distance * Math.cos(polar),
    target.z + distance * Math.sin(polar) * Math.cos(az),
  );
  void c.setLookAt(pos.x, pos.y, pos.z, target.x, target.y, target.z, smooth);
}

function assetPosition(id: AssetId): THREE.Vector3 {
  if (id === 'UGV-01') return new THREE.Vector3(assetVisual.ugv.x, 1, assetVisual.ugv.z);
  if (id === 'UAV-01') return new THREE.Vector3(assetVisual.uav.x, assetVisual.uav.y, assetVisual.uav.z);
  if (id === 'TEAM-1') return new THREE.Vector3(assetVisual.team[0].x, 1, assetVisual.team[0].z);
  return new THREE.Vector3(RESPONSE_VEHICLE_POSE.x, 2, RESPONSE_VEHICLE_POSE.z);
}

export function focusOn(target: FocusTarget | Exclude<Selection, null>) {
  markManual();
  const ui = useUI.getState();
  switch (target.kind) {
    case 'sensor': {
      const s = SENSOR_BY_ID[target.id];
      if (!s) return;
      ui.setFollow(null);
      lookAtFrom(new THREE.Vector3(s.x, s.kind === 'met' ? 30 : 4, s.z), s.kind === 'met' ? 260 : 190, 0.92);
      return;
    }
    case 'asset': {
      const p = assetPosition(target.id);
      lookAtFrom(p, target.id === 'UAV-01' ? 210 : target.id === 'UGV-01' ? 60 : 110, target.id === 'UAV-01' ? 1.0 : 0.95);
      ui.setFollow(target.id === 'UGV-01' || target.id === 'UAV-01' || target.id === 'TEAM-1' ? target.id : null);
      return;
    }
    case 'zone': {
      const z = zoneById(target.id);
      if (!z) return;
      ui.setFollow(null);
      const size = Math.max(z.maxX - z.minX, z.maxZ - z.minZ);
      lookAtFrom(new THREE.Vector3((z.minX + z.maxX) / 2, 10, (z.minZ + z.maxZ) / 2), Math.max(220, size * 1.9), 0.9);
      return;
    }
    case 'location': {
      ui.setFollow(null);
      const r = 'radius' in target && target.radius ? target.radius : 120;
      lookAtFrom(new THREE.Vector3(target.x, 6, target.z), Math.max(200, r * 3), 0.92);
      return;
    }
  }
}

export function resetView() {
  markManual();
  useUI.getState().setFollow(null);
  void rig.controls?.setLookAt(HOME.pos.x, HOME.pos.y, HOME.pos.z, HOME.target.x, HOME.target.y, HOME.target.z, true);
}

export function zoomBy(factor: number) {
  const c = rig.controls;
  if (!c) return;
  markManual();
  void c.dolly(c.distance * factor, true);
}

export function cameraAzimuth() {
  return rig.controls?.azimuthAngle ?? 0;
}

export function setCameraPose(pos: [number, number, number], target: [number, number, number], smooth = true) {
  markManual();
  useUI.getState().setFollow(null);
  void rig.controls?.setLookAt(pos[0], pos[1], pos[2], target[0], target[1], target[2], smooth);
}

export function getCameraPose() {
  const c = rig.controls;
  if (!c) return null;
  return { pos: c.getPosition(new THREE.Vector3()).toArray(), target: c.getTarget(new THREE.Vector3()).toArray() };
}

// automation hook (scripted demos / screenshot capture / QA)
(window as unknown as { __ENCIRRA_CAMERA__: unknown }).__ENCIRRA_CAMERA__ = { focusOn, resetView, setCameraPose, getCameraPose };

export function CameraRig() {
  const main = useViewports((s) => s.main);
  const ref = useRef<CameraControlsImpl>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    rig.controls = c;
    void c.setLookAt(HOME.pos.x, HOME.pos.y, HOME.pos.z, HOME.target.x, HOME.target.y, HOME.target.z, false);
    const stopFollow = () => {
      markManual();
      useUI.getState().setFollow(null);
    };
    c.addEventListener('controlstart', stopFollow);
    return () => {
      c.removeEventListener('controlstart', stopFollow);
      rig.controls = null;
    };
  }, []);

  // ---- frame new incidents (Settings → Display), unless the operator is driving the camera
  useEffect(() => {
    const seen = new Set(useSim.getState().incidents.map((i) => i.id));
    return useSim.subscribe((s) => {
      for (const inc of s.incidents) {
        if (seen.has(inc.id)) continue;
        seen.add(inc.id);
        const ui = useUI.getState();
        if (inc.status === 'resolved' || !ui.settings.autoFrame || ui.follow || ui.playback.mode === 'replay') continue;
        if (performance.now() - rig.lastManual < AUTO_FRAME_IDLE_MS) continue;
        lookAtFrom(new THREE.Vector3(inc.location.x, 6, inc.location.z), 780, 1.02);
      }
    });
  }, []);

  // ---- WASD navigation: twin camera on Overview / 3D Twin, virtual view of fixed cameras in Live Feeds
  useEffect(
    () =>
      installMovementKeys(() => {
        const ui = useUI.getState();
        if (ui.paletteOpen || ui.settingsOpen) return false;
        if (ui.screen === 'overview' || ui.screen === 'twin') return true;
        return ui.screen === 'feeds' && (ui.feedMain === 'CAM-01' || ui.feedMain === 'CAM-02');
      }),
    [],
  );

  const tmpTarget = useRef(new THREE.Vector3());
  const move = useRef({ fwd: new THREE.Vector3(), right: new THREE.Vector3(), lastStore: 0 });
  useFrame((_, delta) => {
    const ax = movementAxes();
    if (!ax.active) return;
    markManual();
    const ui = useUI.getState();
    if (ui.paletteOpen || ui.settingsOpen) {
      clearMovementKeys();
      return;
    }
    const dt = Math.min(delta, 0.05);
    if (ui.screen === 'overview' || ui.screen === 'twin') {
      const c = rig.controls;
      if (!c) return;
      if (ui.follow) ui.setFollow(null);
      // speed scales with zoom so close inspection stays precise and site-wide moves stay quick
      const speed = clamp(c.distance * 0.7, 18, 700) * (ax.fast ? 3 : 1) * dt;
      if (ax.fwd) void c.forward(ax.fwd * speed, false);
      if (ax.right) void c.truck(ax.right * speed, 0, false);
      if (ax.up) void c.elevate(ax.up * speed * 0.6, false);
      const t = c.getTarget(tmpTarget.current);
      const x = clamp(t.x, -3500, 3500);
      const y = clamp(t.y, 0, 600);
      const z = clamp(t.z, -3500, 3500);
      if (x !== t.x || y !== t.y || z !== t.z) void c.moveTo(x, y, z, false);
      return;
    }
    if (ui.screen === 'feeds' && (ui.feedMain === 'CAM-01' || ui.feedMain === 'CAM-02')) {
      const cam = ui.feedMain;
      const off = feedOffsets[cam];
      const base = FIXED_CAMS[cam].pos;
      const yaw = fixedCamYaw(cam, ui.ptz[cam].yaw);
      const m = move.current;
      m.fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
      m.right.set(-Math.cos(yaw), 0, Math.sin(yaw));
      const speed = (ax.fast ? 36 : 12) * dt;
      off.addScaledVector(m.fwd, ax.fwd * speed).addScaledVector(m.right, ax.right * speed);
      off.y += ax.up * speed * 0.6;
      off.x = clamp(off.x, -2500 - base.x, 2500 - base.x);
      off.y = clamp(off.y, 1.7 - base.y, 400 - base.y);
      off.z = clamp(off.z, -2500 - base.z, 2500 - base.z);
      const now = performance.now();
      if (now - m.lastStore > 200) {
        m.lastStore = now;
        ui.setFeedMoved(cam, off.length());
      }
    }
  }, 0.55);

  useFrame(() => {
    const c = rig.controls;
    const follow = useUI.getState().follow;
    if (!c || !follow) return;
    const p = assetPosition(follow);
    c.getTarget(tmpTarget.current);
    if (tmpTarget.current.distanceTo(p) > 120) {
      // large jump (replay scrub, re-tasking): re-frame from a clean angle instead of dragging
      // the camera through buildings
      lookAtFrom(p, follow === 'UAV-01' ? 210 : follow === 'UGV-01' ? 60 : 95, follow === 'UAV-01' ? 1.0 : 0.95);
      return;
    }
    void c.moveTo(p.x, p.y, p.z, true);
  }, 0.6);

  return (
    <CameraControls
      ref={ref}
      makeDefault
      domElement={main?.inputEl}
      smoothTime={0.55}
      draggingSmoothTime={0.12}
      minDistance={18}
      maxDistance={3800}
      minPolarAngle={0.12}
      maxPolarAngle={1.38}
      dollyToCursor
      azimuthRotateSpeed={0.55}
      polarRotateSpeed={0.55}
      truckSpeed={1.6}
      dollySpeed={0.7}
    />
  );
}
