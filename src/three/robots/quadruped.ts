import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { PartSet, disposeTree, place, standard } from './parts';

// Procedural quadruped UGV ("robot dog"): a four-legged inspection robot carrying a CBRN sensor module and
// a water-mist suppression turret. Built from primitives at real-world size (metres, forward = +z, model
// left = +x) and animated with a two-link leg IK under a trot that blends into a bound at sprint speed.

/** Real-world size × this factor, so the robot reads at site scale next to people and vehicles. */
export const DOG_SCALE = 1.35;
const HIP_H = 0.5; // standing hip height
const L1 = 0.32; // hip → knee
const L2 = 0.33; // knee → foot
const LEG_X = 0.205; // leg plane, either side of the body
const LEG_Z = 0.355; // hips fore / aft of the body centre
const TURRET = new THREE.Vector3(0, 0.205, 0.27); // turret pivot, body frame

export type DogMode = 'walk' | 'stand' | 'spray' | 'sit';

export interface DogState {
  /** world speed, m/s */
  speed: number;
  mode: DogMode;
  /** world point the suppression turret aims at, with the launch elevation (rad) for the water arc */
  aim?: { target: THREE.Vector3; elevation: number } | null;
}

interface Leg {
  side: 1 | -1;
  front: boolean;
  trot: number;
  bound: number;
  hip: THREE.Group;
  knee: THREE.Group;
}

function materials() {
  return {
    yellow: standard('robot_yellow', '#f2b51c', 0.42, 0.08),
    black: standard('robot_black', '#1c1f24', 0.55, 0.22),
    joint: standard('robot_joint', '#2c3138', 0.38, 0.55),
    rubber: standard('robot_rubber', '#121314', 0.92, 0),
    lens: standard('robot_lens', '#06080c', 0.06, 0.65),
    red: standard('robot_red', '#c3271d', 0.38, 0.32),
    white: standard('robot_white', '#d8dce1', 0.5, 0.1),
    chrome: standard('robot_chrome', '#a9b1ba', 0.22, 0.95),
    led: standard('robot_led', '#0b3b40', 0.4, 0, { emissive: new THREE.Color('#3cc8dc'), emissiveIntensity: 2.4 }),
    status: standard('robot_status', '#2b3a1c', 0.4, 0, { emissive: new THREE.Color('#3dd68c'), emissiveIntensity: 3 }),
  };
}

const rbox = (w: number, h: number, d: number, r: number, seg = 3) => new RoundedBoxGeometry(w, h, d, seg, r);
const cylX = (r: number, len: number, seg = 18) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2);
const cylZ = (r: number, len: number, seg = 18) => new THREE.CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2);

export class QuadrupedRig {
  /** placed on the ground by the caller (position + rotation.y) */
  readonly root = new THREE.Group();
  /** hip-plane frame: lifts, bobs and pitches with the gait */
  readonly body = new THREE.Group();
  private turretYaw = new THREE.Group();
  private turretPitch = new THREE.Group();
  private nozzle = new THREE.Object3D();
  private camera = new THREE.Object3D();
  private legs: Leg[] = [];
  private mats = materials();
  private phase = 0;
  private gait = 0;
  private height = HIP_H;
  private yaw = 0;
  private pitch = 0.18;
  private t = 0;

  constructor() {
    this.root.name = 'UGV-01';
    this.root.scale.setScalar(DOG_SCALE);
    this.root.add(this.body);
    this.body.position.y = HIP_H;
    this.buildBody();
    for (const [side, front] of [
      [1, true],
      [-1, true],
      [1, false],
      [-1, false],
    ] as const) {
      this.legs.push(this.buildLeg(side, front));
    }
    this.buildTurret();
  }

