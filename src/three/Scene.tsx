import { Suspense, useEffect, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { SceneEnvironment } from './Environment';
import { Terrain } from './Terrain';
import { Ocean } from './Ocean';
import { Vegetation } from './Vegetation';
import { Facility } from './Facility';
import { AssetLayer } from './AssetLayer';
import { IncidentLayer } from './IncidentLayer';
import { PlumeLayer } from './PlumeLayer';
import { FireLayer } from './FireLayer';
import { MarkerLayer, RouteLayer, WeatherLayer, ZonesLayer } from './OverlayLayers';
import { CameraRig, HOME } from './CameraRig';
import { RenderLoop } from './RenderLoop';
import { createShoreMask } from './textures/shoreMask';
import { preloadModels } from './models';
import { useUI } from '../store/ui';
import { useSceneStatus } from './sceneStatus';

preloadModels();

function ReadySignal() {
  useEffect(() => {
    // give the first frames a moment to compile shaders before revealing the view
    const id = setTimeout(() => useSceneStatus.getState().setReady(), 450);
    return () => clearTimeout(id);
  }, []);
  return null;
}

export default function SceneCanvas() {
  const quality = useUI((s) => s.settings.quality);
  const shoreTex = useMemo(createShoreMask, []);
  return (
    <Canvas
      style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }}
      dpr={quality === 'high' ? [1, 1.75] : [1, 1.25]}
      gl={{ antialias: false, alpha: true, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: false }}
      camera={{ fov: 30, near: 4, far: 12500, position: [HOME.pos.x, HOME.pos.y, HOME.pos.z], manual: true }}
      shadows="percentage"
      frameloop="always"
      onCreated={({ gl }) => {
        gl.shadowMap.autoUpdate = false;
        gl.toneMappingExposure = 1.0;
        // driver compiler notes (e.g. ANGLE/D3D precision remarks) are noise in production builds
        gl.debug.checkShaderErrors = import.meta.env.DEV;
        gl.domElement.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          useSceneStatus.getState().setError('The 3D renderer lost its graphics context. Reload to restore the digital twin.');
        });
      }}
    >
      <Suspense fallback={null}>
        <SceneEnvironment />
        <Terrain shoreTex={shoreTex} />
        <Ocean shoreTex={shoreTex} />
        <Vegetation />
        <Facility />
        <AssetLayer />
        <FireLayer />
        <IncidentLayer />
        <PlumeLayer />
        <ZonesLayer />
        <WeatherLayer />
        <RouteLayer />
        <MarkerLayer />
        <ReadySignal />
      </Suspense>
      <CameraRig />
      <RenderLoop />
    </Canvas>
  );
}
