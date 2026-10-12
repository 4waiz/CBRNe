import * as THREE from 'three';
import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useViewports, feedViews, type FeedView } from './viewports';
import { frameBus } from './frameBus';
import { advanceSceneClock, sceneClock } from './sceneClock';
import { setThermalMode, thermalUniforms, createPaletteTexture } from './thermal';
import {
  createFullscreenTriangle,
  createAOMaterial,
  createAOBlurMaterial,
  createGradeMaterial,
  createVisibleFeedMaterial,
  createThermalFeedMaterial,
  createFusionFeedMaterial,
} from './postShaders';
import { getFeedCamera, updatePipCamera, updateSourceCamera } from './feedCameras';
import { LAYER } from './layers';
import { engine } from '../simulation/engine';
import { envelope } from '../simulation/effects';
import { useUI } from '../store/ui';
import { SKY_COLORS } from './Environment';

export const perfStats = { fps: 60, frameMs: 16.7, drawCalls: 0, triangles: 0, renderScale: 1, mainMs: 0, feedsMs: 0, feedTargets: 0, textures: 0, geometries: 0 };
/** Development switches for profiling (exposed on window.__ENCIRRA_RENDER__). */
export const renderDebug = { main: true, feeds: true, overlays: true, ao: true, aoView: false };
(window as unknown as { __ENCIRRA_RENDER__: unknown }).__ENCIRRA_RENDER__ = { perfStats, renderDebug };

// ---- snapshot requests (Live Feeds → "Snapshot")
type SnapshotRequest = { viewId: string; resolve: (url: string) => void; reject: (e: Error) => void };
const snapshotQueue: SnapshotRequest[] = [];
export function requestSnapshot(viewId: string): Promise<string> {
  return new Promise((resolve, reject) => snapshotQueue.push({ viewId, resolve, reject }));
}

interface Targets {
  color: THREE.WebGLRenderTarget | null;
  heat: THREE.WebGLRenderTarget | null;
  last: number;
  emitted: number;
}

