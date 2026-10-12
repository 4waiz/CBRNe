import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { engine } from '../simulation/engine';
import { envelope, type Effect } from '../simulation/effects';
import { useSim } from '../store/sim';
import { useUI } from '../store/ui';
import { sceneClock } from './sceneClock';
import { LAYER } from './layers';
import { windVector } from '../utils/math';

const FIELD_VERT = /* glsl */ `
  varying vec2 vXZ;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vXZ = wp.xz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

/** Same analytic dose-rate field as the engine (radField) evaluated per pixel. */
const RAD_FRAG = /* glsl */ `
  uniform vec2 uCenter;
  uniform float uSigma;
  uniform vec2 uWind;
  uniform float uLevel;
  uniform float uTime;
  uniform float uOpacity;
  varying vec2 vXZ;
  float field(vec2 p) {
    vec2 d = p - uCenter;
    float along = dot(d, uWind);
    float cross = -d.x * uWind.y + d.y * uWind.x;
    float s = uSigma;
    float sa = 1.9 * s;
    float sc = 0.85 * s;
    float plume = exp(-pow(along - 0.7 * s, 2.0) / (2.0 * sa * sa) - cross * cross / (2.0 * sc * sc));
    float core = exp(-dot(d, d) / (2.0 * pow(0.45 * s, 2.0)));
    return min(1.0, 0.72 * plume + 0.55 * core);
  }
  void main() {
    float f = field(vXZ) * uLevel;
    if (f < 0.015) discard;
    vec3 yellow = vec3(1.0, 0.78, 0.26);
    vec3 orange = vec3(1.0, 0.42, 0.1);
    vec3 red = vec3(0.86, 0.12, 0.09);
    vec3 col = mix(yellow, orange, smoothstep(0.12, 0.5, f));
    col = mix(col, red, smoothstep(0.55, 0.95, f));
    float alpha = smoothstep(0.015, 0.3, f) * 0.5 + smoothstep(0.45, 1.0, f) * 0.22;
    float lv = f * 8.0 - uTime * 0.22;
    float g = fract(lv);
    float dist = min(g, 1.0 - g);
    float contour = 1.0 - smoothstep(0.0, fwidth(lv) * 1.4, dist);
    alpha += contour * 0.5 * smoothstep(0.04, 0.2, f);
    col = mix(col, vec3(1.0, 0.92, 0.75), contour * 0.35);
    gl_FragColor = vec4(col * 1.25, clamp(alpha, 0.0, 0.85) * uOpacity);
  }
`;

const SPARK_VERT = /* glsl */ `
  attribute vec4 aSeed;
  uniform vec2 uCenter;
  uniform float uSigma;
  uniform float uTime;
  uniform float uLevel;
  varying float vAlpha;
  void main() {
    float life = 5.0 + aSeed.w * 4.0;
    float age = fract(uTime / life + aSeed.x);
    float r = sqrt(aSeed.y) * uSigma * 1.1;
    float a = aSeed.z * 6.28318;
    vec3 p = vec3(uCenter.x + cos(a) * r, 1.0 + age * (10.0 + aSeed.w * 14.0), uCenter.y + sin(a) * r);
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(1400.0 / -mv.z, 1.5, 5.0);
    float core = exp(-r * r / (2.0 * uSigma * uSigma * 0.35));
    vAlpha = uLevel * core * smoothstep(0.0, 0.15, age) * (1.0 - smoothstep(0.6, 1.0, age));
  }
`;

const SPARK_FRAG = /* glsl */ `
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    gl_FragColor = vec4(vec3(1.0, 0.7, 0.32) * 2.2, (1.0 - smoothstep(0.1, 0.5, d)) * vAlpha);
  }
`;

const BEAM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float fade = pow(1.0 - vUv.y, 2.2);
    float band = 0.75 + 0.25 * sin(vUv.y * 40.0 - uTime * 3.0);
    gl_FragColor = vec4(uColor * 1.6, fade * band * 0.32 * uOpacity);
  }
`;

const RING_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec2 c = vUv - 0.5;
    float r = length(c) * 2.0;
    float wave = fract(uTime * 0.45);
    float ring = 1.0 - smoothstep(0.0, 0.05, abs(r - wave));
    float inner = 1.0 - smoothstep(0.0, 0.03, abs(r - 0.32));
    float a = ring * (1.0 - wave) * 0.85 + inner * 0.7;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor * 1.5, a * uOpacity);
  }
`;

const UV_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  }
`;

const RAD_REF = 0.3; // µSv/h mapped to full colour

