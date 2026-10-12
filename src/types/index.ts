// Shared domain types for the BRIDGE synthetic scenario engine and UI.
// All values described by these types are generated locally — none come from a real facility.

export type Vec2 = { x: number; z: number };

export type Category = 'chem' | 'bio' | 'rad' | 'nuc';
export type SensorKind = 'rad' | 'chem' | 'bio' | 'met';
export type Severity = 'low' | 'moderate' | 'high';
/** Visual/semantic tone shared by chips, dots, markers and rows. */
export type Tone = 'neutral' | 'info' | 'ok' | 'watch' | 'warn' | 'critical' | 'offline';

export type SensorStatus = 'online' | 'elevated' | 'alert' | 'offline';

export interface SensorDef {
  id: string;
  kind: SensorKind;
  name: string;
  zoneId: string;
  x: number;
  z: number;
  /** anchor height of the marker above ground (m) */
  y: number;
  unit: string;
  baseline: number;
  noise: number;
  /** value above which the reading is flagged "elevated (under review)" */
  reviewAt: number;
  /** value above which the reading is flagged "alert" */
  alertAt: number;
  decimals: number;
  model: string;
}

export interface SensorState {
  id: string;
  value: number | null;
  status: SensorStatus;
  /** % change against the 5-minute-ago reading */
  trend: number;
  /** deviation from baseline in standard deviations */
  sigma: number;
  updatedAt: number;
  /** data-quality score 0..1 (synthetic) */
  quality: number;
}

export type AssetId = 'UGV-01' | 'UAV-01' | 'TEAM-1' | 'RV-02';
export type AssetKind = 'ugv' | 'uav' | 'team' | 'vehicle';

export interface AssetState {
  id: AssetId;
  kind: AssetKind;
  name: string;
  status: string;
  tone: Tone;
  task: string;
  area: string;
  battery: number | null;
  speed: number;
  eta: number | null;
  distance: number | null;
  signal: number;
  x: number;
  z: number;
  headcount?: { present: number; total: number };
}

export type EventCategory = 'chem' | 'bio' | 'rad' | 'asset' | 'system' | 'ai';

export type FocusTarget =
  | { kind: 'sensor'; id: string }
  | { kind: 'asset'; id: AssetId }
  | { kind: 'location'; x: number; z: number; label?: string; radius?: number }
  | { kind: 'zone'; id: string };

export interface SimEvent {
  id: string;
  t: number;
  category: EventCategory;
  tone: Tone;
  title: string;
  detail: string;
  confidence?: number;
  focus?: FocusTarget;
  incidentId?: string;
  observationId?: string;
}

export type IncidentStatus = 'new' | 'acknowledged' | 'investigating' | 'resolved';
export type TimelineKind = 'detect' | 'ai' | 'asset' | 'operator' | 'system' | 'evidence';

export interface TimelineEntry {
  id: string;
  t: number;
  kind: TimelineKind;
  text: string;
  detail?: string;
  actor: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  doneAt?: number;
  priority: 'high' | 'medium' | 'low';
}

export type IncidentCategory = Category | 'thermal' | 'network' | 'multi';

export interface IncidentLocation {
  x: number;
  z: number;
  label: string;
  zoneId: string;
}

export interface Incident {
  id: string;
  title: string;
  category: IncidentCategory;
  severity: Severity;
  status: IncidentStatus;
  createdAt: number;
  acknowledgedAt?: number;
  resolvedAt?: number;
  location: IncidentLocation;
  assigned: AssetId[];
  timeline: TimelineEntry[];
  checklist: ChecklistItem[];
  sensors: string[];
  observationId?: string;
  scenarioRunId: string;
}

export type ObservationStatus = 'monitoring' | 'review' | 'validation' | 'validated' | 'cleared';

export interface Evidence {
  id: string;
  t: number;
  source: string;
  sourceKind: 'sensor' | 'camera' | 'asset' | 'model' | 'lab' | 'network';
  summary: string;
  value?: string;
  weight: number;
}

export interface Observation {
  id: string;
  title: string;
  summary: string;
  category: IncidentCategory;
  status: ObservationStatus;
  confidence: number;
  sources: string[];
  evidence: Evidence[];
  recommended: string[];
  location: IncidentLocation;
  createdAt: number;
  updatedAt: number;
  incidentId?: string;
  scenarioRunId: string;
}

export interface Metrics {
  voc: number;
  vocSensor: string;
  gasOnline: number;
  gasTotal: number;
  chemAlerts: number;
  aerosol: number;
  aerosolSensor: string;
  samplesPending: number;
  bioOnline: number;
  bioTotal: number;
  bioAlerts: number;
  gamma: number;
  gammaSensor: string;
  dosimetersOnline: number;
  dosimetersTotal: number;
  radAlerts: number;
  readiness: number;
  commsUp: number;
  commsTotal: number;
  checklistPct: number;
  drillClosedPct: number;
  sensorsOnline: number;
  sensorsTotal: number;
  videoUp: number;
  videoTotal: number;
  staleFeeds: number;
  ppe: number;
  networkHealth: number;
  latencyMs: number;
}

export interface Weather {
  /** direction the wind blows FROM, degrees clockwise from north */
  windDir: number;
  windSpeed: number;
  gust: number;
  temperature: number;
  humidity: number;
  pressure: number;
  visibility: number;
  stability: string;
}

export interface ResponseKpis {
  ackSeconds: number | null;
  ackRunning: boolean;
  personnelPct: number;
  personnelPresent: number;
  personnelTotal: number;
  remoteCoverage: number;
  openActions: number;
  openHigh: number;
  openMedium: number;
}

export type ScenarioId =
  | 'normal'
  | 'radiological'
  | 'chemical'
  | 'biological'
  | 'degraded'
  | 'thermal'
  | 'multi';

export interface ScenarioParams {
  preset: ScenarioId;
  severity: Severity;
  locationId: string;
  windDir: number;
  windSpeed: number;
  /** minutes; 0 = sustained until reset */
  duration: number;
}

export interface ScenarioRun {
  runId: string;
  preset: ScenarioId;
  label: string;
  severity: Severity;
  locationId: string;
  startedAt: number;
  endsAt: number | null;
}

export type SystemHealthLevel = 'nominal' | 'watch' | 'degraded' | 'alert';
