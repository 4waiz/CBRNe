// Scripted functional QA of the main interactions. Prints PASS/FAIL per check, then any failed
// requests and console errors/warnings.
//   node tools/screenshots/functional-check.mjs [outDir] [--url=http://localhost:5173/]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const outDir = resolve(args.find((a) => !a.startsWith('--')) ?? 'functional-check');
const base = (args.find((a) => a.startsWith('--url=')) ?? '--url=http://localhost:5173/').split('=')[1];
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
const warnings = [];
const failedRequests = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  if (m.type() === 'warning') warnings.push(m.text());
});
page.on('response', (r) => r.status() >= 400 && failedRequests.push(`${r.status()} ${r.url()}`));
page.on('requestfailed', (r) => failedRequests.push(`failed ${r.url()} (${r.failure()?.errorText})`));
const results = [];
// a check returns true to pass; false or a string (the observed state) fails
const check = async (name, fn) => {
  try {
    const ok = await fn();
    results.push(ok === true ? `PASS  ${name}` : `FAIL  ${name}${typeof ok === 'string' ? ` — observed: ${ok}` : ''}`);
  } catch (e) {
    results.push(`FAIL  ${name} — ${e.message.split('\n')[0]}`);
  }
};
const state = (fn, arg) => page.evaluate(fn, arg);
const ui = (fn) => state(fn);
const pose = () => state(() => window.__ENCIRRA_CAMERA__.getCameraPose());
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hold = async (key, ms) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
};

await page.goto(`${base}#/overview`, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__ENCIRRA__?.sim.getState().ready, null, { timeout: 30000 });
// the scripted checks drive scenarios themselves
await ui(() => {
  window.__ENCIRRA__.ui.getState().setSettings({ autoplay: false });
  window.__ENCIRRA__.engine.cancelAutoplay();
});
await page.waitForTimeout(4000);

await check('footer attribution link', async () => {
  const a = page.locator('footer a', { hasText: 'Awaiz Ahmed' });
  return (await a.getAttribute('href')) === 'https://kanbanstudios.ae/team-kanban' && (await a.getAttribute('target')) === '_blank' && (await a.getAttribute('rel')) === 'noreferrer';
});

await check('primary navigation (5 screens) + hash routing', async () => {
  const seen = [];
  for (const label of ['3D Twin', 'Live Feeds', 'AI Insights', 'Incidents', 'Overview']) {
    await page.getByRole('button', { name: label, exact: false }).first().click();
    await page.waitForTimeout(500);
    seen.push(await state(() => window.location.hash));
  }
  return seen.join(',') === '#/twin,#/feeds,#/insights,#/incidents,#/overview';
});

await check('command palette opens with Ctrl+K and focuses UGV-01', async () => {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('[aria-label="Command palette"]');
  await page.keyboard.type('Focus UGV');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const sel = await ui(() => window.__ENCIRRA__.ui.getState().selection);
  return sel?.kind === 'asset' && sel.id === 'UGV-01';
});

await check('scenario: Normal → Radiological (palette)', async () => {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('[aria-label="Command palette"]');
  await page.keyboard.type('Radiological Scenario');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  return (await ui(() => window.__ENCIRRA__.sim.getState().run?.preset)) === 'radiological';
});

await check('scenario: Radiological → Chemical plume', async () => {
  const before = await ui(() => window.__ENCIRRA__.sim.getState().run?.preset);
  await ui(() => window.__ENCIRRA__.engine.trigger({ preset: 'chemical', severity: 'moderate', locationId: 'SERVICE', windDir: 315, windSpeed: 12, duration: 0 }));
  await page.waitForTimeout(1200);
  const after = await ui(() => window.__ENCIRRA__.sim.getState().run?.preset);
  return (before === 'radiological' && after === 'chemical') || `before=${before} after=${after}`;
});

await check('settings drawer → About shows the disclosure', async () => {
  await page.locator('header button[aria-label="Settings"]').click();
  await page.getByRole('button', { name: 'About BRIDGE' }).click();
  const text = await page.locator('[role="dialog"][aria-label="Settings"]').innerText();
  await page.screenshot({ path: resolve(outDir, 'settings-about.png') });
  await page.keyboard.press('Escape');
  return text.includes('Conceptual situational-awareness environment using synthetic local data. No connection to operational Barakah systems.');
});

