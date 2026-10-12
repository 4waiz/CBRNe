import * as THREE from 'three';
import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { engine } from '../simulation/engine';
import { envelope, type Effect } from '../simulation/effects';
import { FIRE_SITE } from '../simulation/locations';
import { useSim } from '../store/sim';
import { sceneClock } from './sceneClock';
import { assetVisual } from './AssetLayer';
import { registerThermal, registerThermalTree } from './thermal';
import { prepareModel } from './models';
import { buildGeneratorSkid, skidFx } from './props/generatorSkid';
import { buildDeconTent } from './props/deconTent';
import { disposeTree } from './robots/parts';
import { GRAVITY, SPRAY_SPEED } from './robots/spray';
import { windVector } from '../utils/math';

// Fire-response scene: generator skid G2, its fire (flames, smoke that turns to steam under the water,
// embers, scorch and firelight), the robot's water-mist jet and the DECON-1 shelter with its wash.
// Everything sits on the WORLD layer so every camera feed sees it. The fire particles are pure
// functions of scene time (emission time → envelope), so replay shows the same fire, and smoke
// already in the air keeps drifting downwind after the flames are knocked down. In thermal the flames
// read hot, water cool, and smoke is transparent to the long-wave camera, as it is in reality.

/** Thermal stand-in for effects a long-wave camera does not see (smoke, mist, decals). */
const HIDDEN = new THREE.MeshBasicMaterial({ name: 'thermal-hidden', visible: false });

/** Premultiplied alpha: rgb is emitted light, alpha is how much of the background it covers. */
const PREMULT = {
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
} as const;

/** Flame emitters in the skid's frame: roof over the engine bay, both louvre banks, fuel spill. */
const EMITTERS: [number, number, number, number][] = [
  [0, 2.5, -1.15, 0.85],
  [1.08, 1.35, -1.35, 0.42],
  [-1.08, 1.35, -1.35, 0.42],
  [0, 0.12, -2.75, 0.95],
];

function emitterWorld(e: Effect, i: number, out = new THREE.Vector3()) {
  const [x, y, z] = EMITTERS[i];
  const h = FIRE_SITE.skid.heading;
  return out.set(e.x + x * Math.cos(h) + z * Math.sin(h), y, e.z - x * Math.sin(h) + z * Math.cos(h));
}

/** Small deterministic generator for particle seeds (same fire on every load). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function instancedQuads(n: number, seed: number) {
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.getAttribute('position'));
  const r = rng(seed);
  const s = new Float32Array(n * 4);
  for (let i = 0; i < s.length; i++) s[i] = r();
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(s, 4));
  g.instanceCount = n;
  return g;
}

const flicker = (t: number) => 0.82 + 0.1 * Math.sin((t / 1000) * 13.7) + 0.08 * Math.sin((t / 1000) * 31.3 + 1.3);

/** Seconds of water the robot has put on the fire by scene time t, and seconds since it stopped. */
function sprayHistory(t: number) {
  const segs = engine.ugv.segments;
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (s.t0 > t || s.type !== 'suppress') continue;
    const lt = (t - s.t0) / 1000;
    return { sprayed: Math.max(0, Math.min(lt, s.duration - 0.6) - 0.8), since: lt - (s.duration - 0.6) };
  }
  return null;
}

// ------------------------------------------------------------------------------------------ shaders

const GLSL_COMMON = /* glsl */ `
  float fx_hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  vec2 fx_hash2(vec2 p) { return vec2(fx_hash(p), fx_hash(p + vec2(17.31, 5.17))); }
  float fx_noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(fx_hash(i), fx_hash(i + vec2(1.0, 0.0)), u.x), mix(fx_hash(i + vec2(0.0, 1.0)), fx_hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // the fire envelope (envelope() in effects.ts), t in seconds since ignition
  float fx_env(float t, float ramp, float endT, float rampDown) {
    if (t < 0.0) return 0.0;
    float k = smoothstep(0.0, 1.0, t / ramp);
    if (t > endT) k *= 1.0 - smoothstep(0.0, 1.0, (t - endT) / rampDown);
    return k;
  }
`;

const FIRE_UNIFORMS = /* glsl */ `
  uniform float uTime;
  uniform float uRamp;
  uniform float uEnd;
  uniform float uRampDown;
  uniform vec4 uEmit[4];
  uniform vec3 uSrc;
  uniform vec2 uWind;
  uniform float uWindSpeed;
  uniform float uScale;
  uniform float uGlow;
`;

