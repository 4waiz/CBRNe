import type { SensorDef, SensorKind } from '../types';

// Fictional sensor identities placed in generalized open areas of the synthetic campus.
// IDs, models and positions are invented for this concept and do not describe any real device.

const rad = (id: string, x: number, z: number, zoneId: string, baseline: number): SensorDef => ({
  id,
  kind: 'rad',
  name: 'Area gamma monitor',
  zoneId,
  x,
  z,
  y: 4.4,
  unit: 'µSv/h',
  baseline,
  noise: 0.0045,
  reviewAt: 0.18,
  alertAt: 0.32,
  decimals: 3,
  model: 'Scintillation dose-rate probe (synthetic)',
});

const chem = (id: string, x: number, z: number, zoneId: string, baseline: number): SensorDef => ({
  id,
  kind: 'chem',
  name: 'VOC / gas monitor',
  zoneId,
  x,
  z,
  y: 4.4,
  unit: 'ppm',
  baseline,
  noise: 0.011,
  reviewAt: 0.8,
  alertAt: 1.6,
  decimals: 2,
  model: 'PID volatile-organics sensor (synthetic)',
});

const bio = (id: string, x: number, z: number, zoneId: string, baseline: number): SensorDef => ({
  id,
  kind: 'bio',
  name: 'Aerosol trigger / sampler',
  zoneId,
  x,
  z,
  y: 4.4,
  unit: 'idx',
  baseline,
  noise: 0.9,
  reviewAt: 30,
  alertAt: 55,
  decimals: 0,
  model: 'Particle-size aerosol trigger (synthetic)',
});

export const SENSORS: SensorDef[] = [
  rad('RAD-S10', -384, -138, 'SEC-A', 0.104),
  rad('RAD-S11', -330, 14, 'SUPPORT', 0.097),
  rad('RAD-S12', -188, -150, 'SEC-A', 0.109),
  rad('RAD-S14', -62, -230, 'COAST', 0.092),
  rad('RAD-S15', 12, -150, 'SEC-B', 0.113),
  rad('RAD-S17', 184, -126, 'SEC-B', 0.111),
  rad('RAD-S18', 262, 18, 'SUPPORT', 0.101),
  rad('RAD-S21', 372, -150, 'SEC-B', 0.106),
  rad('RAD-S24', 560, -100, 'EAST', 0.094),
  rad('RAD-S27', -540, -60, 'WEST', 0.088),
  chem('AIR-C03', -450, 14, 'ADMIN', 0.39),
  chem('AIR-C05', -262, 60, 'SUPPORT', 0.42),
  chem('AIR-C08', 522, 121, 'SERVICE', 0.41),
  chem('AIR-C09', 300, 24, 'SUPPORT', 0.4),
  chem('AIR-C12', 40, -236, 'COAST', 0.38),
  chem('AIR-C14', 560, 190, 'SERVICE', 0.43),
  bio('BIO-A04', -430, 128, 'ADMIN', 11),
  bio('BIO-A07', -22, 132, 'SUPPORT', 9),
  bio('BIO-A11', -120, 30, 'SUPPORT', 12),
  bio('BIO-A13', 380, 250, 'SERVICE', 10),
  {
    id: 'MET-W01',
    kind: 'met',
    name: 'Environmental Monitoring Sensor (EMS)',
    zoneId: 'WEST',
    x: -560,
    z: -150,
    y: 52,
    unit: 'km/h',
    baseline: 12,
    noise: 0.6,
    reviewAt: 45,
    alertAt: 60,
    decimals: 1,
    model: 'Ultrasonic anemometer + T/RH (synthetic)',
  },
];

export const SENSOR_BY_ID: Record<string, SensorDef> = Object.fromEntries(SENSORS.map((s) => [s.id, s]));

export const SENSOR_KIND_LABEL: Record<SensorKind, string> = {
  rad: 'Radiological',
  chem: 'Chemical',
  bio: 'Biological',
  met: 'Meteorological',
};

/** Network-level totals (the 3D view shows the primary nodes of a larger synthetic network). */
export const NETWORK = {
  sensorsTotal: 200,
  baselineOffline: 4,
  gasTotal: 24,
  bioTotal: 12,
  dosimetersTotal: 48,
  videoTotal: 4,
  commsTotal: 4,
  personnelTotal: 342,
};
