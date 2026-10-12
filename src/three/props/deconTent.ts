import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { PartSet, disposeTree, place, standard } from '../robots/parts';

// DECON-1: an inflatable decontamination shelter (generic field equipment) with arched air beams, a
// fabric vault open at both ends (dirty side east, clean side west), clear PVC windows down both sides,
// a runoff-containing floor tray, overhead shower bars and a light strip, a water bladder, a pump and
// cones. `deploy(k)` inflates it (k 0 → 1).

const L = 10;
const W = 5.4;
const H = 3.1;
const ARCHES = [-4.5, -1.5, 1.5, 4.5];
// skin grid: 40 × 0.25 m along x, 28 steps round the arch; the windows sit exactly on grid lines
const NX = 40;
const NT = 28;
const WIN_X: [number, number][] = [
  [-4, -2],
  [-1, 1],
  [2, 4],
];
const WIN_TH: [number, number][] = [
  [(2 * Math.PI) / NT, (5 * Math.PI) / NT],
  [(23 * Math.PI) / NT, (26 * Math.PI) / NT],
];
const inWindow = (x: number, th: number) => WIN_X.some(([a, b]) => x > a && x < b) && WIN_TH.some(([a, b]) => th > a && th < b);

/** Barrel vault swept along x, pillowing slightly between the air beams; `skip` leaves openings. */
function vault(x0: number, x1: number, th0: number, th1: number, nx: number, nt: number, grow = 0, skip?: (x: number, th: number) => boolean) {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= nx; i++) {
    const x = x0 + ((x1 - x0) * i) / nx;
    const pillow = 0.976 + 0.024 * Math.cos((2 * Math.PI * (x + 4.5)) / 3);
    for (let j = 0; j <= nt; j++) {
      const th = th0 + ((th1 - th0) * j) / nt;
      const k = pillow + grow;
      pos.push(x, H * Math.sin(th) * k, (W / 2) * Math.cos(th) * k);
      uv.push(i / nx, j / nt);
    }
  }
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nt; j++) {
      if (skip && skip(x0 + ((x1 - x0) * (i + 0.5)) / nx, th0 + ((th1 - th0) * (j + 0.5)) / nt)) continue;
      const a = i * (nt + 1) + j;
      const b = a + nt + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function signTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = '#f4f5f6';
  g.fillRect(0, 0, 1024, 256);
  g.fillStyle = '#c92a1e';
  g.fillRect(0, 0, 1024, 26);
  g.fillRect(0, 230, 1024, 26);
  g.font = '700 120px "Inter Variable", Inter, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('DECON-1', 512, 112);
  g.fillStyle = '#3b4148';
  g.font = '600 34px "Inter Variable", Inter, Arial, sans-serif';
  g.fillText('DECONTAMINATION  ·  ENTER EAST  ·  EXIT WEST', 512, 196);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export interface DeconTent {
  group: THREE.Group;
  /** inflation 0 (packed) → 1 (deployed) */
  deploy(k: number): void;
  /** shower bar positions (tent frame) for the wash mist */
  showers: THREE.Vector3[];
  dispose(): void;
}

export function buildDeconTent(): DeconTent {
  const fabric = standard('tent_fabric', '#e8ebee', 0.85, 0, { side: THREE.DoubleSide });
  const beam = standard('tent_beam', '#d64f26', 0.6, 0.02);
  const floor = standard('tent_floor', '#2e6cb0', 0.55, 0.05);
  const pipe = standard('tent_pipe', '#b5bcc4', 0.3, 0.85);
  const bladder = standard('tent_bladder', '#58613f', 0.8, 0);
  const pump = standard('tent_pump', '#e0a526', 0.5, 0.2);
  const cone = standard('cone_orange', '#ff6a1a', 0.6, 0);
  const pane = standard('tent_window', '#cfe3ec', 0.08, 0.1, { transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide });
  const lamp = standard('tent_light', '#f4f8ff', 0.6, 0, { emissive: new THREE.Color('#eaf4ff'), emissiveIntensity: 1.8 });
  const signTex = signTexture();
  const sign = new THREE.MeshStandardMaterial({ name: 'tent_sign', map: signTex, roughness: 0.8, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });

  const group = new THREE.Group();
  group.name = 'DECON-1';

  // floor tray with raised lips (contains runoff), always laid out first
  const base = new PartSet();
  base.add(floor, place(new RoundedBoxGeometry(L + 0.4, 0.08, W + 0.3, 2, 0.03), 0, 0.04, 0));
  for (const z of [-(W + 0.3) / 2, (W + 0.3) / 2]) base.add(floor, place(new THREE.BoxGeometry(L + 0.4, 0.2, 0.06), 0, 0.1, z));
  base.add(pipe, place(new THREE.BoxGeometry(1.2, 0.02, 0.6), 0, 0.09, 0));
  const baseGroup = base.build('decon-floor', { cast: false, receive: true });
  group.add(baseGroup);

  // shelter: vault skin, air beams, rolled door flaps, signs, shower bars (scaled up as it inflates)
  const shell = new THREE.Group();
  const skin = new PartSet();
  skin.add(fabric, vault(-L / 2, L / 2, 0, Math.PI, NX, NT, 0, inWindow));
  for (const x of [-L / 2 + 0.14, L / 2 - 0.14]) {
    // door flaps rolled up under each end arch
    const pts: THREE.Vector3[] = [];
    for (let j = 0; j <= 20; j++) {
      const th = Math.PI * (0.18 + (0.64 * j) / 20);
      pts.push(new THREE.Vector3(x, H * Math.sin(th) * 0.94, (W / 2) * Math.cos(th) * 0.94));
    }
    skin.add(fabric, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 32, 0.15, 8, false));
  }
  shell.add(skin.build('decon-skin', { cast: true, receive: true }));
  const panes = new PartSet();
  for (const [a, b] of WIN_X) for (const [c, d] of WIN_TH) panes.add(pane, vault(a, b, c, d, 8, 3, -0.004));
  const paneGroup = panes.build('decon-windows', { cast: false, receive: false });
  paneGroup.traverse((o) => (o.renderOrder = 3));
  shell.add(paneGroup);
  const beams = new PartSet();
  for (const x of ARCHES) {
    const pts: THREE.Vector3[] = [];
    for (let j = 0; j <= 24; j++) {
      const th = (Math.PI * j) / 24;
      pts.push(new THREE.Vector3(x, H * Math.sin(th) * 1.012, (W / 2) * Math.cos(th) * 1.012));
    }
    beams.add(beam, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.17, 10, false));
  }
  // ridge beam
  beams.add(beam, place(new THREE.CylinderGeometry(0.12, 0.12, L, 10), 0, H * 1.012, 0, 0, 0, Math.PI / 2));
  shell.add(beams.build('decon-beams', { cast: true }));
  const signs = new PartSet();
  signs.add(sign, vault(-2.4, 2.4, Math.PI * 0.2, Math.PI * 0.34, 12, 6, 0.012));
  const back = vault(-2.4, 2.4, Math.PI * 0.66, Math.PI * 0.8, 12, 6, 0.012);
  // mirror the far sign's UVs so the lettering reads the right way round from outside
  const uvs = back.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uvs.count; i++) uvs.setXY(i, 1 - uvs.getX(i), 1 - uvs.getY(i));
  signs.add(sign, back);
  shell.add(signs.build('decon-signs', { cast: false }));
  const showers: THREE.Vector3[] = [];
  const bars = new PartSet();
  for (const z of [-0.85, 0.85]) {
    bars.add(pipe, place(new THREE.CylinderGeometry(0.035, 0.035, L - 1.4, 8), 0, 2.45, z, 0, 0, Math.PI / 2));
    for (let i = 0; i < 6; i++) {
      const x = -3.5 + i * 1.4;
      bars.add(pipe, place(new THREE.CylinderGeometry(0.03, 0.02, 0.08, 6), x, 2.39, z));
      showers.push(new THREE.Vector3(x, 2.34, z));
    }
  }
  for (const x of [-3.2, 3.2]) bars.add(pipe, place(new THREE.CylinderGeometry(0.02, 0.02, 2.4, 6), x, 1.25, -W / 2 + 0.5));
  bars.add(lamp, place(new THREE.BoxGeometry(L - 1.6, 0.04, 0.14), 0, H * 0.985 - 0.18, 0));
  shell.add(bars.build('decon-showers', { cast: false }));
  group.add(shell);

  // support kit outside the south wall: water bladder, pump with hoses, cones at the doors
  const kit = new PartSet();
  kit.add(bladder, place(new THREE.CapsuleGeometry(0.42, 2.4, 6, 16).rotateZ(Math.PI / 2), 0.5, 0.3, W / 2 + 2.3, 0, 0, 0, 1, 0.62, 1.9));
  kit.add(pump, place(new RoundedBoxGeometry(0.9, 0.62, 0.6, 2, 0.04), 3.6, 0.31, W / 2 + 1.6));
  kit.add(pipe, place(new THREE.CylinderGeometry(0.05, 0.05, 0.35, 8), 3.85, 0.75, W / 2 + 1.5));
  const hose = new THREE.CatmullRomCurve3([new THREE.Vector3(3.2, 0.2, W / 2 + 1.5), new THREE.Vector3(2.4, 0.05, W / 2 + 0.9), new THREE.Vector3(1.6, 0.12, W / 2 + 0.25)]);
  kit.add(bladder, new THREE.TubeGeometry(hose, 12, 0.05, 6, false));
  for (const x of [-L / 2 - 1.2, L / 2 + 1.2])
    for (const z of [-W / 2 + 0.2, W / 2 - 0.2]) {
      kit.add(cone, place(new THREE.ConeGeometry(0.16, 0.6, 14), x, 0.33, z));
      kit.add(cone, place(new THREE.BoxGeometry(0.36, 0.04, 0.36), x, 0.02, z));
    }
  const kitGroup = kit.build('decon-kit', { cast: true, receive: true });
  group.add(kitGroup);

  const ease = (x: number) => {
    const t = Math.min(1, Math.max(0, x));
    // inflate with a slight overshoot as the beams take pressure
    return t < 1 ? 1 - Math.pow(1 - t, 3) * Math.cos(t * 4.2) * (1 - t * 0.2) : 1;
  };
  return {
    group,
    showers,
    deploy(k: number) {
      group.visible = k > 0.002;
      baseGroup.scale.set(Math.min(1, k * 6), 1, Math.min(1, k * 6));
      kitGroup.visible = k > 0.08;
      const s = ease((k - 0.1) / 0.9);
      shell.visible = s > 0.01;
      shell.scale.set(1, Math.max(0.02, s), Math.max(0.3, Math.min(1, 0.3 + s)));
    },
    dispose() {
      disposeTree(group);
      signTex.dispose();
    },
  };
}
