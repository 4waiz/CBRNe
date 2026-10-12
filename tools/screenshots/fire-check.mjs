// End-to-end QA of the Fire response scenario (about 3 minutes, real time). Runs the scenario,
// checks that the robot goes through every phase and the response checklist completes in order, that
// the incident closes itself, and that replay shows the same scene. Writes review images per phase.
//   node tools/screenshots/fire-check.mjs [outDir] [--url=http://localhost:5173/]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const outDir = resolve(args.find((a) => !a.startsWith('--')) ?? 'fire-check');
const base = (args.find((a) => a.startsWith('--url=')) ?? '--url=http://localhost:5173/').split('=')[1];
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${base}#/overview`, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  localStorage.setItem('encirra-ui-v1', JSON.stringify({ state: { settings: { quality: 'high', labels: true, reduceMotion: false, autoplay: false, palette: 'ironbow', autoFrame: false } }, version: 0 }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__ENCIRRA__?.sim.getState().ready, null, { timeout: 60000 });
await page.waitForTimeout(2500);

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

await page.evaluate(() => {
  const E = window.__ENCIRRA__;
  E.engine.cancelAutoplay?.();
  E.engine.trigger({ preset: 'fire', severity: 'moderate', locationId: 'YARD', windDir: 315, windSpeed: 12, duration: 0 });
});

const state = () =>
  page.evaluate(() => {
    const E = window.__ENCIRRA__;
    const t = Date.now();
    const seg = E.engine.ugv.current(t);
    const act = E.engine.ugv.activity(t);
    const p = E.engine.ugvPose(t);
    return { type: seg.type, purpose: seg.purpose ?? null, lt: (t - seg.t0) / 1000, spraying: !!act.spraying, washing: !!act.washing, x: p.x, z: p.z, run: !!E.sim.getState().run };
  });
const waitFor = async (label, pred, timeout = 150000) => {
  const start = Date.now();
  for (;;) {
    const s = await state();
    if (pred(s)) {
      check(`phase reached: ${label}`, true, stamp());
      return s;
    }
    if (Date.now() - start > timeout) {
      check(`phase reached: ${label}`, false, `timed out at ${JSON.stringify(s)}`);
      return null;
    }
    await page.waitForTimeout(250);
  }
};

const shoot = async (name, view, pose) => {
  await page.evaluate(
    ({ view }) => {
      const ui = window.__ENCIRRA__.ui.getState();
      if (view === 'overview' || view === 'twin') ui.setScreen(view);
      else {
        ui.setFeedMain(view === 'cam02' ? 'CAM-02' : view === 'ugv' ? 'UGV-01' : 'UAV-01');
        ui.setScreen('feeds');
      }
    },
    { view },
  );
  await page.waitForTimeout(1300);
  if (pose) {
    await page.waitForFunction(() => !!window.__ENCIRRA_CAMERA__, null, { timeout: 20000 });
    await page.evaluate((pose) => window.__ENCIRRA_CAMERA__.setCameraPose(pose[0], pose[1], false), pose);
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(outDir, `${name}-${view}.png`) });
};

const FIRE = [484, 228];
const near = (s, d) => Math.hypot(s.x - FIRE[0], s.z - FIRE[1]) < d;
const SPRAY_POSE = [[498, 14, 203], [478, 3.5, 225]];
const DECON_POSE = [[401, 3.2, 259], [420, 1.0, 256]];

await page.waitForTimeout(9000);
await shoot('01-smoke', 'cam02');
await waitFor('robot dispatched', (s) => s.type === 'route' && s.purpose === 'respond');
await shoot('02-column', 'twin', [[430, 34, 170], [490, 10, 236]]);
await waitFor('robot approaching the fire', (s) => s.type === 'route' && s.purpose === 'respond' && near(s, 45));
await shoot('03-approach', 'ugv');
await waitFor('suppressing', (s) => s.type === 'suppress' && s.spraying && s.lt > 2.5);
await shoot('04-spray', 'twin', SPRAY_POSE);
await shoot('04-spray', 'cam02');
await waitFor('steam after knock-down', (s) => s.type === 'suppress' && s.lt > 10);
await shoot('05-steam', 'twin', [[448, 26, 186], [486, 7, 232]]);
await waitFor('walking to DECON-1', (s) => s.type === 'route' && s.purpose === 'tent');
await waitFor('washing in DECON-1', (s) => s.type === 'decon' && s.washing && s.lt > 3);
await shoot('06-decon', 'twin', DECON_POSE);
await shoot('06-decon', 'cam02');
await waitFor('docked and recharging', (s) => s.type === 'charge');
await shoot('07-dock', 'overview');
await waitFor('scenario closed itself', (s) => !s.run, 60000);
await page.waitForTimeout(1500);
await shoot('08-complete', 'overview');

const close = await page.evaluate(() => {
  const st = window.__ENCIRRA__.sim.getState();
  const inc = st.incidents.find((i) => i.category === 'fire');
  const order = inc ? [...inc.checklist].filter((c) => c.done).sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0)).map((c) => c.id) : [];
  return { status: inc?.status ?? null, order, events: st.events.map((e) => e.title) };
});
check('fire incident resolved', close.status === 'resolved', String(close.status));
check('response checklist completed in order', close.order.join(',') === 'detect,protect,dispatch,suppress,decon,recover', close.order.join(' → '));
check('"Scenario complete" event', close.events.includes('Scenario complete'));

// replay: the spray and the wash come back exactly when scrubbing to them
const replay = await page.evaluate(() => {
  const E = window.__ENCIRRA__;
  const segs = E.engine.ugv.segments;
  const sup = [...segs].reverse().find((s) => s.type === 'suppress');
  const dec = [...segs].reverse().find((s) => s.type === 'decon');
  return { spray: sup ? sup.t0 + 5000 : null, wash: dec ? dec.t0 + 5000 : null };
});
for (const [name, cursor, pose, key] of [
  ['09-replay-spray', replay.spray, SPRAY_POSE, 'spraying'],
  ['10-replay-decon', replay.wash, DECON_POSE, 'washing'],
]) {
  if (!cursor) {
    check(`replay ${key}`, false, 'segment not found');
    continue;
  }
  await page.evaluate((cursor) => window.__ENCIRRA__.ui.getState().setPlayback({ mode: 'replay', cursor, playing: false }), cursor);
  await shoot(name, 'twin', pose);
  const ok = await page.evaluate(([cursor, key]) => !!window.__ENCIRRA__.engine.ugv.activity(cursor)[key], [cursor, key]);
  check(`replay shows the robot ${key}`, ok);
}
await page.evaluate(() => window.__ENCIRRA__.ui.getState().goLive());

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`\n${results.filter(Boolean).length}/${results.length} passed · images in ${outDir}`);
await browser.close();