await check('scenario: Chemical → Normal (Scenario control reset)', async () => {
  await page.locator('header button[aria-label="Settings"]').click();
  await page.getByRole('button', { name: 'Scenario control' }).click();
  await page.screenshot({ path: resolve(outDir, 'settings-scenario.png') });
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Reset', exact: true }).click();
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  return (await ui(() => window.__ENCIRRA__.sim.getState().run)) === null;
});

await check('incident: trigger → acknowledge → assign UGV + UAV → resolve', async () => {
  await ui(() => window.__ENCIRRA__.engine.trigger({ preset: 'chemical', severity: 'moderate', locationId: 'SERVICE', windDir: 315, windSpeed: 12, duration: 0 }));
  await page.waitForFunction(() => window.__ENCIRRA__.sim.getState().incidents.some((i) => i.status === 'new'), null, { timeout: 30000 });
  await ui(() => window.__ENCIRRA__.ui.getState().setScreen('incidents'));
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Acknowledge', exact: true }).first().click();
  for (const asset of [/UGV-01/, /UAV-01/]) {
    await page.getByRole('button', { name: /Assign asset/ }).click();
    const item = page.getByRole('menuitem', { name: asset });
    if (await item.isDisabled()) await page.keyboard.press('Escape');
    else await item.click();
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: resolve(outDir, 'incident-flow.png') });
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm resolve' }).click();
  await page.waitForTimeout(800);
  const inc = await ui(() => window.__ENCIRRA__.sim.getState().incidents[0]);
  return inc.status === 'resolved' && inc.assigned.includes('UGV-01') && inc.assigned.includes('UAV-01') && !!inc.acknowledgedAt;
});

await check('replay: timeline scrub enters replay mode and Live returns', async () => {
  await ui(() => window.__ENCIRRA__.ui.getState().setScreen('twin'));
  await page.waitForTimeout(800);
  const slider = page.getByRole('slider', { name: 'Timeline scrubber' });
  const box = await slider.boundingBox();
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2);
  await page.waitForTimeout(600);
  const mode1 = await ui(() => window.__ENCIRRA__.ui.getState().playback.mode);
  await page.screenshot({ path: resolve(outDir, 'replay.png') });
  await page.getByRole('button', { name: 'Live', exact: true }).first().click();
  const mode2 = await ui(() => window.__ENCIRRA__.ui.getState().playback.mode);
  return mode1 === 'replay' && mode2 === 'live';
});

await check('3D picking: click the twin selects a zone or asset', async () => {
  await ui(() => window.__ENCIRRA_CAMERA__.setCameraPose([-1080, 560, -1230], [30, 0, -40], false));
  await page.waitForTimeout(1200);
  const vp = page.locator('[role="application"]');
  const b = await vp.boundingBox();
  await page.mouse.click(b.x + b.width * 0.52, b.y + b.height * 0.5);
  await page.waitForTimeout(500);
  return !!(await ui(() => window.__ENCIRRA__.ui.getState().selection));
});

await check('select sensor → inspector detail → Focus moves the camera to it', async () => {
  await ui(() => window.__ENCIRRA__.ui.getState().select({ kind: 'sensor', id: 'RAD-S17' }));
  await page.waitForTimeout(600);
  const inspector = await page.getByRole('complementary', { name: 'Inspector' }).innerText();
  await page.getByRole('complementary', { name: 'Inspector' }).getByRole('button', { name: 'Focus', exact: true }).click();
  await page.waitForTimeout(2500);
  const p = await pose();
  const s = await ui(() => {
    const st = window.__ENCIRRA__.sim.getState();
    return st.sensors['RAD-S17'];
  });
  return inspector.includes('RAD-S17') && !!s && p && dist(p.target, [184, 4, -126]) < 5;
});

await check('select UGV-01 and UAV-01 → inspector + follow', async () => {
  await ui(() => window.__ENCIRRA__.ui.getState().select({ kind: 'asset', id: 'UAV-01' }));
  await page.waitForTimeout(400);
  const t1 = await page.getByRole('complementary', { name: 'Inspector' }).innerText();
  await ui(() => window.__ENCIRRA__.ui.getState().select({ kind: 'asset', id: 'UGV-01' }));
  await page.waitForTimeout(400);
  const t2 = await page.getByRole('complementary', { name: 'Inspector' }).innerText();
  await ui(() => window.__ENCIRRA_CAMERA__.focusOn({ kind: 'asset', id: 'UGV-01' }));
  await page.waitForTimeout(400);
  const follow = await ui(() => window.__ENCIRRA__.ui.getState().follow);
  return t1.includes('UAV-01') && t2.includes('UGV-01') && follow === 'UGV-01';
});

