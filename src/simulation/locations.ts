import type { Vec2 } from '../types';

/** Generalized scenario locations (fictional points in the synthetic campus). */
export interface ScenarioLocation {
  id: string;
  label: string;
  short: string;
  sector: string;
  zoneId: string;
  x: number;
  z: number;
  /** stand-off point on the road network where an inspection asset stops */
  inspect: Vec2;
  equipment: string;
  sensors: { rad: string[]; chem: string[]; bio: string[] };
}

export const LOCATIONS: ScenarioLocation[] = [
  {
    id: 'U3-EAST',
    label: 'Unit 3 · east service corridor',
    short: 'Unit 3 east corridor',
    sector: 'Sector B',
    zoneId: 'SEC-B',
    x: 178,
    z: -150,
    inspect: { x: 200, z: -142 },
    equipment: 'Equipment skid B3',
    sensors: { rad: ['RAD-S17', 'RAD-S15', 'RAD-S21', 'RAD-S18'], chem: ['AIR-C12', 'AIR-C09'], bio: ['BIO-A07'] },
  },
  {
    id: 'U1-WEST',
    label: 'Unit 1 · west yard',
    short: 'Unit 1 west yard',
    sector: 'Sector A',
    zoneId: 'SEC-A',
    x: -362,
    z: -118,
    inspect: { x: -400, z: -118 },
    equipment: 'Equipment skid A1',
    sensors: { rad: ['RAD-S10', 'RAD-S12', 'RAD-S11', 'RAD-S27'], chem: ['AIR-C05', 'AIR-C03'], bio: ['BIO-A11'] },
  },
  {
    id: 'SERVICE',
    label: 'Service zone · chemical store',
    short: 'Service zone',
    sector: 'Service zone',
    zoneId: 'SERVICE',
    x: 486,
    z: 104,
    inspect: { x: 452, z: 112 },
    equipment: 'Chemical store bay 2',
    sensors: { rad: ['RAD-S24'], chem: ['AIR-C08', 'AIR-C14', 'AIR-C09'], bio: ['BIO-A13'] },
  },
  {
    id: 'ADMIN',
    label: 'Administration campus · north lawn',
    short: 'Admin campus',
    sector: 'Admin zone',
    zoneId: 'ADMIN',
    x: -470,
    z: 106,
    inspect: { x: -400, z: 100 },
    equipment: 'Admin block HVAC intake',
    sensors: { rad: ['RAD-S27', 'RAD-S11'], chem: ['AIR-C03'], bio: ['BIO-A04', 'BIO-A11'] },
  },
  {
    id: 'SWITCHYARD',
    label: 'Switchyard · transformer bay 3',
    short: 'Switchyard bay 3',
    sector: 'Electrical',
    zoneId: 'SWITCHYARD',
    x: 40,
    z: 196,
    inspect: { x: 40, z: 146 },
    equipment: 'Transformer bay 3',
    sensors: { rad: ['RAD-S18'], chem: ['AIR-C09'], bio: ['BIO-A07'] },
  },
  {
    id: 'YARD',
    label: 'Service yard · generator skid G2',
    short: 'Service yard',
    sector: 'Service zone',
    zoneId: 'SERVICE',
    x: 484,
    z: 228,
    inspect: { x: 474.5, z: 219.5 },
    equipment: 'Generator skid G2',
    sensors: { rad: ['RAD-S24'], chem: ['AIR-C08', 'AIR-C14'], bio: ['BIO-A13'] },
  },
  {
    id: 'INTAKE',
    label: 'Marine intake · Unit 3 forebay',
    short: 'Unit 3 intake',
    sector: 'Coastal band',
    zoneId: 'COAST',
    x: 100,
    z: -306,
    inspect: { x: 100, z: -284 },
    equipment: 'Intake screen house 3',
    sensors: { rad: ['RAD-S14', 'RAD-S15'], chem: ['AIR-C12'], bio: ['BIO-A07'] },
  },
];

export const LOCATION_BY_ID: Record<string, ScenarioLocation> = Object.fromEntries(LOCATIONS.map((l) => [l.id, l]));

/**
 * Fire-response layout in the service yard (fictional): the generator skid that catches fire, the robot's
 * upwind stand-off point, the inflatable decontamination shelter DECON-1 west of the robotics garage, the
 * robot dock and the personnel assembly point. The robot walks off-road between them on these paths.
 */
export const FIRE_SITE = {
  fire: { x: 484, z: 228 },
  /** generator skid: centre and long-axis heading (radians, three.js rotation.y) */
  skid: { x: 484, z: 228, heading: Math.PI / 2 },
  standoff: { x: 474.5, z: 219.5 },
  /** DECON-1: long axis along x, entered from the east (dirty side), left by the west door (clean side) */
  tent: { x: 420, z: 256, length: 10, width: 5.4, height: 3.1 },
  toTent: [
    { x: 474.5, z: 219.5 },
    { x: 469, z: 246 },
    { x: 436, z: 256 },
    { x: 420, z: 256 },
  ] as Vec2[],
  toDock: [
    { x: 420, z: 256 },
    { x: 406, z: 256 },
    { x: 406, z: 241 },
    { x: 419, z: 232.5 },
  ] as Vec2[],
  dock: { x: 419, z: 232.5 },
  assembly: { x: 410, z: 186 },
} as const;
