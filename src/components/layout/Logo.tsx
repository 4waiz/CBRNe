import bridgeLogoUrl from '../../assets/bridge-logo.png';

/** BRIDGE wordmark (white on transparent, 1154×272 master), sized by height. */
export function BridgeLogo({ height = 22 }: { height?: number }) {
  const width = Math.round((height * 1154) / 272);
  return <img src={bridgeLogoUrl} width={width} height={height} alt="BRIDGE" draggable={false} className="shrink-0 select-none" style={{ width, height }} />;
}