await check('layer toggles: Weather on/off from the Overview twin panel', async () => {
  await ui(() => window.__ENCIRRA__.ui.getState().setScreen('overview'));
  await page.waitForTimeout(600);
  const btn = page.getByRole('group', { name: '3D layers' }).first().getByRole('button', { name: 'Weather', exact: true });
  const before = await ui(() => window.__ENCIRRA__.ui.getState().layers.weather);
  await btn.click();
  const mid = await ui(() => window.__ENCIRRA__.ui.getState().layers.weather);
  await page.screenshot({ path: resolve(outDir, 'overview-weather-layer.png') });
  await btn.click();
  const after = await ui(() => window.__ENCIRRA__.ui.getState().layers.weather);
  await ui(() => window.__ENCIRRA__.ui.getState().setScreen('twin'));
  await page.waitForTimeout(600);
  return mid === !before && after === before;
});

await check('WASD: holding W moves the twin camera forward', async () => {
  await ui(() => {
    window.__ENCIRRA__.ui.getState().select(null);
    window.__ENCIRRA_CAMERA__.setCameraPose([-600, 420, -700], [30, 0, -40], false);
    document.activeElement?.blur?.();
  });
  await page.waitForTimeout(600);
  const p0 = await pose();
  await hold('w', 1000);
  await page.waitForTimeout(200);
  const p1 = await pose();
  // moves along the ground-projected view direction: target x/z change, height unchanged
  return dist(p0.target, p1.target) > 50 && Math.abs(p0.target[1] - p1.target[1]) < 1;
});

await check('WASD: Q/E change height, A/D strafe', async () => {
  const p0 = await pose();
  await hold('e', 600);
  const p1 = await pose();
  await hold('d', 600);
  const p2 = await pose();
  return p1.pos[1] > p0.pos[1] + 5 && dist(p1.target, p2.target) > 20;
});

await check('WASD is ignored while typing in the command palette', async () => {
  const p0 = await pose();
  await page.keyboard.press('Control+k');
  await page.waitForSelector('[aria-label="Command palette"]');
  await page.keyboard.type('wasd wasd');
  await page.waitForTimeout(500);
  const p1 = await pose();
  await page.keyboard.press('Escape');
  return dist(p0.target, p1.target) < 0.5 && dist(p0.pos, p1.pos) < 0.5;
});

await check('live feeds: switch source + thermal on/off + snapshot', async () => {
  await ui(() => window.__ENCIRRA__.ui.getState().setScreen('feeds'));
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /CAM-02/ }).first().click();
  await page.getByRole('radio', { name: 'Thermal' }).first().click();
  await page.waitForTimeout(1200);
  const mode = await ui(() => window.__ENCIRRA__.ui.getState().feedModes['CAM-02']);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.getByRole('button', { name: 'Snapshot' }).click()]);
  await page.screenshot({ path: resolve(outDir, 'feeds-cam02-thermal.png') });
  await page.getByRole('radio', { name: 'Visible' }).first().click();
  const mode2 = await ui(() => window.__ENCIRRA__.ui.getState().feedModes['CAM-02']);
  return mode === 'thermal' && mode2 === 'visible' && !!download;
});

await check('WASD: CAM-02 virtual view moves (focus still on the mode radio), is labelled, returns to mount', async () => {
  // the previous check left keyboard focus on the "Visible" radio: letter keys must still move the view
  const focusedRole = await ui(() => document.activeElement?.getAttribute('role'));
  await hold('w', 1200);
  await page.waitForTimeout(400);
  const moved = await ui(() => window.__ENCIRRA__.ui.getState().feedMoved['CAM-02']);
  const label = await page.getByText(/Virtual view · \d+ m from mount/).count();
  await page.screenshot({ path: resolve(outDir, 'feeds-cam02-moved.png') });
  await page.getByRole('button', { name: 'Return to mount' }).click();
  await page.waitForTimeout(300);
  const back = await ui(() => window.__ENCIRRA__.ui.getState().feedMoved['CAM-02']);
  return (moved > 5 && label > 0 && back === 0) || `focus=${focusedRole} moved=${moved} label=${label} back=${back}`;
});

await check('wind change rotates the dispersion direction', async () => {
  await ui(() => window.__ENCIRRA__.engine.setWind(200, 18));
  await page.waitForTimeout(3000);
  const w = await ui(() => window.__ENCIRRA__.sim.getState().weather.windDir);
  return Math.abs(w - 200) < 15;
});

