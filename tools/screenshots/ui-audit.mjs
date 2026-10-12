// UI layout audit: captures every screen, the settings drawer tabs and the command palette at common
// desktop sizes, and checks the live DOM for overlapping text, clipped text and content pushed outside
// the viewport. Screenshots land in <outDir>/<size>/, findings in <outDir>/report.json.
//
//   node tools/screenshots/ui-audit.mjs [outDir] [--url=http://localhost:5173/] [--sizes=1366x768,1600x900,1920x1080]
//                                       [--views=overview,twin] [--scenario=fire]
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const outDir = resolve(args.find((a) => !a.startsWith('--')) ?? 'ui-audit');
const base = (args.find((a) => a.startsWith('--url=')) ?? '--url=http://localhost:5173/').split('=')[1];
const sizes = (args.find((a) => a.startsWith('--sizes=')) ?? '--sizes=1366x768,1600x900,1920x1080')
  .split('=')[1]
  .split(',')
  .map((s) => s.split('x').map(Number));
const only = (args.find((a) => a.startsWith('--views=')) ?? '').split('=')[1]?.split(',').filter(Boolean);
// audit with a specific scenario running instead of the autoplay opening sequence
const scenario = (args.find((a) => a.startsWith('--scenario=')) ?? '').split('=')[1];

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  // headless mode hides scrollbars by default; real browsers draw them inside list panels and they take width
  ignoreDefaultArgs: ['--hide-scrollbars'],
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--force-color-profile=srgb'],
});
const context = await browser.newContext({ viewport: { width: sizes[0][0], height: sizes[0][1] }, deviceScaleFactor: 1, colorScheme: 'dark' });
const page = await context.newPage();
const logs = [];
page.on('console', (m) => m.type() === 'error' && logs.push(m.text()));
page.on('pageerror', (e) => logs.push(String(e)));