/** Flame tongues: upright billboards rising from the emitters, leaning downwind. */
const FLAME_VERT = /* glsl */ `
  attribute vec4 aSeed;
  ${FIRE_UNIFORMS}
  varying vec2 vUv;
  varying float vAge;
  varying float vLevel;
  varying float vSeed;
  ${GLSL_COMMON}
  void main() {
    float life = 0.7 + 0.6 * aSeed.w;
    float cyc = uTime / life + aSeed.x;
    float age = fract(cyc);
    float a = age * life;
    float level = fx_env(uTime - a, uRamp, uEnd, uRampDown);
    vec2 rnd = fx_hash2(vec2(floor(cyc), aSeed.y * 113.0 + aSeed.z * 7.0));
    vec4 em = aSeed.y < 0.42 ? uEmit[0] : (aSeed.y < 0.58 ? uEmit[1] : (aSeed.y < 0.74 ? uEmit[2] : uEmit[3]));
    float ang = rnd.x * 6.2832;
    float rad = sqrt(rnd.y) * em.w * (0.55 + 0.45 * level);
    vec3 p = em.xyz + vec3(cos(ang) * rad, 0.0, sin(ang) * rad);
    p.y += (0.8 + 1.6 * level * uScale) * a + 2.0 * level * a * a;
    p.xz += uWind * uWindSpeed * (0.15 * a + 0.32 * a * a);
    p.x += sin(uTime * 6.1 + aSeed.x * 40.0) * 0.1 * a;
    p.z += cos(uTime * 5.3 + aSeed.z * 31.0) * 0.1 * a;
    float size = (0.7 + 1.2 * level * uScale) * (0.7 + 0.5 * aSeed.z) * (1.0 - 0.45 * age);
    vec3 toCam = cameraPosition - p;
    vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-4, 0.0, 0.0));
    vec3 wp = p + right * position.x * size + vec3(0.0, (position.y + 0.42) * size * 1.7, 0.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    vUv = position.xy + 0.5;
    vAge = age;
    vLevel = level;
    vSeed = aSeed.z;
  }
`;

const FLAME_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vAge;
  varying float vLevel;
  varying float vSeed;
  ${GLSL_COMMON}
  void main() {
    vec2 q = vUv * 2.0 - 1.0;
    float up = vUv.y;
    float n = fx_noise(vec2(q.x * 2.2 + vSeed * 19.0, q.y * 1.6 - uTime * 3.4 + vSeed * 7.0));
    float n2 = fx_noise(vec2(q.x * 4.6 - vSeed * 11.0, q.y * 3.3 - uTime * 5.2));
    q.x += (n - 0.5) * 0.75 * up;
    float halfW = mix(0.85, 0.1, pow(up, 0.8));
    float body = 1.0 - smoothstep(halfW * 0.3, halfW, abs(q.x));
    body *= smoothstep(0.0, 0.16, up) * (1.0 - smoothstep(0.42, 1.0, up + (n2 - 0.5) * 0.4));
    float a = body * vLevel * smoothstep(0.0, 0.12, vAge) * (1.0 - smoothstep(0.5, 1.0, vAge));
    if (a < 0.004) discard;
  #ifdef THERMAL
    gl_FragColor = vec4(vec3(1.9 * a), a);
  #else
    float k = clamp((1.05 - vAge) * (1.2 - up) * (0.7 + 0.6 * n2) * (0.55 + 0.6 * vLevel), 0.0, 1.0);
    vec3 c = mix(vec3(0.45, 0.03, 0.0), vec3(1.0, 0.3, 0.03), smoothstep(0.0, 0.35, k));
    c = mix(c, vec3(1.0, 0.66, 0.16), smoothstep(0.3, 0.7, k));
    c = mix(c, vec3(1.0, 0.93, 0.72), smoothstep(0.72, 1.0, k));
    gl_FragColor = vec4(c * (1.2 + 2.4 * k) * a, a * 0.22);
  #endif
  }
