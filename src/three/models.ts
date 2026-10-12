import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { weatherMaterial } from './weathering';

export const MODELS = {
  unit: 'reactor-unit',
  service: 'service-buildings',
  cooling: 'cooling-infrastructure',
  electrical: 'electrical-infrastructure',
  props: 'site-props',
  sensor: 'sensor-node',
  vehicle: 'response-vehicle',
  person: 'person',
} as const;

export const modelUrl = (name: string) => `${import.meta.env.BASE_URL}models/${name}.glb`;

/** The GLBs are Draco-compressed by the Blender build; the decoder is served from public/draco/. */
export const DRACO_DECODER = `${import.meta.env.BASE_URL}draco/`;

export function useModel(name: string) {
  return useGLTF(modelUrl(name), DRACO_DECODER, false);
}

export function preloadModels() {
  for (const name of Object.values(MODELS)) useGLTF.preload(modelUrl(name), DRACO_DECODER, false);
}

const ENV_BY_MATERIAL: Record<string, number> = {
  glass: 1.5,
  glass_blue: 1.6,
  crane_yellow: 0.85,
  roof_white: 0.8,
  dome_white: 1.05,
  roof_metal: 1.0,
  steel: 1.1,
  steel_dark: 0.9,
  car_white: 1.25,
  car_silver: 1.25,
  car_dark: 1.25,
  car_blue: 1.25,
  lens: 1.4,
  solar: 1.4,
  tank_white: 0.9,
};

/** Shadow flags + material tuning for meshes coming out of the Blender GLBs. */
export function prepareModel(root: THREE.Object3D, { cast = true, receive = true } = {}) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats as THREE.MeshStandardMaterial[]) {
      if (!m || !m.isMeshStandardMaterial) continue;
      m.envMapIntensity = ENV_BY_MATERIAL[m.name] ?? 0.72;
      weatherMaterial(m);
      if (m.name === 'rotor') {
        m.transparent = true;
        m.opacity = 0.45;
        m.depthWrite = false;
      }
      if (m.name === 'palm_leaf') m.side = THREE.DoubleSide;
    }
  });
}
