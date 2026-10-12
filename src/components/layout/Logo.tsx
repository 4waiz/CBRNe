import logoUrl from '../../assets/encirra-logo.png';
import bridgeLogoUrl from '../../assets/bridge-logo.png';

/** ENCIRRA mark (brand logo, rendered from the raster master in src/assets). */
export function LogoMark({ size = 24 }: { size?: number }) {
  return <img src={logoUrl} width={size} height={size} alt="" aria-hidden draggable={false} className="shrink-0 select-none" style={{ width: size, height: size }} />;
}

/** BRIDGE wordmark (white on transparent, 1154×272 master), sized by height. */
export function BridgeLogo({ height = 22 }: { height?: number }) {
  const width = Math.round((height * 1154) / 272);
  return <img src={bridgeLogoUrl} width={width} height={height} alt="BRIDGE" draggable={false} className="shrink-0 select-none" style={{ width, height }} />;
}
