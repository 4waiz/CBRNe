import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { PartSet, place, standard } from '../robots/parts';

// Portable generator skid G2 in the service yard (fictional equipment): acoustic enclosure on a fuel-tank
// base, exhaust stack, radiator grille, control door and a distribution box. Its metal blackens with soot
// as the fire burns and catches the flames' orange light (uniforms shared by the skid materials).

export const skidFx = {
  uScorch: { value: 0 },
  uFireGlow: { value: 0 },
  uFirePos: { value: new THREE.Vector3() },
};

const SCORCH_PARS = /* glsl */ `
  uniform float uScorch;
  uniform float uFireGlow;
  uniform vec3 uFirePos;
  varying vec3 vScorchWorld;
  float sc_hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
  float sc_noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(sc_hash(i), sc_hash(i + vec2(1.0, 0.0)), u.x), mix(sc_hash(i + vec2(0.0, 1.0)), sc_hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
`;

/** Soot: blotchy, heavier low down and in vertical streaks above the vents. */
const SCORCH_MAIN = /* glsl */ `
  {
    float n = sc_noise(vScorchWorld.xz * 1.7 + vScorchWorld.y * 0.9) * 0.6 + sc_noise(vec2(vScorchWorld.x + vScorchWorld.z, vScorchWorld.y * 0.25) * 3.1) * 0.4;
    float soot = clamp(uScorch * (0.55 + 0.75 * n) - 0.12 * max(vScorchWorld.y - 1.2, 0.0) * (1.0 - uScorch), 0.0, 0.94);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035, 0.032, 0.03), soot);
  }
`;

/** Firelight: surfaces close to the flames pick up a flickering orange glow. */
const GLOW_MAIN = /* glsl */ `
  {
    vec3 fd = vScorchWorld - uFirePos;
    fd.y *= 0.6;
    totalEmissiveRadiance += vec3(1.0, 0.42, 0.12) * uFireGlow * 0.45 * exp(-dot(fd, fd) / 4.0);
  }
`;

function scorchable(m: THREE.MeshStandardMaterial) {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, skidFx);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vScorchWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvScorchWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SCORCH_PARS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${SCORCH_MAIN}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${GLOW_MAIN}`);
  };
  m.customProgramCacheKey = () => 'encirra-scorch-v2';
  return m;
}

export function buildGeneratorSkid() {
  const body = scorchable(standard('gen_body', '#6d8571', 0.62, 0.35));
  const dark = scorchable(standard('gen_dark', '#2b2f34', 0.55, 0.4));
  const exhaust = standard('gen_exhaust', '#4a4744', 0.5, 0.75);
  const fuel = scorchable(standard('gen_fuel', '#3e4248', 0.6, 0.45));
  const p = new PartSet();
  // fuel-tank base and skid rails (long axis along z)
  p.add(fuel, place(new RoundedBoxGeometry(2.15, 0.55, 4.5, 2, 0.05), 0, 0.275, 0));
  for (const x of [-0.95, 0.95]) p.add(dark, place(new THREE.BoxGeometry(0.12, 0.14, 4.7), x, 0.07, 0));
  // acoustic enclosure with a lid, louvres on both long sides, radiator grille and control door
  p.add(body, place(new RoundedBoxGeometry(2.0, 1.85, 4.2, 3, 0.06), 0, 1.47, 0));
  p.add(body, place(new RoundedBoxGeometry(2.1, 0.09, 4.32, 2, 0.03), 0, 2.43, 0));
  for (const x of [-1.005, 1.005])
    for (let i = 0; i < 7; i++) p.add(dark, place(new THREE.BoxGeometry(0.03, 0.05, 0.9), x, 0.95 + i * 0.16, -1.35));
  p.add(dark, place(new THREE.BoxGeometry(1.7, 1.4, 0.04), 0, 1.45, 2.11));
  p.add(dark, place(new THREE.BoxGeometry(0.03, 1.05, 0.85), 1.01, 1.35, 0.75));
  p.add(exhaust, place(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 8), 1.04, 1.4, 0.45, 0, 0, Math.PI / 2));
  // exhaust stack with a rain cap, lifting eyes, fuel cap
  p.add(exhaust, place(new THREE.CylinderGeometry(0.095, 0.095, 0.95, 14), 0.55, 2.9, -1.45));
  p.add(exhaust, place(new THREE.CylinderGeometry(0.15, 0.12, 0.05, 14), 0.55, 3.4, -1.45, 0.3));
  for (const x of [-0.85, 0.85]) for (const z of [-1.9, 1.9]) p.add(dark, place(new THREE.TorusGeometry(0.06, 0.015, 6, 12), x, 2.51, z));
  p.add(dark, place(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 10), -0.75, 0.6, 2.0));
  // distribution box beside the skid, with its cable
  p.add(body, place(new RoundedBoxGeometry(0.5, 1.2, 0.8, 2, 0.03), -1.75, 0.6, 1.3));
  const cable = new THREE.CatmullRomCurve3([new THREE.Vector3(-1.5, 0.5, 1.3), new THREE.Vector3(-1.2, 0.05, 1.5), new THREE.Vector3(-1.0, 0.3, 1.7)]);
  p.add(dark, new THREE.TubeGeometry(cable, 10, 0.035, 6, false));
  const group = p.build('generator-skid', { cast: true, receive: true });
  return group;
}