await page.goto(`${base}#/overview`, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
if (scenario) {
  await page.waitForFunction(() => window.__ENCIRRA__?.sim.getState().ready, null, { timeout: 60000 });
  await page.evaluate((preset) => {
    const E = window.__ENCIRRA__;
    E.engine.cancelAutoplay();
    E.engine.trigger({ ...E.ui.getState().scenarioDraft, preset, severity: 'moderate' });
  }, scenario);
}
// let the opening sequence produce an incident so every panel has content
await page.waitForFunction(
  () => window.__ENCIRRA__?.sim.getState().observations.some((o) => o.status === 'validation'),
  null,
  { timeout: 180000, polling: 1000 },
);
await page.evaluate(() => {
  window.__ENCIRRA__.ui.getState().setSettings({ autoplay: false });
  window.__ENCIRRA__.engine.cancelAutoplay();
});

const ui = (fn) => page.evaluate(fn);
const VIEWS = [
  ['overview', () => window.__ENCIRRA__.ui.getState().setScreen('overview')],
  ['twin', () => {
    const s = window.__ENCIRRA__.ui.getState();
    s.setScreen('twin');
    s.setTwinImmersive(false);
    s.select({ kind: 'sensor', id: 'RAD-S17' });
  }],
  ['twin-immersive', () => window.__ENCIRRA__.ui.getState().setTwinImmersive(true)],
  ['feeds', () => {
    const s = window.__ENCIRRA__.ui.getState();
    s.setTwinImmersive(false);
    s.select(null);
    s.setScreen('feeds');
  }],
  ['insights', () => {
    const s = window.__ENCIRRA__.ui.getState();
    const obs = window.__ENCIRRA__.sim.getState().observations[0];
    if (obs) s.selectObservation(obs.id);
    s.setScreen('insights');
  }],
  ['incidents', () => {
    const inc = window.__ENCIRRA__.sim.getState().incidents[0];
    const s = window.__ENCIRRA__.ui.getState();
    if (inc) s.selectIncident(inc.id);
    s.setScreen('incidents');
  }],
  ['settings-scenario', () => {
    const s = window.__ENCIRRA__.ui.getState();
    s.setScreen('overview');
    s.openSettings('scenario');
  }],
  ['settings-display', () => window.__ENCIRRA__.ui.getState().openSettings('display')],
  ['settings-about', () => window.__ENCIRRA__.ui.getState().openSettings('about')],
  ['palette', () => {
    const s = window.__ENCIRRA__.ui.getState();
    s.closeSettings();
    s.setPaletteOpen(true);
  }],
];

/** Runs in the page: returns layout findings for what is currently on screen. */
function audit() {
  const vw = innerWidth;
  const vh = innerHeight;
  const style = document.createElement('style');
  style.textContent = '*{pointer-events:auto !important}';
  document.head.appendChild(style);

  const alpha = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return 0;
    const p = m[1].split(/[ ,/]+/).filter(Boolean);
    return p.length > 3 ? Number(p[3]) : 1;
  };
  const shown = (el) => {
    for (let p = el; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false;
    }
    return true;
  };
  const name = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
  };
  // the visible window left by every box that clips the element's content (its own included)
  const clipRect = (el) => {
    let r = { left: 0, top: 0, right: vw, bottom: vh };
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const b = p.getBoundingClientRect();
        r = { left: Math.max(r.left, b.left), top: Math.max(r.top, b.top), right: Math.min(r.right, b.right), bottom: Math.min(r.bottom, b.bottom) };
      }
    }
    return r;
  };
  // hidden behind an unrelated opaque surface (a drawer or modal over the page)?
  const occluded = (el, x, y) => {
    const hit = document.elementFromPoint(x, y);
    if (!hit || el.contains(hit) || hit.contains(el)) return false;
    for (let p = hit; p && !p.contains(el); p = p.parentElement) {
      if (alpha(getComputedStyle(p).backgroundColor) > 0.85) return true;
    }
    return false;
  };

  const runs = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || el.closest('script,style,noscript') || !shown(el)) continue;
    const box = el.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) continue; // screen-reader-only text
    const range = document.createRange();
    range.selectNodeContents(n);
    const clip = clipRect(el);
    for (const r of range.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue;
      const vis = {
        left: Math.max(r.left, clip.left),
        top: Math.max(r.top, clip.top),
        right: Math.min(r.right, clip.right),
        bottom: Math.min(r.bottom, clip.bottom),
      };
      if (vis.right - vis.left < 2 || vis.bottom - vis.top < 2) continue;
      const cx = (vis.left + vis.right) / 2;
      const cy = (vis.top + vis.bottom) / 2;
      if (occluded(el, cx, cy)) continue;
      runs.push({ el, r: vis, full: r, text: n.nodeValue.trim().replace(/\s+/g, ' ').slice(0, 48) });
    }
  }

  const issues = [];
  // 1 — text drawn over other text
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i];
      const b = runs[j];
      if (a.el === b.el) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w < 2 || h < 3) continue;
      const area = w * h;
      const minArea = Math.min((a.r.right - a.r.left) * (a.r.bottom - a.r.top), (b.r.right - b.r.left) * (b.r.bottom - b.r.top));
      if (area < 0.12 * minArea) continue;
      // one of the two sits cleanly on an opaque surface above the other: stacking, not a collision
      const ox = (Math.max(a.r.left, b.r.left) + Math.min(a.r.right, b.r.right)) / 2;
      const oy = (Math.max(a.r.top, b.r.top) + Math.min(a.r.bottom, b.r.bottom)) / 2;
      if (occluded(a.el, ox, oy) || occluded(b.el, ox, oy)) continue;
      issues.push({ type: 'text-overlap', a: `${name(a.el)} "${a.text}"`, b: `${name(b.el)} "${b.text}"`, at: [Math.round(a.r.left), Math.round(a.r.top)] });
    }
  }
  // 2 — text cut off by its own box or pushed outside the viewport
  const seen = new Set();
  for (const run of runs) {
    const el = run.el;
    if (seen.has(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    const clipsX = cs.overflowX !== 'visible';
    if (clipsX && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 1) {
      const kind = cs.textOverflow === 'ellipsis' ? 'text-ellipsis' : 'text-clipped';
      issues.push({ type: kind, el: `${name(el)} "${run.text}"`, need: el.scrollWidth, have: el.clientWidth });
    }
    if (cs.overflowY !== 'visible' && cs.overflowY !== 'auto' && cs.overflowY !== 'scroll' && el.clientHeight > 1 && el.scrollHeight > el.clientHeight + 2 && !cs.webkitLineClamp?.match(/\d/)) {
      issues.push({ type: 'text-clipped-y', el: `${name(el)} "${run.text}"`, need: el.scrollHeight, have: el.clientHeight });
    }
    const f = run.full;
    if (f.right > vw + 1 || f.bottom > vh + 1 || f.left < -1 || f.top < -1) {
      const clip = clipRect(el);
      if (clip.right >= vw && clip.bottom >= vh) issues.push({ type: 'off-viewport', el: `${name(el)} "${run.text}"`, rect: [f.left, f.top, f.right, f.bottom].map(Math.round) });
    }
    if (parseFloat(cs.fontSize) < 10) issues.push({ type: 'tiny-text', el: `${name(el)} "${run.text}"`, size: cs.fontSize });
  }
  // 3 — panels that need scrolling to show their content
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (!(cs.overflowY === 'auto' || cs.overflowY === 'scroll') || !shown(el)) continue;
    if (el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 40) {
      issues.push({ type: 'scrolls', el: name(el), need: el.scrollHeight, have: el.clientHeight });
    }
  }
  // 4 — controls, chips and cards sticking out of the framed box (card, panel, button group) around them
  const framed = (cs) => {
    if (alpha(cs.backgroundColor) > 0.05 || cs.backgroundImage !== 'none') return true;
    return ['Top', 'Right', 'Bottom', 'Left'].some((s) => parseFloat(cs[`border${s}Width`]) > 0 && alpha(cs[`border${s}Color`]) > 0.05);
  };
  const flagged = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if ((el.closest('svg') && el.tagName.toLowerCase() !== 'svg') || el.closest('[aria-label="Map markers"]')) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'absolute' || cs.position === 'fixed' || cs.display === 'contents' || !framed(cs)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || !shown(el)) continue;
    let scrollsY = false;
    let anc = el.parentElement;
    for (; anc && anc !== document.body; anc = anc.parentElement) {
      const acs = getComputedStyle(anc);
      if (acs.overflowX !== 'visible' && acs.overflowX !== 'clip' && anc.scrollWidth > anc.clientWidth + 1) break; // a horizontal scroller
      if (acs.overflowY === 'auto' || acs.overflowY === 'scroll') scrollsY = true;
      if (framed(acs) && acs.display !== 'contents') break;
    }
    if (!anc || anc === document.body || flagged.has(anc)) continue;
    const acs = getComputedStyle(anc);
    const a = anc.getBoundingClientRect();
    const inner = {
      l: a.left + parseFloat(acs.borderLeftWidth),
      r: a.right - parseFloat(acs.borderRightWidth),
      t: a.top + parseFloat(acs.borderTopWidth),
      b: a.bottom - parseFloat(acs.borderBottomWidth),
    };
    const over = Math.max(inner.l - r.left, r.right - inner.r, scrollsY ? 0 : Math.max(inner.t - r.top, r.bottom - inner.b));
    if (over > 1.5) {
      flagged.add(anc);
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      issues.push({ type: 'box-overflow', el: `${name(el)} "${t}"`, in: name(anc), by: Math.round(over) });
    }
  }
  // 5 — rows whose children are wider than the row itself (they spill into padding or past borders)
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg, [aria-label="Map markers"]')) continue;
    const cs = getComputedStyle(el);
    if (!['flex', 'inline-flex', 'grid', 'inline-grid', 'block'].includes(cs.display) || cs.overflowX !== 'visible') continue;
    if (el.clientWidth < 2 || el.scrollWidth <= el.clientWidth + 1 || !shown(el)) continue;
    // only count overflow from children laid out in the row, not absolutely positioned decorations
    const base = el.getBoundingClientRect();
    const right = base.left + el.clientLeft + el.clientWidth;
    let spill = 0;
    for (const c of el.children) {
      const ccs = getComputedStyle(c);
      if (ccs.position === 'absolute' || ccs.position === 'fixed' || !shown(c)) continue;
      spill = Math.max(spill, c.getBoundingClientRect().right - right);
    }
    if (spill > 1.5) {
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50);
      issues.push({ type: 'row-overflow', el: `${name(el)} "${t}"`, by: Math.round(spill) });
    }
  }
  if (document.documentElement.scrollWidth > vw + 1) issues.push({ type: 'page-hscroll', need: document.documentElement.scrollWidth, have: vw });
  style.remove();
  return issues;
}

const report = {};
for (const [w, h] of sizes) {
  const tag = `${w}x${h}`;
  mkdirSync(resolve(outDir, tag), { recursive: true });
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(800);
  for (const [view, fn] of VIEWS) {
    if (only?.length && !only.includes(view)) continue;
    await ui(fn);
    await page.waitForTimeout(view.startsWith('settings') || view === 'palette' ? 900 : 2600);
    await page.screenshot({ path: resolve(outDir, tag, `${view}.png`) });
    const issues = await page.evaluate(audit);
    report[`${tag}/${view}`] = issues;
    const counts = issues.reduce((m, i) => ((m[i.type] = (m[i.type] ?? 0) + 1), m), {});
    console.log(tag.padEnd(10), view.padEnd(18), JSON.stringify(counts));
  }
  await ui(() => window.__ENCIRRA__.ui.getState().setPaletteOpen(false));
}
writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 1));
console.log(logs.length ? `console errors:\n${[...new Set(logs)].join('\n')}` : 'console: no errors');
await browser.close();
