import * as THREE from 'three';
import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { MODELS, prepareModel, useModel } from './models';
import { registerThermalTree } from './thermal';
import { registerPickable } from './picking';
import { engine } from '../simulation/engine';
import { RESPONSE_VEHICLE_POSE } from '../simulation/assets';
import { SENSORS } from '../simulation/sensors';
import { sceneClock } from './sceneClock';
import { angleDeltaRad, clamp } from '../utils/math';
import { QuadrupedRig, DOG_SCALE, type DogState } from './robots/quadruped';
import { QuadcopterRig, UAV_SCALE } from './robots/quadcopter';
import { launchElevation } from './robots/spray';

export const UGV_SCALE = DOG_SCALE;
export { UAV_SCALE };

/** Damped visual state of moving assets (read by feed cameras, the fire layer and DOM overlays). */
export const assetVisual = {
  ugv: {
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
    speed: 0,
    ready: false,
    /** front camera pose (world) for the robot's video feed */
    cam: new THREE.Vector3(),
    camDir: new THREE.Vector3(0, 0, 1),
    /** suppression nozzle tip and jet direction (world) */
    nozzle: new THREE.Vector3(),
    nozzleDir: new THREE.Vector3(0, 0, 1),
    spraying: false,
    washing: false,
  },
  uav: { x: 0, y: 120, z: 0, heading: 0, roll: 0, ready: false },
  team: [0, 1, 2].map(() => ({ x: 0, z: 0, heading: 0 })),
};

/** Status light colour by activity: green on patrol, amber responding, red spraying, cyan in decon. */
function statusFor(state: DogState, washing: boolean, responding: boolean, t: number): [string, number] {
  if (state.mode === 'spray') return ['#ff3b30', Math.floor(t / 260) % 2 ? 5 : 1.2];
  if (washing) return ['#3cc8dc', 3.5];
  if (state.mode === 'sit') return ['#3dd68c', 1.5 + 1.5 * Math.sin(t / 600)];
  if (responding) return ['#f2b33d', Math.floor(t / 420) % 2 ? 4 : 1];
  return ['#3dd68c', 3];
}

function pickBox(w: number, h: number, d: number, y = h / 2) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ visible: false }));
  m.position.y = y;
  return m;
}

function SensorNodes() {
  const gltf = useModel(MODELS.sensor);
  const group = useMemo(() => {
    const g = new THREE.Group();
    g.name = 'sensor-nodes';
    const nodes = SENSORS.filter((s) => s.kind !== 'met');
    const m = new THREE.Matrix4();
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, nodes.length);
      nodes.forEach((s, i) => {
        m.makeRotationY((i * 1.7) % (Math.PI * 2));
        m.setPosition(s.x, 0, s.z);
        m.multiply(mesh.matrixWorld);
        im.setMatrixAt(i, m);
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      g.add(im);
    });
    prepareModel(g);
    return g;
  }, [gltf]);
  useEffect(() => registerThermalTree(group), [group]);
  return <primitive object={group} />;
}

