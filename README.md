<img src="src/assets/bridge-logo.png" height="48" alt="BRIDGE logo" />


**BRIDGE | CBRN Command Center**: an integrated CBRN situational-awareness interface with an interactive 3D digital twin, synthetic camera and robot feeds, AI-assisted correlation and an incident-response workflow.

> Conceptual situational-awareness environment using synthetic local data. No connection to operational Barakah systems.
> All readings, events, images and AI observations are generated in the browser by a seeded scenario engine. The 3D campus is a fictional, generalized layout.

## Run

```bash
npm install
npm run dev            # http://localhost:5173
```

Production build:

```bash
npm run build          # type-check + Vite build → dist/
npm run preview        # http://localhost:4173
```

Requirements: Node 20+ and a WebGL2-capable browser (Chrome / Edge recommended).

### Demo film

[`media/demo-video/out/encirra-demo.mp4`](media/demo-video/out/encirra-demo.mp4) is a one-minute narrated walkthrough of the whole application, recorded from the production build on a controlled clock and composed as code, with a Kokoro voiceover, music and UI sound. How it is made and how to re-record it: [media/demo-video/README.md](media/demo-video/README.md).

### Screenshot capture

`npm run screenshots` drives the running app in the locally installed Microsoft Edge (via `playwright-core`, so no browser download is needed). It waits for the opening multi-source event to reach human validation, then writes five 1600×900 captures to `screenshots/phase-1/`:

```bash
npm run dev                                   # in one terminal
npm run screenshots                           # in another
```

The Phase 2 set was captured from the production build:

```bash
npm run build && npm run preview              # http://localhost:4173
node tools/screenshots/capture.mjs screenshots/phase-2 --suffix=-final --url=http://localhost:4173/
```

`tools/screenshots/functional-check.mjs [outDir] [--url=…]` runs the scripted functional QA pass (navigation and hash routing, command palette, scenario transitions, incident lifecycle with notes, replay, picking, inspector + focus, layers, WASD in the twin and in Live Feeds, feeds and snapshot, wind, auto-framing, persisted state across reload, 1366×768 / 1920×1080 overflow) and reports failed requests, console errors and warnings. `perf-probe.mjs` reports frame rate and render statistics. Findings and fixes from the QA pass are in [QA_NOTES.md](QA_NOTES.md).

`fire-check.mjs [outDir]` runs the Fire response scenario end to end (about three minutes) and checks every robot phase, the order of the response checklist, that the incident closes itself and that replay shows the same scene.

`ui-audit.mjs [outDir] [--sizes=1280x720,1920x1080] [--views=overview,twin] [--scenario=fire]` captures every screen, the settings tabs and the command palette at several window sizes (with real scrollbars) and reports overlapping or clipped text, controls and rows spilling out of their containers, and content pushed off-screen. `look.mjs [outDir]` renders the 3D twin from fixed camera poses with the UI hidden, for judging materials, lighting and terrain.

## Using it

| | |
|---|---|
| **Overview** | KPI row (chemical, biological, radiological, nuclear readiness), AI fusion, stream health, field assets, 3D twin, four live scene cameras, telemetry lanes, event stream, response KPIs |
| **3D Twin** | Immersive twin with layers, incident status, environment, an inspector for sensors, assets and zones, and a replay timeline |
| **Live Feeds** | Main feed with Visible / Thermal / Fusion modes, drag-to-pan PTZ, zoom, WASD virtual view for CAM-01/02, detections, stream info, snapshot and playback |
| **AI Insights** | Observations, cross-source correlation, confidence timeline, evidence, recommended review, source integrity |
| **Incidents** | Incident timeline with operator notes, acknowledge / assign / focus / severity / resolve / replay, checklist, linked sources, dispatch, response KPIs |

- **Ctrl/⌘ + K**: command palette (navigate, focus UGV-01/UAV-01, trigger or reset scenarios, toggle layers, inspect sensors)
- **Alt + 1–5**: switch screen · **Esc**: clear selection / leave fullscreen
- **Settings → Scenario control**: preset, severity, location, wind direction and speed, duration. **Settings → About BRIDGE** holds the disclosure.
- In the twin: drag to orbit, right-drag to pan, scroll to zoom, click to select, double-click to fly to an object.
- **W A S D** move across the site (speed follows zoom), **Q / E** lower / raise, **Shift** ×3. In Live Feeds the same keys move a labelled *virtual view* of CAM-01 / CAM-02 ("Return to mount" resets it). Keys are ignored while typing or when a menu or dialog is open.
- **Settings → Display → Frame new incidents** (on by default): a new incident is brought into the 3D view unless the camera was moved in the last 20 s.