function RadField({ effect }: { effect: Effect }) {
  const visible = useUI((s) => s.layers.radiation);
  const opacity = useRef(0);
  const { mesh, sparks, uniforms } = useMemo(() => {
    const uniforms = {
      uCenter: { value: new THREE.Vector2(effect.x, effect.z) },
      uSigma: { value: effect.sigma },
      uWind: { value: new THREE.Vector2(0.7, 0.7) },
      uLevel: { value: 0 },
      uTime: { value: 0 },
      uOpacity: { value: 0 },
    };
    const geo = new THREE.PlaneGeometry(effect.sigma * 16, effect.sigma * 16, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: FIELD_VERT, fragmentShader: RAD_FRAG, transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(effect.x, 0.9, effect.z);
    mesh.renderOrder = 2;
    mesh.layers.set(LAYER.OVERLAY);
    const N = 180;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3));
    const seeds = new Float32Array(N * 4);
    for (let i = 0; i < N * 4; i++) seeds[i] = Math.random();
    sg.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 4));
    const smat = new THREE.ShaderMaterial({ uniforms, vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const sparks = new THREE.Points(sg, smat);
    sparks.frustumCulled = false;
    sparks.layers.set(LAYER.OVERLAY);
    return { mesh, sparks, uniforms };
  }, [effect]);

  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      sparks.geometry.dispose();
      (sparks.material as THREE.Material).dispose();
    },
    [mesh, sparks],
  );

  useFrame((_, dt) => {
    const t = sceneClock.t;
    const env = envelope(effect, t);
    const w = windVector(engine.windDirAt(t));
    const cur = uniforms.uWind.value;
    cur.lerp(new THREE.Vector2(w.x, w.z), 1 - Math.exp(-dt * 2)).normalize();
    uniforms.uLevel.value = (effect.amplitude * env) / RAD_REF;
    uniforms.uTime.value += dt;
    opacity.current += ((visible ? 1 : 0) - opacity.current) * (1 - Math.exp(-dt * 6));
    uniforms.uOpacity.value = opacity.current;
    mesh.visible = sparks.visible = opacity.current > 0.01 && env > 0.001;
  });

  return (
    <>
      <primitive object={mesh} />
      <primitive object={sparks} />
    </>
  );
}

const SEVERITY_COLOR = { low: new THREE.Color('#f2b33d'), moderate: new THREE.Color('#ff8a3d'), high: new THREE.Color('#f0534d') };

/** Ground rings plus a light column; a fire gets no column (its own smoke marks the spot). */
function IncidentBeacon({ x, z, severity, column = true }: { x: number; z: number; severity: 'low' | 'moderate' | 'high'; column?: boolean }) {
  const { group, uniforms } = useMemo(() => {
    const uniforms = { uColor: { value: SEVERITY_COLOR[severity].clone() }, uTime: { value: 0 }, uOpacity: { value: 1 } };
    const g = new THREE.Group();
    const ringGeo = new THREE.PlaneGeometry(60, 60);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, new THREE.ShaderMaterial({ uniforms, vertexShader: UV_VERT, fragmentShader: RING_FRAG, transparent: true, depthWrite: false }));
    ring.position.y = 1.1;
    g.add(ring);
    if (column) {
      const beamGeo = new THREE.CylinderGeometry(2.4, 2.4, 140, 24, 1, true);
      beamGeo.translate(0, 70, 0);
      g.add(new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({ uniforms, vertexShader: UV_VERT, fragmentShader: BEAM_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })));
    }
    g.position.set(x, 0, z);
    g.traverse((o) => o.layers.set(LAYER.OVERLAY));
    g.renderOrder = 3;
    return { group: g, uniforms };
  }, [x, z, severity, column]);
  useEffect(
    () => () =>
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          (m.material as THREE.Material).dispose();
        }
      }),
    [group],
  );
  useFrame((_, dt) => {
    uniforms.uTime.value += dt;
  });
  return <primitive object={group} />;
}

export function IncidentLayer() {
  const tick = useSim((s) => s.tick);
  const incidents = useSim((s) => s.incidents);
  // rad effects relevant for the current scene time (re-evaluated each sim tick)
  const radEffects = useMemo(() => engine.effects.filter((e) => e.kind === 'rad'), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = incidents.filter((i) => i.status !== 'resolved');
  return (
    <group name="incident-layer">
      {radEffects.map((e) => (
        <RadField key={e.id} effect={e} />
      ))}
      {active.map((i) => (
        <IncidentBeacon key={i.id} x={i.location.x} z={i.location.z} severity={i.severity} column={i.category !== 'fire'} />
      ))}
    </group>
  );
}
