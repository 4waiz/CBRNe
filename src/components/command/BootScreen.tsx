import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { useProgress } from '@react-three/drei';
import { useSim } from '../../store/sim';
import { useSceneStatus } from '../../three/sceneStatus';
import { BridgeLogo } from '../layout/Logo';
import { cx } from '../ui/primitives';

/** Start-up sequence: engine → telemetry buffers → digital twin assets → camera network. */
export function BootScreen() {
  const simReady = useSim((s) => s.ready);
  const sceneReady = useSceneStatus((s) => s.ready);
  const sceneError = useSceneStatus((s) => s.error);
  const { progress } = useProgress();
  const [gone, setGone] = useState(false);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!sceneReady && !sceneError) return;
    const a = setTimeout(() => setFading(true), 350);
    const b = setTimeout(() => setGone(true), 900);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [sceneReady, sceneError]);

  // never trap the operator behind the boot screen if WebGL is slow or unavailable
  useEffect(() => {
    const id = setTimeout(() => setFading(true), 12000);
    const id2 = setTimeout(() => setGone(true), 12600);
    return () => {
      clearTimeout(id);
      clearTimeout(id2);
    };
  }, []);

  if (gone) return null;
  const steps = [
    { label: 'Synthetic scenario engine', done: simReady },
    { label: 'Telemetry buffers · 30 min', done: simReady },
    { label: `Digital twin assets${sceneReady ? '' : ` · ${Math.round(progress)}%`}`, done: sceneReady },
    { label: 'Scene camera network', done: sceneReady },
  ];
  return (
    <div className={cx('fixed inset-0 z-[60] flex items-center justify-center bg-bg-0 transition-opacity duration-500', fading && 'opacity-0')} role="status" aria-live="polite">
      <div className="w-[340px]">
        <div className="flex flex-col items-start gap-2.5">
          <BridgeLogo height={30} />
          <div className="text-[11px] text-ink-3">Integrated CBRN Situational Awareness</div>
        </div>
        <div className="mt-6 flex flex-col gap-2">
          {steps.map((s, i) => (
            <div key={s.label} className="flex items-center gap-2.5 text-[12px]">
              <span className={cx('flex h-[16px] w-[16px] items-center justify-center rounded-full border', s.done ? 'border-green bg-[rgb(61_214_140/0.15)]' : 'border-line-bright')}>
                {s.done ? <Check size={10} className="text-green" /> : <span className="h-[6px] w-[6px] rounded-full bg-cyan animate-pulse" style={{ animationDelay: `${i * 120}ms` }} />}
              </span>
              <span className={s.done ? 'text-ink-1' : 'text-ink-3'}>{s.label}</span>
            </div>
          ))}
        </div>
        <div className="mt-5 h-[2px] overflow-hidden rounded-full bg-[rgb(148_163_184/0.14)]">
          <div className="h-full bg-cyan transition-[width] duration-300" style={{ width: `${sceneReady ? 100 : Math.max(8, progress * 0.9)}%` }} />
        </div>
      </div>
    </div>
  );
}