`;

/** Smoke column: dark while the fire burns, white steam once water hits it, bent over by the wind. */
const SMOKE_VERT = /* glsl */ `
  attribute vec4 aSeed;
  ${FIRE_UNIFORMS}
  varying vec2 vUv;
  varying float vAlpha;
  varying float vSteam;
  varying float vShade;
  varying float vLow;
  varying float vSeed;
  ${GLSL_COMMON}
  void main() {
    float life = 9.0 + 5.0 * aSeed.w;
    float cyc = uTime / life + aSeed.x;
    float age = fract(cyc);
    float a = age * life;
    float born = uTime - a;
    float flame = fx_env(born, uRamp, uEnd, uRampDown);
    float after = born - uEnd;
    float steam = after > 0.0 ? smoothstep(0.0, 2.5, after) : 0.0;
    float smoulder = after > 0.0 ? 0.7 * exp(-after / 35.0) * smoothstep(0.0, 1.5, after) : 0.0;
    float level = max(flame, smoulder);
    vec2 rnd = fx_hash2(vec2(floor(cyc), aSeed.y * 71.0));
    vec3 p = uSrc + vec3((rnd.x - 0.5) * 2.2, 0.0, (rnd.y - 0.5) * 2.2);
    float buoy = mix(1.0, 1.35, steam) * (0.6 + 0.5 * flame + 0.3 * steam);
    p.y += (7.5 * (1.0 - exp(-a / 3.2)) + 0.45 * a) * buoy;
    float bend = smoothstep(0.0, 4.0, a);
    p.xz += uWind * uWindSpeed * a * (0.3 + 0.7 * bend);
    p.x += sin(a * 0.9 + aSeed.z * 29.0) * (0.25 + 0.12 * a);
    p.z += cos(a * 0.8 + aSeed.y * 23.0) * (0.25 + 0.12 * a);
    float size = (1.7 + 0.7 * a) * (0.7 + 0.6 * aSeed.w) * mix(1.0, 1.2, steam) * (0.7 + 0.3 * uScale);
    vec4 mv = viewMatrix * vec4(p, 1.0);
    float rot = aSeed.y * 6.2832 + a * 0.12 * (aSeed.z - 0.5);
    float cr = cos(rot);
    float sr = sin(rot);
    vec2 c = vec2(position.x * cr - position.y * sr, position.x * sr + position.y * cr);
    mv.xy += c * size;
    gl_Position = projectionMatrix * mv;
    vUv = position.xy + 0.5;
    vShade = c.y + 0.5;
    vAlpha = level * smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.5, 1.0, age)) * (1.0 - 0.45 * steam * age);
    vSteam = steam;
    vLow = 1.0 - smoothstep(0.3, 2.2, a);
    vSeed = aSeed.z;
  }
`;

const SMOKE_FRAG = /* glsl */ `
  uniform float uGlow;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vSteam;
  varying float vShade;
  varying float vLow;
  varying float vSeed;
  ${GLSL_COMMON}
  void main() {
    vec2 q = vUv - 0.5;
    float n = fx_noise(vUv * 3.2 + vSeed * 13.0) * 0.65 + fx_noise(vUv * 7.0 - vSeed * 5.0) * 0.35;
    float d = length(q) + (n - 0.5) * 0.22;
    float puff = 1.0 - smoothstep(0.12, 0.48, d);
    float a = puff * vAlpha * mix(0.86, 0.5, vSteam);
    if (a < 0.003) discard;
    vec3 smoke = vec3(0.05, 0.048, 0.046) * (0.55 + 0.8 * vShade);
    vec3 steamC = vec3(0.84, 0.86, 0.88) * (0.78 + 0.3 * vShade);
    vec3 col = mix(smoke, steamC, vSteam);
    col += vec3(1.0, 0.36, 0.08) * uGlow * vLow * (1.0 - vSteam) * 0.4 * (1.0 - vShade * 0.5);
    gl_FragColor = vec4(col * a, a);
  }
`;

/** Embers lofted out of the flames. */
const EMBER_VERT = /* glsl */ `
  attribute vec4 aSeed;
  ${FIRE_UNIFORMS}
  varying vec2 vUv;
  varying float vAlpha;
  ${GLSL_COMMON}
  void main() {
    float life = 1.6 + 1.6 * aSeed.w;
    float cyc = uTime / life + aSeed.x;
    float age = fract(cyc);
    float a = age * life;
    float level = fx_env(uTime - a, uRamp, uEnd, uRampDown);
    vec2 rnd = fx_hash2(vec2(floor(cyc), aSeed.y * 37.0));
    vec3 p = uEmit[0].xyz + vec3((rnd.x - 0.5) * 1.6, 0.4, (rnd.y - 0.5) * 1.6);
    p.y += (3.0 + 2.5 * aSeed.z) * a - 0.45 * a * a;
    p.xz += uWind * uWindSpeed * a * 0.9;
    p.x += sin(a * 7.0 + aSeed.x * 50.0) * 0.35 * a;
    p.z += cos(a * 6.0 + aSeed.y * 40.0) * 0.35 * a;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    mv.xy += position.xy * max(0.05, -mv.z * 0.0018);
    gl_Position = projectionMatrix * mv;
    vUv = position.xy + 0.5;
    vAlpha = level * (0.6 + 0.4 * sin(uTime * 23.0 + aSeed.x * 90.0)) * (1.0 - age) * smoothstep(0.0, 0.05, age);
  }
`;

const EMBER_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    float a = (1.0 - smoothstep(0.1, 0.5, length(vUv - 0.5))) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vec3(1.0, 0.55, 0.15) * 3.0 * a, 0.0);
  }
`;

