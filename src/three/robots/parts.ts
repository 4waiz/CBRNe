import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Small helpers for building procedural robot models: place a primitive geometry with a transform,
// collect the pieces by material, then merge each material's pieces into one mesh (one draw call).

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const s = new THREE.Vector3();
const p = new THREE.Vector3();

/** Moves a freshly made geometry to (x, y, z), rotated (XYZ Euler, radians) and optionally scaled. */
export function place(geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  e.set(rx, ry, rz);
  q.setFromEuler(e);
  p.set(x, y, z);
  s.set(sx, sy, sz);
  m4.compose(p, q, s);
  return geo.applyMatrix4(m4);
}

/** Pieces grouped by material, merged into one mesh per material under a group. */
export class PartSet {
  private pieces = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(material: THREE.Material, geo: THREE.BufferGeometry) {
    const list = this.pieces.get(material) ?? [];
    // merging needs a uniform attribute layout: position + normal + uv, indexed
    if (!geo.getAttribute('uv')) {
      const n = geo.getAttribute('position').count;
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
    }
    list.push(geo.index ? geo : indexed(geo));
    this.pieces.set(material, list);
    return this;
  }

  build(name: string, { cast = true, receive = false } = {}) {
    const group = new THREE.Group();
    group.name = name;
    for (const [material, geos] of this.pieces) {
      const merged = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `${name}:${material.name}`;
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      group.add(mesh);
    }
    this.pieces.clear();
    return group;
  }
}

function indexed(geo: THREE.BufferGeometry) {
  const n = geo.getAttribute('position').count;
  const idx = new Array<number>(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  geo.setIndex(idx);
  return geo;
}

export function standard(name: string, color: string, roughness: number, metalness: number, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ name, color, roughness, metalness, ...extra });
}

/** Disposes every geometry and material below a root. */
export function disposeTree(root: THREE.Object3D) {
  const mats = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => mats.add(m));
  });
  mats.forEach((m) => m.dispose());
}