await check('auto-frame: a new incident is brought into view when the camera is idle', async () => {
  await ui(() => {
    const s = window.__ENCIRRA__.ui.getState();
    s.setScreen('overview');
    s.setFollow(null);
    window.__ENCIRRA_CAMERA__.setCameraPose([-970, 505, -1110], [30, 0, -40], false);
  });
  await page.waitForTimeout(21000); // idle window
  await ui(() => window.__ENCIRRA__.engine.trigger({ preset: 'radiological', severity: 'moderate', locationId: 'U3-EAST', windDir: 315, windSpeed: 12, duration: 0 }));
  await page.waitForFunction(() => window.__ENCIRRA__.sim.getState().incidents.some((i) => i.status === 'new'), null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  const p = await pose();
  const inc = await ui(() => window.__ENCIRRA__.sim.getState().incidents.find((i) => i.status === 'new'));
  await page.screenshot({ path: resolve(outDir, 'overview-autoframe.png') });
  return dist(p.target, [inc.location.x, 6, inc.location.z]) < 30;
});

await check('incident log: operator note is appended to the timeline', async () => {
  await ui(() => {
    const st = window.__ENCIRRA__.sim.getState();
    const inc = st.incidents.find((i) => i.status !== 'resolved');
    window.__ENCIRRA__.ui.getState().selectIncident(inc.id);
    window.__ENCIRRA__.ui.getState().setScreen('incidents');
  });
  await page.waitForTimeout(800);
  const input = page.getByRole('textbox', { name: 'Operator note' });
  await input.fill('Perimeter walk-down complete; no access issues observed.');
  await input.press('Enter');
  await page.waitForTimeout(600);
  const tl = await ui(() => {
    const st = window.__ENCIRRA__.sim.getState();
    return st.incidents.find((i) => i.status !== 'resolved').timeline.map((e) => e.detail ?? '');
  });
  await page.screenshot({ path: resolve(outDir, 'incident-note.png') });
  return tl.some((d) => d.startsWith('Perimeter walk-down complete')) && (await input.inputValue()) === '';
});

await check('refresh: persisted UI state (layers, filter, palette) survives reload', async () => {
  await ui(() => {
    const s = window.__ENCIRRA__.ui.getState();
    s.setLayer('zones', true);
    s.setEventFilter('rad');
    s.setSettings({ palette: 'whitehot' });
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__ENCIRRA__?.sim.getState().ready, null, { timeout: 30000 });
  const s = await ui(() => {
    const u = window.__ENCIRRA__.ui.getState();
    return { zones: u.layers.zones, filter: u.eventFilter, palette: u.settings.palette, autoFrame: u.settings.autoFrame, screen: u.screen };
  });
  await ui(() => {
    const u = window.__ENCIRRA__.ui.getState();
    u.setLayer('zones', false);
    u.setEventFilter('all');
    u.setSettings({ palette: 'ironbow' });
  });
  return s.zones === true && s.filter === 'rad' && s.palette === 'whitehot' && s.autoFrame === true && s.screen === 'incidents';
});

await check('resize: 1366×768 and 1920×1080 have no page overflow', async () => {
  const sizes = [
    [1366, 768],
    [1920, 1080],
    [1600, 900],
  ];
  const out = [];
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    for (const screen of ['overview', 'twin', 'feeds', 'insights', 'incidents']) {
      await ui(() => {});
      await state((sc) => window.__ENCIRRA__.ui.getState().setScreen(sc), screen);
      await page.waitForTimeout(350);
      const o = await state(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, w: window.innerWidth, h: window.innerHeight }));
      if (o.sw > o.w || o.sh > o.h) out.push(`${w}×${h} ${screen}: ${o.sw}×${o.sh}`);
    }
    if (w === 1366) await page.screenshot({ path: resolve(outDir, 'incidents-1366.png') });
  }
  return out.length === 0 || out.join('; ');
});

console.log(results.join('\n'));
console.log(failedRequests.length ? `\nfailed requests:\n${failedRequests.join('\n')}` : '\nno failed requests');
console.log(errors.length ? `\nconsole/page errors:\n${errors.join('\n')}` : 'no console errors');
console.log(warnings.length ? `\nconsole warnings:\n${[...new Set(warnings)].join('\n')}` : 'no console warnings');
await browser.close();