  private buildBody() {
    const { yellow, black, joint, lens, led, red, white, status, chrome } = this.mats;
    const parts = new PartSet();
    // chassis: yellow upper shell over a black belly, sloped sensor head and rear bumper
    parts.add(yellow, place(rbox(0.31, 0.085, 0.8, 0.035), 0, 0.075, 0));
    parts.add(yellow, place(rbox(0.012, 0.05, 0.5, 0.005, 2), 0.158, 0.04, 0.02));
    parts.add(yellow, place(rbox(0.012, 0.05, 0.5, 0.005, 2), -0.158, 0.04, 0.02));
    parts.add(black, place(rbox(0.3, 0.11, 0.86, 0.04), 0, -0.004, 0));
    parts.add(black, place(rbox(0.27, 0.12, 0.11, 0.03), 0, 0.02, 0.448, 0.36));
    parts.add(black, place(rbox(0.27, 0.105, 0.09, 0.028), 0, 0.022, -0.452, -0.25));
    // hip actuators
    for (const sx of [1, -1]) for (const sz of [1, -1]) parts.add(joint, place(cylX(0.056, 0.08), sx * 0.168, -0.012, sz * LEG_Z));
    // stereo depth cameras on the head, side and rear cameras
    for (const x of [-0.07, 0.07]) parts.add(lens, place(cylZ(0.021, 0.012), x, 0.045, 0.506, 0.36));
    parts.add(led, place(new THREE.BoxGeometry(0.15, 0.011, 0.006), 0, -0.004, 0.5, 0.36));
    for (const sx of [1, -1]) parts.add(lens, place(new THREE.BoxGeometry(0.004, 0.026, 0.07), sx * 0.151, 0.0, 0.33));
    parts.add(lens, place(cylZ(0.018, 0.01), 0, 0.04, -0.5, -0.25));
    // payload rail
    parts.add(black, place(new THREE.BoxGeometry(0.2, 0.024, 0.6), 0, 0.128, -0.02));
    // suppression tank (water / foam) with straps, and the hose to the turret
    parts.add(red, place(new THREE.CapsuleGeometry(0.068, 0.24, 6, 20).rotateX(Math.PI / 2), 0, 0.212, -0.06));
    for (const z of [-0.15, 0.03]) parts.add(black, place(new THREE.TorusGeometry(0.07, 0.007, 6, 24), 0, 0.212, z));
    const hose = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.215, 0.13), new THREE.Vector3(0, 0.245, 0.2), new THREE.Vector3(0, 0.215, 0.255)]);
    parts.add(black, new THREE.TubeGeometry(hose, 12, 0.011, 6, false));
    // CBRN chemical detection module: sampling head, intake grille, antenna with status light
    parts.add(white, place(rbox(0.13, 0.085, 0.12, 0.015, 2), 0, 0.182, -0.275));
    parts.add(black, place(new THREE.BoxGeometry(0.09, 0.03, 0.006), 0, 0.185, -0.338));
    parts.add(black, place(new THREE.CylinderGeometry(0.0045, 0.0045, 0.27, 6), 0.045, 0.36, -0.3));
    parts.add(status, place(new THREE.SphereGeometry(0.012, 10, 8), 0.045, 0.5, -0.3));
    parts.add(chrome, place(cylX(0.012, 0.03, 10), 0.075, 0.2, -0.24));
    this.body.add(parts.build('dog-body'));
    // front camera for the robot's video feed (looks slightly down, like the head cameras)
    this.camera.position.set(0, 0.06, 0.53);
    this.camera.rotation.set(0.12, 0, 0);
    this.body.add(this.camera);
  }

  private buildLeg(side: 1 | -1, front: boolean): Leg {
    const { yellow, black, joint, rubber } = this.mats;
    const hip = new THREE.Group();
    hip.position.set(side * LEG_X, -0.012, front ? LEG_Z : -LEG_Z);
    const thigh = new PartSet();
    thigh.add(joint, cylX(0.046, 0.075));
    thigh.add(yellow, place(rbox(0.058, 0.25, 0.088, 0.022), side * 0.004, -0.15, 0));
    thigh.add(black, place(rbox(0.048, 0.3, 0.058, 0.016), -side * 0.012, -0.165, 0));
    hip.add(thigh.build(`dog-thigh-${front ? 'f' : 'r'}${side > 0 ? 'l' : 'r'}`));
    const knee = new THREE.Group();
    knee.position.y = -L1;
    const shin = new PartSet();
    shin.add(joint, cylX(0.03, 0.058));
    shin.add(black, place(new THREE.CylinderGeometry(0.024, 0.016, L2 - 0.03, 12), 0, -(L2 - 0.03) / 2, 0));
    shin.add(rubber, place(new THREE.SphereGeometry(0.034, 14, 10), 0, -L2, 0, 0, 0, 0, 1, 0.8, 1));
    knee.add(shin.build(`dog-shin-${front ? 'f' : 'r'}${side > 0 ? 'l' : 'r'}`));
    hip.add(knee);
    this.body.add(hip);
    // trot pairs diagonal legs; a bound pairs the fronts and the rears
    const trot = (side > 0) === front ? 0 : 0.5;
    const bound = front ? (side > 0 ? 0 : 0.08) : side > 0 ? 0.5 : 0.58;
    return { side, front, trot, bound, hip, knee };
  }

  private buildTurret() {
    const { black, joint, chrome, red } = this.mats;
    const base = new PartSet();
    base.add(black, place(new THREE.CylinderGeometry(0.046, 0.05, 0.034, 18), 0, 0.017, 0));
    this.turretYaw.position.copy(TURRET);
    this.turretYaw.add(base.build('dog-turret-base'));
    this.turretPitch.position.y = 0.05;
    const head = new PartSet();
    head.add(joint, cylX(0.026, 0.07));
    head.add(black, place(rbox(0.05, 0.052, 0.15, 0.012, 2), 0, 0, 0.06));
    head.add(chrome, place(cylZ(0.014, 0.075, 12), 0, 0, 0.17));
    head.add(red, place(cylZ(0.017, 0.012, 12), 0, 0, 0.142));
    this.turretPitch.add(head.build('dog-turret-head'));
    this.nozzle.position.set(0, 0, 0.21);
    this.turretPitch.add(this.nozzle);
    this.turretYaw.add(this.turretPitch);
    this.body.add(this.turretYaw);
  }

  /** Two-link IK in the leg's sagittal plane: knees bend backwards on all four legs. */
  private solveLeg(leg: Leg, fz: number, fy: number) {
    const r = Math.min(L1 + L2 - 1e-3, Math.max(Math.abs(L1 - L2) + 1e-3, Math.hypot(fz, fy)));
    const theta = Math.atan2(fz, -fy); // hip→foot angle from straight down, positive forwards
    const alpha = Math.acos(Math.min(1, Math.max(-1, (L1 * L1 + r * r - L2 * L2) / (2 * L1 * r))));
    const a1 = theta - alpha; // thigh angle from down (negative = knee behind the hip)
    const kz = Math.sin(a1) * L1;
    const ky = -Math.cos(a1) * L1;
    const a2 = Math.atan2(fz - kz, -(fy - ky));
    leg.hip.rotation.x = -a1;
    leg.knee.rotation.x = -(a2 - a1);
  }

  /** Advances the gait and poses legs, body and turret. `dt` in seconds. */
  update(dt: number, state: DogState) {
    this.t += dt;
    const v = Math.max(0, state.speed) / DOG_SCALE; // model-space speed
    const moving = state.mode === 'walk' && v > 0.04;
    const k = 1 - Math.exp(-dt * 6);
    this.gait += ((moving ? 1 : 0) - this.gait) * k;
    const targetH = state.mode === 'sit' ? 0.2 : state.mode === 'spray' ? 0.45 : HIP_H;
    this.height += (targetH - this.height) * (1 - Math.exp(-dt * (state.mode === 'sit' ? 1.6 : 4)));

    const freq = 1.7 + 0.42 * Math.min(v, 6.5);
    this.phase = (this.phase + dt * freq * Math.max(this.gait, 0.0001)) % 1;
    const sprint = smooth01((v - 4.2) / 1.4);
    const duty = 0.6 - 0.22 * smooth01((v - 2.5) / 3);
    const stride = Math.min(0.66, (v * duty) / freq);
    const lift = (0.055 + 0.05 * Math.min(1, v / 3)) * this.gait;

    for (const leg of this.legs) {
      const offset = leg.trot + (leg.bound - leg.trot) * sprint;
      const p = (this.phase + offset) % 1;
      let z: number;
      let y = 0;
      if (p < duty) z = stride / 2 - stride * (p / duty);
      else {
        const s = (p - duty) / (1 - duty);
        z = -stride / 2 + stride * (0.5 - 0.5 * Math.cos(Math.PI * s));
        y = lift * Math.sin(Math.PI * s);
      }
      // feet sit a little ahead of the rear hips and behind the front ones, like a planted stance
      const rest = leg.front ? -0.015 : 0.03;
      this.solveLeg(leg, rest + z * this.gait, -this.height + y);
    }

    // body: trot bob (two footfalls per cycle) and a pitch rock when bounding
    const bob = -0.009 * this.gait * (0.5 + 0.5 * Math.cos(4 * Math.PI * this.phase)) * (1 - sprint);
    const rock = 0.07 * sprint * this.gait * Math.sin(2 * Math.PI * this.phase);
    const breathe = state.mode === 'sit' ? 0 : 0.003 * Math.sin(this.t * 1.9) * (1 - this.gait);
    this.body.position.y = this.height + bob + breathe;
    this.body.rotation.x = rock;

    // turret: track the aim point while spraying, park facing forwards otherwise
    let yaw = 0;
    let pitch = 0.18;
    if (state.mode === 'spray' && state.aim) {
      this.root.updateMatrixWorld(true);
      const local = this.body.worldToLocal(state.aim.target.clone()).sub(this.turretYaw.position);
      yaw = Math.atan2(local.x, local.z);
      pitch = -state.aim.elevation;
    }
    const ka = 1 - Math.exp(-dt * 5);
    this.yaw += (yaw - this.yaw) * ka;
    this.pitch += (pitch - this.pitch) * ka;
    this.turretYaw.rotation.y = this.yaw;
    this.turretPitch.rotation.x = this.pitch;
  }

  /** Nozzle tip position and spray direction in world space. */
  nozzleWorld(pos: THREE.Vector3, dir: THREE.Vector3) {
    this.root.updateMatrixWorld(true);
    this.nozzle.getWorldPosition(pos);
    dir.set(0, 0, 1).transformDirection(this.nozzle.matrixWorld);
  }

  /** Front camera pose in world space (for the robot's video feed). */
  cameraWorld(pos: THREE.Vector3, dir: THREE.Vector3) {
    this.root.updateMatrixWorld(true);
    this.camera.getWorldPosition(pos);
    dir.set(0, 0, 1).transformDirection(this.camera.matrixWorld);
  }

  /** Status light on the sensor mast: green patrolling, amber tasked, red suppressing. */
  setStatus(hex: string, intensity = 3) {
    this.mats.status.emissive.set(hex);
    this.mats.status.emissiveIntensity = intensity;
  }

  dispose() {
    disposeTree(this.root);
  }
}

function smooth01(x: number) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}