function visibleRect(r: DOMRect) {
  return r.width > 8 && r.height > 8 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

export function RenderLoop() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const quality = useUI((s) => s.settings.quality);
  const paletteKind = useUI((s) => s.settings.palette);

  const res = useMemo(() => {
    const floatOk = gl.extensions.has('EXT_color_buffer_float') || gl.extensions.has('EXT_color_buffer_half_float');
    const type = floatOk ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const quadScene = new THREE.Scene();
    const quad = new THREE.Mesh(createFullscreenTriangle());
    quad.frustumCulled = false;
    quadScene.add(quad);
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const ironbow = createPaletteTexture('ironbow');
    const whitehot = createPaletteTexture('whitehot');
    return {
      type,
      quad,
      quadScene,
      quadCam,
      ironbow,
      whitehot,
      grade: createGradeMaterial(),
      ao: createAOMaterial(),
      aoBlur: createAOBlurMaterial(),
      aoA: null as THREE.WebGLRenderTarget | null,
      aoB: null as THREE.WebGLRenderTarget | null,
      visible: createVisibleFeedMaterial(),
      thermal: createThermalFeedMaterial(ironbow),
      fusion: createFusionFeedMaterial(ironbow),
      main: null as THREE.WebGLRenderTarget | null,
      feeds: new Map<string, Targets>(),
      fpsFrames: 0,
      fpsT0: performance.now(),
      shadowFrame: 0,
      /** the shadow-casting sun, once the scene graph has resolved */
      sun: null as THREE.DirectionalLight | null,
      /** dynamic resolution: adapts render-target size to keep interaction fluid on modest GPUs */
      renderScale: 1,
      lastGovern: performance.now(),
    };
  }, [gl]);

  useEffect(() => {
    const pal = paletteKind === 'whitehot' ? res.whitehot : res.ironbow;
    res.thermal.uniforms.tPalette.value = pal;
    res.fusion.uniforms.tPalette.value = pal;
  }, [paletteKind, res]);

  useEffect(() => {
    gl.shadowMap.autoUpdate = false;
    camera.layers.enable(LAYER.OVERLAY);
    return () => {
      res.main?.depthTexture?.dispose();
      res.main?.dispose();
      res.aoA?.dispose();
      res.aoB?.dispose();
      for (const t of res.feeds.values()) {
        t.color?.dispose();
        t.heat?.dispose();
      }
      [res.grade, res.ao, res.aoBlur, res.visible, res.thermal, res.fusion].forEach((m) => m.dispose());
      res.ironbow.dispose();
      res.whitehot.dispose();
    };
  }, [gl, camera, res]);

  const ensureRT = (rt: THREE.WebGLRenderTarget | null, w: number, h: number, samples: number) => {
    w = Math.max(16, Math.round(w));
    h = Math.max(16, Math.round(h));
    if (!rt) {
      return new THREE.WebGLRenderTarget(w, h, {
        type: res.type,
        samples,
        colorSpace: THREE.LinearSRGBColorSpace,
        depthBuffer: true,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
    }
    if (Math.abs(rt.width - w) > 1 || Math.abs(rt.height - h) > 1) rt.setSize(w, h);
    return rt;
  };

  /** Main render target: like ensureRT, plus a depth texture the AO pass reads. */
  const ensureMainRT = (rt: THREE.WebGLRenderTarget | null, w: number, h: number, samples: number) => {
    w = Math.max(16, Math.round(w));
    h = Math.max(16, Math.round(h));
    if (rt && rt.samples !== samples) {
      rt.depthTexture?.dispose();
      rt.dispose();
      rt = null;
    }
    if (!rt) {
      return new THREE.WebGLRenderTarget(w, h, {
        type: res.type,
        samples,
        colorSpace: THREE.LinearSRGBColorSpace,
        depthBuffer: true,
        depthTexture: new THREE.DepthTexture(w, h),
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
    }
    if (Math.abs(rt.width - w) > 1 || Math.abs(rt.height - h) > 1) rt.setSize(w, h);
    return rt;
  };

  const halfRT = (rt: THREE.WebGLRenderTarget | null, w: number, h: number) => {
    w = Math.max(8, Math.round(w / 2));
    h = Math.max(8, Math.round(h / 2));
    if (!rt) return new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
    return rt;
  };

  const quadPass = (mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) => {
    res.quad.material = mat;
    gl.setRenderTarget(target);
    gl.setScissorTest(false);
    gl.render(res.quadScene, res.quadCam);
  };

  function renderAO(main: THREE.WebGLRenderTarget, cam: THREE.PerspectiveCamera) {
    res.aoA = halfRT(res.aoA, main.width, main.height);
    res.aoB = halfRT(res.aoB, main.width, main.height);
    const depth = main.depthTexture;
    const ao = res.ao.uniforms;
    ao.tDepth.value = depth;
    ao.uProjInv.value.copy(cam.projectionMatrixInverse);
    ao.uTexel.value.set(1 / main.width, 1 / main.height);
    ao.uProjScale.value = (main.height / 2) * cam.projectionMatrix.elements[5];
    quadPass(res.ao, res.aoA);
    const blur = res.aoBlur.uniforms;
    blur.tDepth.value = depth;
    blur.uProjInv.value.copy(cam.projectionMatrixInverse);
    blur.tAO.value = res.aoA.texture;
    blur.uDir.value.set(1 / res.aoA.width, 0);
    quadPass(res.aoBlur, res.aoB);
    blur.tAO.value = res.aoB.texture;
    blur.uDir.value.set(0, 1 / res.aoA.height);
    quadPass(res.aoBlur, res.aoA);
  }

  useFrame((state, delta) => {
    const t0 = performance.now();
    advanceSceneClock(delta * 1000);
    const t = sceneClock.t;
    const dpr = gl.getPixelRatio();
    const maxScale = quality === 'high' ? 1 : 0.8;
    if (res.renderScale > maxScale) res.renderScale = maxScale;
    const scale = res.renderScale;

    // thermal hotspots from the synthetic effects (shared by every heat material)
    thermalUniforms.uTime.value += delta;
    let hc = 0;
    for (const e of engine.effects) {
      if (hc >= 4 || t < e.t0) continue;
      if (e.kind === 'thermal') {
        const env = envelope(e, t);
        if (env <= 0.001) continue;
        thermalUniforms.uHotspots.value[hc].set(e.x, e.z, 3.2, (e.amplitude / 50) * env);
        hc++;
      } else if (e.kind === 'fire') {
        // the seat of a fire saturates the camera; the skid keeps glowing while it cools
        const heat = Math.min(6, engine.fireTempAt(e, t) / 60);
        if (heat <= 0.01) continue;
        thermalUniforms.uHotspots.value[hc].set(e.x, e.z, 2.6, heat);
        hc++;
      }
    }
    thermalUniforms.uHotCount.value = hc;

    gl.setRenderTarget(null);
    gl.setScissorTest(false);
    gl.setClearColor(0x000000, 0);
    gl.clear(true, true, false);
    gl.info.autoReset = false;
    gl.info.reset();

    // shadows: the campus is static, so the shadow map only needs a periodic refresh for the
    // small moving assets (UGV, UAV, people). The scene graph (sun + models) resolves after the first
    // frames on a cold load: when the sun appears, restart the warm-up so its shadow map exists
    // before any material samples it (three would otherwise bind a placeholder depth texture
    // without a compare mode to the sampler2DShadow array, an invalid draw).
    if (res.sun && !res.sun.parent) res.sun = null;
    if (!res.sun) {
      res.sun = (scene.getObjectByProperty('isDirectionalLight', true) as THREE.DirectionalLight | undefined) ?? null;
      if (res.sun) res.shadowFrame = 0;
    }
    res.shadowFrame++;
    gl.shadowMap.needsUpdate =
      (!!res.sun?.castShadow && !res.sun.shadow.map) || res.shadowFrame < 4 || res.shadowFrame % (quality === 'high' ? 20 : 40) === 0;

    const composite = (mat: THREE.ShaderMaterial, r: DOMRect) => {
      res.quad.material = mat;
      gl.setRenderTarget(null);
      const x = r.left;
      const y = window.innerHeight - r.bottom;
      gl.setViewport(x, y, r.width, r.height);
      gl.setScissor(x, y, r.width, r.height);
      gl.setScissorTest(true);
      gl.render(res.quadScene, res.quadCam);
      gl.setScissorTest(false);
    };

    // ------------------------------------------------------------------ main twin view
    const main = useViewports.getState().main;
    const tMain = performance.now();
    if (main && renderDebug.main) {
      const r = main.rectEl.getBoundingClientRect();
      if (visibleRect(r)) {
        const aspect = r.width / r.height;
        if (Math.abs(camera.aspect - aspect) > 1e-4) {
          camera.aspect = aspect;
          camera.updateProjectionMatrix();
        }
        res.main = ensureMainRT(res.main, r.width * dpr * scale, r.height * dpr * scale, quality === 'high' && scale > 0.75 ? 4 : 2);
        setThermalMode(false);
        gl.setRenderTarget(res.main);
        gl.setClearColor(SKY_COLORS.horizon, 1);
        gl.clear(true, true, false);
        if (renderDebug.overlays) camera.layers.enable(LAYER.OVERLAY);
        else camera.layers.disable(LAYER.OVERLAY);
        gl.render(scene, camera);
        // ambient occlusion (high quality): half-resolution obscurance + depth-aware blur
        const useAO = quality === 'high' && renderDebug.ao;
        if (useAO) renderAO(res.main, camera);
        res.grade.uniforms.uAO.value = useAO ? 0.85 : 0;
        res.grade.uniforms.uAODebug.value = useAO && renderDebug.aoView ? 1 : 0;
        res.grade.uniforms.tAO.value = useAO && res.aoA ? res.aoA.texture : null;
        res.grade.uniforms.tColor.value = res.main.texture;
        res.grade.uniforms.uRes.value.set(res.main.width, res.main.height);
        res.grade.uniforms.uTime.value = state.clock.elapsedTime;
        res.grade.uniforms.uReplay.value = sceneClock.replay ? 1 : 0;
        composite(res.grade, r);
        frameBus.emitMain({ camera, rect: r, t });
      }
    }

    // ------------------------------------------------------------------ camera feeds
    const now = performance.now();
    perfStats.mainMs = perfStats.mainMs * 0.9 + (now - tMain) * 0.1;
    if (renderDebug.feeds) {
      for (const v of feedViews.values()) {
        const r = v.el.getBoundingClientRect();
        if (!visibleRect(r)) continue;
        renderFeed(v, r, now, t);
      }
    }
    perfStats.feedsMs = perfStats.feedsMs * 0.9 + (performance.now() - now) * 0.1;
    perfStats.renderScale = res.renderScale;

    gl.setRenderTarget(null);
    gl.setScissorTest(false);

    // perf + dynamic resolution governor
    res.fpsFrames++;
    if (now - res.fpsT0 > 1000) {
      perfStats.fps = (res.fpsFrames * 1000) / (now - res.fpsT0);
      res.fpsFrames = 0;
      res.fpsT0 = now;
      perfStats.drawCalls = gl.info.render.calls;
      perfStats.triangles = gl.info.render.triangles;
      // release the render targets of feed views that have unmounted (screen changes)
      for (const [key, tg] of res.feeds) {
        if (feedViews.has(key)) continue;
        tg.color?.dispose();
        tg.heat?.dispose();
        res.feeds.delete(key);
      }
      perfStats.feedTargets = res.feeds.size;
      perfStats.textures = gl.info.memory.textures;
      perfStats.geometries = gl.info.memory.geometries;
      if (document.visibilityState === 'visible' && now - res.lastGovern > 1500) {
        res.lastGovern = now;
        if (perfStats.fps < 40 && res.renderScale > 0.5) res.renderScale = Math.max(0.5, res.renderScale - 0.1);
        else if (perfStats.fps > 57 && res.renderScale < maxScale) res.renderScale = Math.min(maxScale, res.renderScale + 0.05);
      }
    }
    perfStats.frameMs = perfStats.frameMs * 0.9 + (performance.now() - t0) * 0.1;
  }, 1);

  function renderFeed(v: FeedView, r: DOMRect, now: number, t: number) {
    const dpr = gl.getPixelRatio();
    const large = v.size === 'large';
    const key = v.id;
    let tg = res.feeds.get(key);
    if (!tg) {
      tg = { color: null, heat: null, last: 0, emitted: 0 };
      res.feeds.set(key, tg);
    }
    const cam = getFeedCamera(v.source === 'PIP' ? `PIP:${key}` : v.source);
    const aspect = r.width / r.height;
    if (Math.abs(cam.aspect - aspect) > 1e-4) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
    const stale = v.source !== 'PIP' && engine.isFeedStale(v.source);
    const fps = large ? 24 : quality === 'high' ? 12 : 8;
    const due = now - tg.last >= 1000 / fps - 2;
    const needColor = v.mode !== 'thermal';
    const needHeat = v.mode !== 'visible';
    const cap = (large ? 1 : 0.8) * Math.max(0.6, res.renderScale);
    const cw = Math.min(r.width * dpr * cap, large ? 1920 : 760);
    const ch = Math.min(r.height * dpr * cap, large ? 1200 : 480);
    // a freshly allocated target must be drawn this frame, whatever the feed's frame rate
    const firstFrame = (needColor && !tg.color) || (needHeat && !tg.heat);
    if (needColor) tg.color = ensureRT(tg.color, cw, ch, large ? 4 : 2);
    else if (tg.color) {
      tg.color.dispose();
      tg.color = null;
    }
    if (needHeat) tg.heat = ensureRT(tg.heat, cw * 0.55, ch * 0.55, 0);
    else if (tg.heat) {
      tg.heat.dispose();
      tg.heat = null;
    }

    if ((due && !stale) || firstFrame) {
      if (v.source === 'PIP') updatePipCamera(cam, v.pip ?? { x: 0, z: 0 });
      else updateSourceCamera(v.source, t, cam);
      if (needColor && tg.color) {
        setThermalMode(false);
        gl.setRenderTarget(tg.color);
        gl.setClearColor(SKY_COLORS.horizon, 1);
        gl.clear(true, true, false);
        gl.render(scene, cam);
      }
      if (needHeat && tg.heat) {
        setThermalMode(true);
        gl.setRenderTarget(tg.heat);
        gl.setClearColor(0x000000, 1);
        gl.clear(true, true, false);
        gl.render(scene, cam);
        setThermalMode(false);
      }
      tg.last = now;
      frameBus.emitFeed(key, { camera: cam, rect: r, t });
    }

    let mat: THREE.ShaderMaterial;
    if (v.mode === 'thermal' && tg.heat) {
      mat = res.thermal;
      mat.uniforms.tHeat.value = tg.heat.texture;
      mat.uniforms.uRes.value.set(tg.heat.width, tg.heat.height);
      mat.uniforms.uStale.value = stale ? 1 : 0;
    } else if (v.mode === 'fusion' && tg.heat && tg.color) {
      mat = res.fusion;
      mat.uniforms.tColor.value = tg.color.texture;
      mat.uniforms.tHeat.value = tg.heat.texture;
      mat.uniforms.uRes.value.set(tg.color.width, tg.color.height);
    } else if (tg.color) {
      mat = res.visible;
      mat.uniforms.tColor.value = tg.color.texture;
      mat.uniforms.uRes.value.set(tg.color.width, tg.color.height);
      mat.uniforms.uStale.value = stale ? 1 : 0;
      mat.uniforms.uNoise.value = v.source === 'PIP' ? 0.012 : 0.032;
      mat.uniforms.uSat.value = v.source === 'PIP' ? 1 : v.source === 'UAV-01' ? 0.98 : 0.9;
    } else return;
    mat.uniforms.uTime.value = now / 1000;

    res.quad.material = mat;
    const x = r.left;
    const y = window.innerHeight - r.bottom;
    gl.setRenderTarget(null);
    gl.setViewport(x, y, r.width, r.height);
    gl.setScissor(x, y, r.width, r.height);
    gl.setScissorTest(true);
    gl.render(res.quadScene, res.quadCam);
    gl.setScissorTest(false);

    // snapshot: read the just-composited pixels back from the drawing buffer (same frame)
    const reqIndex = snapshotQueue.findIndex((q) => q.viewId === key);
    if (reqIndex >= 0) {
      const req = snapshotQueue.splice(reqIndex, 1)[0];
      try {
        const w = Math.round(r.width * dpr);
        const h = Math.round(r.height * dpr);
        const ctxGl = gl.getContext();
        const buf = new Uint8Array(w * h * 4);
        ctxGl.readPixels(Math.round(x * dpr), Math.round(y * dpr), w, h, ctxGl.RGBA, ctxGl.UNSIGNED_BYTE, buf);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d') as CanvasRenderingContext2D;
        const img = ctx.createImageData(w, h);
        for (let row = 0; row < h; row++) img.data.set(buf.subarray((h - 1 - row) * w * 4, (h - row) * w * 4), row * w * 4);
        ctx.putImageData(img, 0, 0);
        req.resolve(c.toDataURL('image/png'));
      } catch (e) {
        req.reject(e as Error);
      }
    }
  }

  return null;
}