/** Ground under the fire: soot, run-off water with foam, and the flames' glow. */
const DECAL_VERT = /* glsl */ `
  varying vec2 vXZ;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vXZ = wp.xz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const DECAL_FRAG = /* glsl */ `
  uniform vec2 uCenter;
  uniform vec2 uGlowAt;
  uniform float uBurn;
  uniform float uWet;
  uniform float uGlow;
  varying vec2 vXZ;
  ${GLSL_COMMON}
  void main() {
    float r = length(vXZ - uCenter);
    float n = fx_noise(vXZ * 0.7) * 0.5 + fx_noise(vXZ * 2.3) * 0.3 + fx_noise(vXZ * 6.1) * 0.2;
    float scorch = uBurn * (1.0 - smoothstep(1.6, 5.8, r + (n - 0.5) * 3.2));
    float wet = uWet * (1.0 - smoothstep(3.5, 8.0, r + (fx_noise(vXZ * 0.45 + 4.0) - 0.5) * 4.0));
    float a = clamp(scorch * (0.7 + 0.3 * n) + wet * 0.32, 0.0, 0.94);
    vec3 col = mix(vec3(0.035, 0.032, 0.03), vec3(0.11, 0.115, 0.12), wet * (1.0 - scorch) * 0.6);
    float foam = wet * smoothstep(0.72, 0.86, fx_noise(vXZ * 7.0)) * (1.0 - smoothstep(1.5, 4.0, r));
    col = mix(col, vec3(0.78, 0.8, 0.82), foam * 0.6);
    a = max(a, foam * 0.35);
    float g = length(vXZ - uGlowAt);
    float gk = uGlow * exp(-g * g / 10.0);
    vec3 glow = vec3(1.0, 0.38, 0.1) * gk * 0.5;
    if (a < 0.01 && gk < 0.01) discard;
    gl_FragColor = vec4(col * a + glow, a);
  }