export function AssetLayer() {
  const personGltf = useModel(MODELS.person);
  const vehicleGltf = useModel(MODELS.vehicle);

  // UGV-01: procedural quadruped (three.js), see robots/quadruped.ts
  const ugv = useMemo(() => {
    const g = new THREE.Group();
    g.name = 'UGV-01';
    const rig = new QuadrupedRig();
    rig.root.name = 'ugv-rig';
    prepareModel(rig.root);
    g.add(rig.root);
    const proxy = pickBox(2.4, 2.2, 2.8);
    g.add(proxy);
    return { group: g, proxy, rig };
  }, []);

  // UAV-01: procedural quadcopter (three.js), see robots/quadcopter.ts
  const uav = useMemo(() => {
    const g = new THREE.Group();
    g.name = 'UAV-01';
    const rig = new QuadcopterRig();
    rig.root.name = 'uav-rig';
    prepareModel(rig.root, { cast: true, receive: false });
    g.add(rig.root);
    const proxy = pickBox(9, 5, 9, 0);
    g.add(proxy);
    return { group: g, proxy, rig };
  }, []);

  useEffect(
    () => () => {
      ugv.rig.dispose();
      uav.rig.dispose();
    },
    [ugv, uav],
  );

  const team = useMemo(
    () =>
      [0, 1, 2].map((i) => {
        const g = new THREE.Group();
        g.name = `TEAM-${i + 1}`;
        const body = personGltf.scene.clone(true);
        prepareModel(body);
        g.add(body);
        const proxy = pickBox(2.4, 2.6, 2.4);
        g.add(proxy);
        return { group: g, proxy };
      }),
    [personGltf],
  );

  const vehicle = useMemo(() => {
    const g = new THREE.Group();
    g.name = 'RV-02';
    const body = vehicleGltf.scene;
    prepareModel(body);
    g.add(body);
    g.position.set(RESPONSE_VEHICLE_POSE.x, 0, RESPONSE_VEHICLE_POSE.z);
    g.rotation.y = RESPONSE_VEHICLE_POSE.heading;
    const proxy = pickBox(4, 4, 10);
    g.add(proxy);
    return { group: g, proxy };
  }, [vehicleGltf]);

  useEffect(() => {
    const offs = [
      registerThermalTree(ugv.group),
      registerThermalTree(uav.group),
      registerThermalTree(vehicle.group),
      ...team.map((p) => registerThermalTree(p.group)),
      registerPickable({ object: ugv.proxy, selection: { kind: 'asset', id: 'UGV-01' }, priority: 0, area: 1 }),
      registerPickable({ object: uav.proxy, selection: { kind: 'asset', id: 'UAV-01' }, priority: 0, area: 1 }),
      registerPickable({ object: vehicle.proxy, selection: { kind: 'asset', id: 'RV-02' }, priority: 0, area: 1 }),
      ...team.map((p) => registerPickable({ object: p.proxy, selection: { kind: 'asset', id: 'TEAM-1' }, priority: 0, area: 1 })),
    ];
    return () => offs.forEach((f) => f());
  }, [ugv, uav, vehicle, team]);

  const aimTarget = useMemo(() => new THREE.Vector3(), []);
  const lookAt = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const t = sceneClock.t;
    const k = 1 - Math.exp(-dt * 7);

    // UGV: pose from the engine plan, gait / turret / sit from its activity
    const p = engine.ugvPose(t);
    const v = assetVisual.ugv;
    if (!v.ready || sceneClock.replay) {
      v.heading = p.heading;
      v.ready = true;
    }
    v.heading += angleDeltaRad(v.heading, p.heading) * k;
    v.x = p.x;
    v.z = p.z;
    v.speed = p.speed;
    ugv.group.position.set(p.x, 0, p.z);
    ugv.group.rotation.y = v.heading;
    const act = engine.ugv.activity(t);
    const state: DogState = { speed: p.speed, mode: act.mode, aim: null };
    if (act.mode === 'spray' && act.target) {
      aimTarget.set(act.target.x, 1.2, act.target.z);
      state.aim = { target: aimTarget, elevation: launchElevation(v.nozzle, aimTarget) };
    }
    ugv.rig.update(dt, state);
    const seg = engine.ugv.current(t);
    const [hex, glow] = statusFor(state, !!act.washing, seg.type === 'route' && seg.purpose === 'respond', performance.now());
    ugv.rig.setStatus(hex, glow);
    ugv.rig.cameraWorld(v.cam, v.camDir);
    ugv.rig.nozzleWorld(v.nozzle, v.nozzleDir);
    v.spraying = !!act.spraying;
    v.washing = !!act.washing;

    // UAV with banking into turns
    const q = engine.uavPose(t);
    const u = assetVisual.uav;
    if (!u.ready) {
      u.heading = q.heading;
      u.ready = true;
    }
    const prev = u.heading;
    u.heading += angleDeltaRad(u.heading, q.heading) * k;
    const yawRate = angleDeltaRad(prev, u.heading) / Math.max(dt, 1e-3);
    u.roll += (clamp(-yawRate * 0.9, -0.32, 0.32) - u.roll) * k;
    u.x = q.x;
    u.y = q.y + Math.sin(performance.now() / 1800) * 0.6;
    u.z = q.z;
    uav.group.position.set(u.x, u.y, u.z);
    uav.group.rotation.set(0, u.heading, 0);
    // nose down into forward flight, banked into turns
    uav.rig.body.rotation.set(Math.min(0.2, 0.012 * q.speed), 0, u.roll);
    const lt = engine.uav.lookTarget(t);
    lookAt.set(lt.x, lt.y, lt.z);
    uav.rig.update(dt, lookAt);

    // survey team
    team.forEach((m, i) => {
      const tp = engine.teamPose(i, t);
      const walk = tp.speed > 0.1;
      m.group.position.set(tp.x, walk ? Math.abs(Math.sin(performance.now() / 300)) * 0.035 : 0, tp.z);
      m.group.rotation.y = tp.heading;
      assetVisual.team[i] = { x: tp.x, z: tp.z, heading: tp.heading };
    });
  });

  return (
    <group name="assets">
      <primitive object={ugv.group} />
      <primitive object={uav.group} />
      <primitive object={vehicle.group} />
      {team.map((m) => (
        <primitive key={m.group.name} object={m.group} />
      ))}
      <SensorNodes />
    </group>
  );
}
