import { useEffect, useState } from 'react';
import { useSim } from '../../store/sim';
import { perfStats } from '../../three/RenderLoop';

function Fps() {
  const [fps, setFps] = useState(60);
  useEffect(() => {
    const id = setInterval(() => setFps(perfStats.fps), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="mono">{Math.round(fps)} fps</span>;
}

export function Footer() {
  const online = useSim((s) => s.metrics.sensorsOnline);
  const total = useSim((s) => s.metrics.sensorsTotal);
  return (
    <footer className="relative z-20 flex h-[24px] shrink-0 items-center gap-4 border-t border-line bg-bg-1/95 px-4 text-[10.5px] text-ink-3">
      <span className="font-cond uppercase tracking-[0.12em] text-ink-2">BRIDGE 1.0</span>
      <span aria-hidden>·</span>
      <span>
        Fusion engine <span className="mono text-ink-2">1 Hz</span>
      </span>
      <span aria-hidden>·</span>
      <span>
        <span className="mono text-ink-2">
          {online}/{total}
        </span>{' '}
        sources
      </span>
      <span aria-hidden>·</span>
      <span>
        Render <Fps />
      </span>
      <span className="ml-auto">
        BRIDGE for Barakah <span aria-hidden className="px-1 text-ink-4">•</span> Developed by{' '}
        <a
          href="https://kanbanstudios.ae/team-kanban"
          target="_blank"
          rel="noreferrer"
          className="text-ink-2 underline decoration-ink-4 underline-offset-2 transition-colors hover:text-ink-1 hover:decoration-cyan"
        >
          Awaiz Ahmed
        </a>
      </span>
    </footer>
  );
}