### Fire response scenario

**Ctrl/⌘ + K → Trigger Fire Response** (or Settings → Scenario control → Fire response) plays a complete incident at a generator skid in the service yard, from detection to close-out:

1. **Detect**: CAM-02 analytics flag smoke; an incident opens with a six-phase response checklist (shown as a stepper on the twin's incident card).
2. **Protect**: the survey team withdraws upwind to assembly point AP-2.
3. **Deploy**: the robot dog (UGV-01) sprints to an upwind stand-off and confirms the flames on its camera; UAV-01 circles low for thermal overwatch; the DECON-1 shelter inflates.
4. **Suppress**: the robot knocks the fire down with a water-mist jet; the smoke turns to steam.
5. **Decon**: the robot walks through DECON-1 (dirty side in, clean side out) under the shower.
6. **Recover**: it recharges at its dock, personnel return, and the incident and scenario close themselves.

CAM-02 follows the response on its own while it runs ("Auto-track · incident"); the robot, UAV and fixed cameras report Fire, Smoke/Steam and Robot detections, and the thermal feeds show the fire and the cooling skid. The robot dog and the quadcopter are procedural three.js models (leg IK with a trot-to-bound gait, spinning props and a stabilised gimbal).

## Architecture

```
src/
  simulation/   seeded scenario engine (engine.ts), scenario scripts, effects (dose field, plume,
                aerosol), sensors, weather, asset kinematics, bounded 30-min history buffers
  store/        zustand: sim snapshot (≈1 Hz) and UI state (persisted preferences)
  three/        R3F scene: one shared full-window canvas rendering the main twin and every camera
                feed into DOM "holes" (scissor viewports); terrain, ocean, facility, assets,
                overlays, thermal material system, post shaders, picking, camera rig; robots/
                (procedural robot dog and quadcopter), props/ and FireLayer (fire, smoke, water
                jet, decontamination shelter)
  components/   design-system primitives, panels, charts, twin overlays/HUD, feeds, command palette,
                settings, boot screen
  features/     the five screens
  data/         site-layout.json, a single source of truth shared with the Blender build script
tools/
  blender/      build_facility.py (procedural campus → GLB modules), render_preview.py
  screenshots/  capture.mjs, functional-check.mjs, fire-check.mjs, scenario-check.mjs, ui-audit.mjs,
                perf-probe.mjs
public/models/  10 Draco-compressed GLB modules generated in Blender (≈0.7 MB total; units are
                GPU-instanced in the app)
public/draco/   Draco WebAssembly decoder, served locally (no CDN)
```

**One system, not widgets.** A scenario injects analytic *effects* (gamma field, Gaussian plume, aerosol cloud, thermal hotspot, fire, decontamination shelter, telemetry dropout). The same field functions drive sensor readings in the engine and the GPU overlays in the twin. Scripts then raise events, AI observations and incidents, and task the UGV/UAV. Vehicle motion is analytic and append-only, so any moment in the last 30 minutes can be replayed.

**Rendering.** A single WebGL context draws the main view (HDR, MSAA, ACES) and up to five feeds per frame. Feeds render at a throttled rate into their own targets. Thermal feeds swap every mesh to a heat material (per-material heat + sun loading + world-space hotspots) and apply an ironbow LUT with detail enhancement, noise and scanlines. Detection boxes are projected from scene objects. A dynamic-resolution governor keeps interaction fluid on integrated GPUs.

### Regenerating the 3D assets

```bash
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup --python tools/blender/build_facility.py
```

The script reads `src/data/site-layout.json` and writes Draco-compressed GLBs to `public/models/` and a source scene to `assets-src/encirra-facility.blend`.

---

BRIDGE for Barakah • Developed by [Awaiz Ahmed](https://kanbanstudios.ae/team-kanban)
