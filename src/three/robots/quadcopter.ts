import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { PartSet, disposeTree, place, standard } from './parts';

// Procedural quadcopter UAV: X-frame industrial drone with folding arms, four motors with two-blade
// props (plus a motion-blur disc that fades in with rotor speed), a stabilised gimbal camera, landing
// skids and aviation lights. Real-world size (metres, forward = +z), scaled up for site visibility.

export const UAV_SCALE = 2.2;
const ARM = 0.56; // centre → motor
const PROP_R = 0.27;

function materials() {
  return {
    shell: standard('uav_shell', '#2b3038', 0.48, 0.25),
    top: standard('uav_top', '#3b424c', 0.42, 0.3),
    carbon: standard('uav_carbon', '#16191d', 0.5, 0.35),
    accent: standard('uav_accent', '#ff6a1a', 0.45, 0.2),
    motor: standard('uav_motor', '#5b6470', 0.3, 0.85),
    blade: standard('uav_blade', '#121417', 0.55, 0.1),
    blur: new THREE.MeshBasicMaterial({ name: 'rotor_blur', color: '#1a1d22', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    lens: standard('uav_lens', '#05070a', 0.05, 0.7),
    white: standard('uav_white', '#e4e7eb', 0.45, 0.1),
    red: new THREE.MeshStandardMaterial({ name: 'uav_nav_red', color: '#3a0a0a', emissive: new THREE.Color('#ff2d2d'), emissiveIntensity: 3 }),
    green: new THREE.MeshStandardMaterial({ name: 'uav_nav_green', color: '#0a3a12', emissive: new THREE.Color('#2dff6a'), emissiveIntensity: 3 }),
    strobe: new THREE.MeshStandardMaterial({ name: 'uav_strobe', color: '#444', emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0 }),
  };
}

interface Rotor {
  group: THREE.Group;
  dir: 1 | -1;
}

export class QuadcopterRig {
  readonly root = new THREE.Group();
  /** attitude frame (pitch / roll) */
  readonly body = new THREE.Group();
  private gimbalYaw = new THREE.Group();
  private gimbalPitch = new THREE.Group();
  private rotors: Rotor[] = [];
  private mats = materials();
  private spin = 0;
  private t = 0;

  constructor() {
    this.root.name = 'UAV-01';
    this.root.scale.setScalar(UAV_SCALE);
    this.root.add(this.body);
    this.build();
  }

  private build() {
    const m = this.mats;
    const frame = new PartSet();
    // fuselage: shell, raised top cover, GPS puck, battery and a forward sensor nose
    frame.add(m.shell, new RoundedBoxGeometry(0.34, 0.11, 0.44, 3, 0.04));
    frame.add(m.top, place(new RoundedBoxGeometry(0.26, 0.05, 0.3, 3, 0.02), 0, 0.07, -0.02));
    frame.add(m.white, place(new THREE.CylinderGeometry(0.045, 0.05, 0.03, 20), 0, 0.11, -0.06));
    frame.add(m.carbon, place(new RoundedBoxGeometry(0.16, 0.045, 0.2, 2, 0.012), 0, 0.06, -0.19));
    frame.add(m.accent, place(new RoundedBoxGeometry(0.2, 0.03, 0.06, 2, 0.01), 0, 0.02, 0.215));
    // antennas
    for (const x of [-0.11, 0.11]) frame.add(m.carbon, place(new THREE.CylinderGeometry(0.006, 0.006, 0.12, 6), x, 0.09, -0.2, 0.5));
    // arms (X frame) with fold hinges and motor pods
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const ax = Math.sin(a);
      const az = Math.cos(a);
      frame.add(m.carbon, place(new THREE.CylinderGeometry(0.018, 0.022, ARM - 0.12, 10).rotateX(Math.PI / 2), ax * (0.06 + (ARM - 0.12) / 2), 0.0, az * (0.06 + (ARM - 0.12) / 2), 0, a, 0));
      frame.add(m.shell, place(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 12), ax * 0.17, 0.0, az * 0.17));
      frame.add(m.motor, place(new THREE.CylinderGeometry(0.042, 0.046, 0.055, 18), ax * ARM, 0.03, az * ARM));
      frame.add(i < 2 ? m.accent : m.carbon, place(new THREE.CylinderGeometry(0.047, 0.047, 0.012, 18), ax * ARM, 0.0, az * ARM));
    }
    // landing skids
    for (const x of [-0.13, 0.13]) {
      frame.add(m.carbon, place(new THREE.CylinderGeometry(0.009, 0.009, 0.42, 8).rotateX(Math.PI / 2), x, -0.2, 0));
      for (const z of [-0.12, 0.12]) frame.add(m.carbon, place(new THREE.CylinderGeometry(0.008, 0.008, 0.16, 8), x * 0.8, -0.125, z, 0, 0, x > 0 ? -0.3 : 0.3));
    }
    // nav lights: red port (left = +x), green starboard, white strobe aft
    frame.add(m.red, place(new THREE.SphereGeometry(0.016, 10, 8), Math.sin(Math.PI / 4) * ARM, -0.02, Math.cos(Math.PI / 4) * ARM));
    frame.add(m.green, place(new THREE.SphereGeometry(0.016, 10, 8), -Math.sin(Math.PI / 4) * ARM, -0.02, Math.cos(Math.PI / 4) * ARM));
    frame.add(m.strobe, place(new THREE.SphereGeometry(0.014, 10, 8), 0, 0.08, -0.25));
    this.body.add(frame.build('uav-frame'));

    // rotors: two blades + blur disc, counter-rotating pairs
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const g = new THREE.Group();
      g.position.set(Math.sin(a) * ARM, 0.068, Math.cos(a) * ARM);
      const prop = new PartSet();
      prop.add(m.motor, new THREE.CylinderGeometry(0.016, 0.016, 0.02, 10));
      for (const s of [1, -1]) {
        const blade = new THREE.BoxGeometry(0.034, 0.005, PROP_R - 0.02);
        prop.add(m.blade, place(blade, 0, 0, (s * (PROP_R + 0.005)) / 2, s * 0.12, 0, 0));
      }
      g.add(prop.build(`uav-prop-${i}`, { cast: false }));
      const disc = new THREE.Mesh(new THREE.CircleGeometry(PROP_R, 32).rotateX(-Math.PI / 2), m.blur);
      disc.name = `uav-rotor-${i}`;
      disc.renderOrder = 2;
      g.add(disc);
      this.body.add(g);
      this.rotors.push({ group: g, dir: i % 2 === 0 ? 1 : -1 });
    }

    // gimbal under the nose: yoke + camera ball with a lens
    this.gimbalYaw.position.set(0, -0.085, 0.16);
    const yoke = new PartSet();
    yoke.add(m.carbon, place(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 10), 0, 0.0, 0));
    yoke.add(m.shell, place(new THREE.BoxGeometry(0.11, 0.012, 0.03), 0, -0.02, 0));
    for (const x of [-0.05, 0.05]) yoke.add(m.shell, place(new THREE.BoxGeometry(0.01, 0.06, 0.03), x, -0.05, 0));
    this.gimbalYaw.add(yoke.build('uav-gimbal-yoke', { cast: false }));
    this.gimbalPitch.position.y = -0.065;
    const ball = new PartSet();
    ball.add(m.white, new THREE.SphereGeometry(0.045, 20, 14));
    ball.add(m.lens, place(new THREE.CylinderGeometry(0.022, 0.026, 0.02, 16).rotateX(Math.PI / 2), 0, 0, 0.041));
    this.gimbalPitch.add(ball.build('uav-gimbal-ball', { cast: false }));
    this.gimbalYaw.add(this.gimbalPitch);
    this.body.add(this.gimbalYaw);
  }

  /** Spins the rotors, blinks the strobe and points the gimbal at a world target. */
  update(dt: number, lookAt: THREE.Vector3 | null) {
    this.t += dt;
    // rotor speed: steady hover/cruise RPM; blades blur into discs at speed
    this.spin += dt * 70;
    for (const r of this.rotors) r.group.rotation.y = this.spin * r.dir;
    this.mats.blur.opacity = 0.13;
    this.mats.strobe.emissiveIntensity = (this.t % 1.2) < 0.06 || ((this.t - 0.16) % 1.2 + 1.2) % 1.2 < 0.06 ? 9 : 0;
    if (lookAt) {
      const local = this.body.worldToLocal(lookAt.clone()).sub(this.gimbalYaw.position);
      this.gimbalYaw.rotation.y = Math.atan2(local.x, local.z);
      this.gimbalPitch.rotation.x = Math.atan2(-local.y, Math.hypot(local.x, local.z));
    }
  }

  dispose() {
    disposeTree(this.root);
  }
}