`;

/** Water: jet droplets stretched along their velocity, mist parcels as soft puffs. */
const SPRAY_VERT = /* glsl */ `
  attribute vec3 aPos;
  attribute vec3 aVel;
  attribute vec3 aInfo;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vKind;
  void main() {
    float f = aInfo.x;
    vUv = position.xy + 0.5;
    vKind = aInfo.y;
    if (f >= 1.0) {
      vAlpha = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec4 mv = viewMatrix * vec4(aPos, 1.0);
    if (aInfo.y < 0.5 || aInfo.y > 1.5) {
      vec3 vv = (viewMatrix * vec4(aVel, 0.0)).xyz;
      vec2 dir = vv.xy;
      float L = length(dir);
      dir = L > 1e-4 ? dir / L : vec2(0.0, 1.0);
      vec2 perp = vec2(-dir.y, dir.x);
      float w = aInfo.y > 1.5 ? 0.04 : 0.07 + 0.07 * f;
      mv.xy += dir * position.y * max(w * 2.0, L * 0.055) + perp * position.x * w;
      vAlpha = (aInfo.y > 1.5 ? 0.5 : 0.8) * (1.0 - smoothstep(0.75, 1.0, f));
    } else {
      mv.xy += position.xy * (0.12 + 0.6 * f);
      vAlpha = 0.09 * smoothstep(0.0, 0.1, f) * (1.0 - smoothstep(0.5, 1.0, f));
    }
    gl_Position = projectionMatrix * mv;
  }
`;

const WATER_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying float vAlpha;
  varying float vKind;
  void main() {
    vec2 q = vUv - 0.5;
    float a = vKind > 0.5 && vKind < 1.5
      ? 1.0 - smoothstep(0.1, 0.5, length(q))
      : (1.0 - smoothstep(0.2, 0.5, abs(q.x))) * (1.0 - smoothstep(0.3, 0.5, abs(q.y)));
    a *= vAlpha;
    if (a < 0.004) discard;
  #ifdef THERMAL
    gl_FragColor = vec4(vec3(0.3 * a), a);
  #else
    gl_FragColor = vec4(vec3(0.86, 0.91, 0.96) * a, a);
  #endif
  }
`;

/** DECON-1 shower: droplets from the two overhead bars (tent frame), falling onto the robot. */
const WASH_VERT = /* glsl */ `
  attribute vec4 aSeed;
  uniform float uTime;
  uniform float uWash;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vKind;
  ${GLSL_COMMON}
  void main() {
    float life = 0.5 + 0.2 * aSeed.w;
    float cyc = uTime / life + aSeed.x;
    float age = fract(cyc);
    float a = age * life;
    vec2 rnd = fx_hash2(vec2(floor(cyc), aSeed.y * 53.0));
    float idx = floor(aSeed.y * 12.0);
    float side = idx < 6.0 ? -0.85 : 0.85;
    vec3 p0 = vec3(-3.5 + mod(idx, 6.0) * 1.4, 2.32, side);
    vec3 v0 = vec3((rnd.x - 0.5) * 1.8, -1.0 - 1.2 * aSeed.z, (rnd.y - 0.5) * 1.8 - side * 0.9);
    vec3 p = p0 + v0 * a;
    p.y -= 4.905 * a * a;
    vec3 vel = v0;
    vel.y -= 9.81 * a;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec3 vv = mat3(modelViewMatrix) * vel;
    vec2 dir = vv.xy;
    float L = length(dir);
    dir = L > 1e-4 ? dir / L : vec2(0.0, 1.0);
    vec2 perp = vec2(-dir.y, dir.x);
    mv.xy += dir * position.y * max(0.1, L * 0.05) + perp * position.x * 0.05;
    gl_Position = projectionMatrix * mv;
    vUv = position.xy + 0.5;
    vAlpha = uWash * step(0.1, p.y) * 0.85 * smoothstep(0.0, 0.1, age);
    vKind = 0.0;
  }
`;

/** Mist hanging in the shelter while the shower runs. */
const MIST_VERT = /* glsl */ `
  attribute vec4 aSeed;
  uniform float uTime;
  uniform float uWash;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vKind;
  ${GLSL_COMMON}
  void main() {
    float life = 3.0 + 2.0 * aSeed.w;
    float cyc = uTime / life + aSeed.x;
    float age = fract(cyc);
    vec2 rnd = fx_hash2(vec2(floor(cyc), aSeed.y * 31.0));
    vec3 p = vec3((rnd.x - 0.5) * 9.0, 0.4 + aSeed.z * 1.8 + age * 0.5, (rnd.y - 0.5) * 3.6);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    mv.xy += position.xy * (1.2 + 1.2 * aSeed.w);
    gl_Position = projectionMatrix * mv;
    vUv = position.xy + 0.5;
    vAlpha = uWash * 0.24 * sin(age * 3.14159);
    vKind = 1.0;
  }
`;

// ------------------------------------------------------------------------------------------ fire

function FireFx({ effect }: { effect: Effect }) {
  const fx = useMemo(() => {
    const emit = EMITTERS.map((em, i) => {
      const p = emitterWorld(effect, i);
      return new THREE.Vector4(p.x, p.y, p.z, em[3]);
    });
    const uniforms = {
      uTime: { value: 0 },
      uRamp: { value: Math.max(0.1, effect.ramp) },
      uEnd: { value: 1e7 },
      uRampDown: { value: Math.max(0.1, effect.rampDown) },
      uEmit: { value: emit },
      uSrc: { value: new THREE.Vector3(emit[0].x, emit[0].y + 0.9, emit[0].z) },
      uWind: { value: new THREE.Vector2(0.6, 0.8) },
      uWindSpeed: { value: 3 },
      uScale: { value: THREE.MathUtils.clamp(effect.amplitude / 560, 0.6, 1.4) },
      uGlow: { value: 0 },
    };
    const flameMat = new THREE.ShaderMaterial({ name: 'fire-flames', uniforms, vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG, ...PREMULT });
    const flameHeat = new THREE.ShaderMaterial({ name: 'fire-flames-heat', uniforms, vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG, defines: { THERMAL: '' }, ...PREMULT });
    const flames = new THREE.Mesh(instancedQuads(72, 11), flameMat);
    const smoke = new THREE.Mesh(instancedQuads(150, 23), new THREE.ShaderMaterial({ name: 'fire-smoke', uniforms, vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG, ...PREMULT }));
    const embers = new THREE.Mesh(instancedQuads(40, 37), new THREE.ShaderMaterial({ name: 'fire-embers', uniforms, vertexShader: EMBER_VERT, fragmentShader: EMBER_FRAG, ...PREMULT }));
    const decalUniforms = {
      uCenter: { value: new THREE.Vector2(emit[3].x, emit[3].z).lerp(new THREE.Vector2(effect.x, effect.z), 0.5) },
      uGlowAt: { value: new THREE.Vector2(emit[3].x, emit[3].z) },
      uBurn: { value: 0 },
      uWet: { value: 0 },
      uGlow: { value: 0 },
    };
    const dg = new THREE.PlaneGeometry(22, 22).rotateX(-Math.PI / 2);
    const decal = new THREE.Mesh(
      dg,
      new THREE.ShaderMaterial({ name: 'fire-ground', uniforms: decalUniforms, vertexShader: DECAL_VERT, fragmentShader: DECAL_FRAG, ...PREMULT, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    decal.position.set(effect.x, 0.04, effect.z);
    decal.renderOrder = 1;
    smoke.renderOrder = 5;
    flames.renderOrder = 6;
    embers.renderOrder = 6;
    for (const m of [flames, smoke, embers]) m.frustumCulled = false;
    const group = new THREE.Group();
    group.name = `fire:${effect.id}`;
    group.add(decal, smoke, flames, embers);
    return { group, flames, flameHeat, smoke, embers, decal, uniforms, decalUniforms, wind: new THREE.Vector2() };
  }, [effect]);

  useEffect(() => {
    const offs = [registerThermal(fx.flames, fx.flameHeat), registerThermal(fx.smoke, HIDDEN), registerThermal(fx.embers, HIDDEN), registerThermal(fx.decal, HIDDEN)];
    return () => {
      offs.forEach((f) => f());
      for (const m of [fx.flames, fx.smoke, fx.embers, fx.decal]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      fx.flameHeat.dispose();
    };
  }, [fx]);

  useFrame((_, dt) => {
    const t = sceneClock.t;
    const u = fx.uniforms;
    const since = (t - effect.t0) / 1000;
    const end = effect.endAt === null ? 1e7 : (effect.endAt - effect.t0) / 1000;
    u.uTime.value = since;
    u.uEnd.value = end;
    u.uRampDown.value = Math.max(0.1, effect.rampDown);
    const w = windVector(engine.windDirAt(t));
    fx.wind.set(w.x, w.z);
    u.uWind.value.lerp(fx.wind, 1 - Math.exp(-dt * 1.6)).normalize();
    u.uWindSpeed.value = engine.windSpeedAt(t) / 3.6;
    const env = envelope(effect, t);
    u.uGlow.value = env * flicker(t);

    const started = since >= 0;
    const burning = started && since < end + effect.rampDown + 1.5;
    fx.flames.visible = fx.embers.visible = burning;
    fx.smoke.visible = started && since < end + effect.rampDown + 180;
    fx.decal.visible = started;
    const d = fx.decalUniforms;
    d.uBurn.value = THREE.MathUtils.clamp((Math.min(since, end) - 2) / 45, 0, 1);
    d.uGlow.value = u.uGlow.value;
    const water = sprayHistory(t);
    d.uWet.value = water ? Math.min(1, water.sprayed / 6) * Math.exp(-Math.max(0, water.since) / 900) : 0;
  });

  return <primitive object={fx.group} />;
}

// ------------------------------------------------------------------------------------------ water jet

const SPRAY_N = 560;
const tmpU = new THREE.Vector3();
const tmpW = new THREE.Vector3();

/** CPU particles for the robot's jet: launched from the nozzle each frame, ballistic, with splashes. */
class SprayJetSim {
  readonly pos = new Float32Array(SPRAY_N * 3);
  readonly vel = new Float32Array(SPRAY_N * 3);
  /** life fraction (≥ 1: dead), kind (0 jet, 1 mist, 2 splash), seed */
  readonly info = new Float32Array(SPRAY_N * 3);
  private age = new Float32Array(SPRAY_N);
  private life = new Float32Array(SPRAY_N);
  private next = 0;
  private carry = 0;
  private rnd = rng(97);
  live = 0;

  constructor() {
    this.clear();
  }

  clear() {
    for (let i = 0; i < SPRAY_N; i++) this.info[i * 3] = 1;
    this.live = 0;
  }

  private spawn(kind: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number) {
    const i = this.next;
    this.next = (this.next + 1) % SPRAY_N;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.info.set([0, kind, this.rnd()], i * 3);
    this.age[i] = 0;
    this.life[i] = life;
  }

  emit(dt: number, origin: THREE.Vector3, dir: THREE.Vector3) {
    this.carry += dt * 390;
    const n = Math.floor(this.carry);
    this.carry -= n;
    // orthonormal basis around the jet axis
    tmpU.set(0, 1, 0).cross(dir);
    if (tmpU.lengthSq() < 1e-6) tmpU.set(1, 0, 0);
    tmpU.normalize();
    tmpW.copy(dir).cross(tmpU).normalize();
    for (let k = 0; k < n; k++) {
      const mist = this.rnd() < 0.18;
      const ang = (mist ? 0.1 : 0.028) * Math.sqrt(this.rnd());
      const phi = this.rnd() * Math.PI * 2;
      const speed = SPRAY_SPEED * (mist ? 0.78 + 0.18 * this.rnd() : 0.97 + 0.06 * this.rnd());
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const cp = Math.cos(phi) * sa;
      const sp = Math.sin(phi) * sa;
      const vx = (dir.x * ca + tmpU.x * cp + tmpW.x * sp) * speed;
      const vy = (dir.y * ca + tmpU.y * cp + tmpW.y * sp) * speed;
      const vz = (dir.z * ca + tmpU.z * cp + tmpW.z * sp) * speed;
      // spread launches across the frame so the jet does not band at low frame rates
      const pre = this.rnd() * dt;
      this.spawn(mist ? 1 : 0, origin.x + vx * pre, origin.y + vy * pre, origin.z + vz * pre, vx, vy, vz, mist ? 1.7 : 2.2);
    }
  }

  step(dt: number, wind: THREE.Vector2, windSpeed: number) {
    let live = 0;
    const sx = FIRE_SITE.skid.x;
    const sz = FIRE_SITE.skid.z;
    for (let i = 0; i < SPRAY_N; i++) {
      const o = i * 3;
      if (this.info[o] >= 1) continue;
      const kind = this.info[o + 1];
      this.age[i] += dt;
      if (kind === 1) {
        // mist parcels: heavy drag, carried by the wind, slightly buoyant
        const drag = Math.exp(-dt * 1.2);
        this.vel[o] = this.vel[o] * drag + wind.x * windSpeed * 0.8 * dt;
        this.vel[o + 1] = this.vel[o + 1] * drag - GRAVITY * 0.3 * dt;
        this.vel[o + 2] = this.vel[o + 2] * drag + wind.y * windSpeed * 0.8 * dt;
      } else {
        this.vel[o + 1] -= GRAVITY * dt;
      }
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      const x = this.pos[o];
      const y = this.pos[o + 1];
      const z = this.pos[o + 2];
      const hitSkid = Math.abs(x - sx) < 2.3 && Math.abs(z - sz) < 1.15 && y < 2.6;
      if ((y < 0.04 || hitSkid) && kind !== 1) {
        if (kind === 0 && this.rnd() < 0.35) {
          const a = this.rnd() * Math.PI * 2;
          const s = 0.6 + 1.6 * this.rnd();
          this.spawn(2, x, Math.max(0.05, y), z, Math.cos(a) * s - this.vel[o] * 0.12, 1.2 + 2.2 * this.rnd(), Math.sin(a) * s - this.vel[o + 2] * 0.12, 0.45);
        }
        this.info[o] = 1;
        continue;
      }
      if (this.age[i] >= this.life[i] || y < -0.5) {
        this.info[o] = 1;
        continue;
      }
      this.info[o] = this.age[i] / this.life[i];
      live++;
    }
    this.live = live;
  }
}

function SprayJet() {
  const jet = useMemo(() => {
    const sim = new SprayJetSim();
    const base = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    const aPos = new THREE.InstancedBufferAttribute(sim.pos, 3).setUsage(THREE.DynamicDrawUsage);
    const aVel = new THREE.InstancedBufferAttribute(sim.vel, 3).setUsage(THREE.DynamicDrawUsage);
    const aInfo = new THREE.InstancedBufferAttribute(sim.info, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aPos', aPos);
    g.setAttribute('aVel', aVel);
    g.setAttribute('aInfo', aInfo);
    g.instanceCount = SPRAY_N;
    const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ name: 'robot-spray', vertexShader: SPRAY_VERT, fragmentShader: WATER_FRAG, ...PREMULT }));
    const heat = new THREE.ShaderMaterial({ name: 'robot-spray-heat', vertexShader: SPRAY_VERT, fragmentShader: WATER_FRAG, defines: { THERMAL: '' }, ...PREMULT });
    mesh.frustumCulled = false;
    mesh.renderOrder = 7;
    mesh.visible = false;
    return { sim, mesh, heat, attrs: [aPos, aVel, aInfo], wind: new THREE.Vector2(0.6, 0.8), lastT: 0 };
  }, []);

  useEffect(() => {
    const off = registerThermal(jet.mesh, jet.heat);
    return () => {
      off();
      jet.mesh.geometry.dispose();
      (jet.mesh.material as THREE.Material).dispose();
      jet.heat.dispose();
    };
  }, [jet]);

  useFrame((_, delta) => {
    const t = sceneClock.t;
    const v = assetVisual.ugv;
    // replay scrubs jump the clock: drop whatever was in flight
    if (Math.abs(t - jet.lastT) > 1500) jet.sim.clear();
    jet.lastT = t;
    const dt = Math.min(delta, 0.05);
    if (v.spraying && v.ready) jet.sim.emit(dt, v.nozzle, v.nozzleDir);
    if (!v.spraying && jet.sim.live === 0) {
      jet.mesh.visible = false;
      return;
    }
    const w = windVector(engine.windDirAt(t));
    jet.wind.set(w.x, w.z);
    jet.sim.step(dt, jet.wind, engine.windSpeedAt(t) / 3.6);
    jet.attrs.forEach((a) => (a.needsUpdate = true));
    jet.mesh.visible = true;
  });

  return <primitive object={jet.mesh} />;
}

// ------------------------------------------------------------------------------------------ equipment

function GeneratorSkid() {
  const group = useMemo(() => {
    const g = buildGeneratorSkid();
    g.position.set(FIRE_SITE.skid.x, 0, FIRE_SITE.skid.z);
    g.rotation.y = FIRE_SITE.skid.heading;
    prepareModel(g, { cast: true, receive: true });
    return g;
  }, []);
  useEffect(() => {
    const off = registerThermalTree(group);
    return () => {
      off();
      disposeTree(group);
    };
  }, [group]);
  return <primitive object={group} />;
}

function DeconShelter({ effect }: { effect: Effect }) {
  const kit = useMemo(() => {
    const tent = buildDeconTent();
    tent.group.position.set(effect.x, 0, effect.z);
    prepareModel(tent.group, { cast: true, receive: true });
    tent.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && /^decon-(windows|signs|showers)/.test(mesh.name)) mesh.castShadow = false;
    });
    const uniforms = { uTime: { value: 0 }, uWash: { value: 0 } };
    const drops = new THREE.Mesh(instancedQuads(220, 53), new THREE.ShaderMaterial({ name: 'decon-wash', uniforms, vertexShader: WASH_VERT, fragmentShader: WATER_FRAG, ...PREMULT }));
    const mist = new THREE.Mesh(instancedQuads(28, 59), new THREE.ShaderMaterial({ name: 'decon-mist', uniforms, vertexShader: MIST_VERT, fragmentShader: WATER_FRAG, ...PREMULT }));
    for (const m of [drops, mist]) {
      m.frustumCulled = false;
      m.renderOrder = 4;
      m.visible = false;
    }
    // the wash lives beside the tent (same transform) so the tent's thermal registration skips it
    const fx = new THREE.Group();
    fx.position.copy(tent.group.position);
    fx.add(drops, mist);
    const root = new THREE.Group();
    root.name = `decon:${effect.id}`;
    root.add(tent.group, fx);
    return { tent, root, drops, mist, uniforms };
  }, [effect]);

  useEffect(() => {
    const offs = [registerThermalTree(kit.tent.group), registerThermal(kit.drops, HIDDEN), registerThermal(kit.mist, HIDDEN)];
    return () => {
      offs.forEach((f) => f());
      kit.tent.dispose();
      for (const m of [kit.drops, kit.mist]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    };
  }, [kit]);

  useFrame((_, dt) => {
    const t = sceneClock.t;
    const k = envelope(effect, t);
    kit.tent.deploy(k);
    const u = kit.uniforms;
    u.uTime.value = Math.max(0, (t - effect.t0) / 1000);
    const want = assetVisual.ugv.washing && k > 0.9 ? 1 : 0;
    u.uWash.value += (want - u.uWash.value) * (1 - Math.exp(-Math.min(dt, 0.1) * 3));
    kit.drops.visible = kit.mist.visible = u.uWash.value > 0.01;
  });

  return <primitive object={kit.root} />;
}

// ------------------------------------------------------------------------------------------ layer

const glowAt = new THREE.Vector3();

export function FireLayer() {
  const tick = useSim((s) => s.tick);
  const fires = useMemo(() => engine.effects.filter((e) => e.kind === 'fire'), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const decons = useMemo(() => engine.effects.filter((e) => e.kind === 'decon'), [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // soot and firelight on the skid follow the most recent fire at it
  useFrame(() => {
    const t = sceneClock.t;
    let fire: Effect | null = null;
    for (const e of engine.effects) {
      if (e.kind !== 'fire' || e.t0 > t || Math.hypot(e.x - FIRE_SITE.skid.x, e.z - FIRE_SITE.skid.z) > 6) continue;
      if (!fire || e.t0 > fire.t0) fire = e;
    }
    if (!fire) {
      skidFx.uScorch.value = 0;
      skidFx.uFireGlow.value = 0;
      return;
    }
    const burnEnd = fire.endAt === null ? t : Math.min(t, fire.endAt);
    skidFx.uScorch.value = THREE.MathUtils.clamp((burnEnd - fire.t0 - 2000) / 45000, 0, 1) * 0.9;
    skidFx.uFireGlow.value = envelope(fire, t) * flicker(t);
    skidFx.uFirePos.value.copy(emitterWorld(fire, 0, glowAt)).setY(1.6);
  });

  return (
    <group name="fire-layer">
      <GeneratorSkid />
      {fires.map((e) => (
        <FireFx key={e.id} effect={e} />
      ))}
      {decons.map((e) => (
        <DeconShelter key={e.id} effect={e} />
      ))}
      <SprayJet />
    </group>
  );
}
