#!/usr/bin/env node
/**
 * AppealSet browser check — drives the real console in a real Chromium over
 * the DevTools protocol (CDP). Zero npm dependencies; uses Node's built-in
 * WebSocket (>=22) and native .ts import stripping.
 *
 *   APPEALSET_BROWSER=/path/to/chrome node scripts/browser-check.mjs
 *
 * Env:
 *   APPEALSET_BROWSER    browser executable (default: autodetect Playwright
 *                        chromium headless shell, then system Chrome/Chromium)
 *   APPEALSET_EVIDENCE   evidence markdown path
 *                        (default build-progress/appealset/BROWSER-EVIDENCE.md)
 *   APPEALSET_KEEP_TMP=1 keep the disposable dir (.tmp/browser-check-*)
 *
 * Covers: authenticated sign-in per role in separate pages, the reviewer
 * workbench (pay disclosure, blindness, final submission), expert
 * adjudication of anonymized rationales, QA patch build/approve/export,
 * reload persistence, a 320px viewport + keyboard-driven flows, and
 * permission/error visibility. Writes a redacted evidence record
 * (no tokens).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../src/lib/db.ts';
import { migrate } from '../src/lib/migrations.ts';
import { startServer } from '../src/server.ts';
import { createActor, getActor } from '../src/domain/actors.ts';
import { mintCredential } from '../src/domain/auth.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const FUTURE = new Date(Date.now() + 365 * 86400e3).toISOString();
const evidence = [];
const fail = (msg) => {
  throw new Error(msg);
};
function step(name, detail = '') {
  evidence.push({ step: name, ok: true, detail });
  console.log(`  ok  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------- browser discovery ----------

function findBrowser() {
  if (process.env.APPEALSET_BROWSER) {
    if (!existsSync(process.env.APPEALSET_BROWSER)) fail(`APPEALSET_BROWSER not found: ${process.env.APPEALSET_BROWSER}`);
    return process.env.APPEALSET_BROWSER;
  }
  const candidates = [
    ...globSync(
      join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-*/chrome-headless-shell')
    ),
    ...globSync(join(homedir(), 'Library/Caches/ms-playwright/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium')),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) fail('no browser found; set APPEALSET_BROWSER=/path/to/chrome');
  return found;
}

// ---------- minimal CDP client over built-in WebSocket ----------
// One connection per page (per /devtools/page/* target); works in both
// normal and --single-process Chromium where Target.* is unavailable.

class CDP {
  #ws; #id = 0; #pending = new Map(); #events = new Map();
  static async connect(wsUrl) {
    const c = new CDP();
    c.#ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      c.#ws.onopen = res;
      c.#ws.onerror = () => rej(new Error(`websocket connect failed: ${wsUrl}`));
    });
    c.#ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id !== undefined && c.#pending.has(msg.id)) {
        const { res, rej } = c.#pending.get(msg.id);
        c.#pending.delete(msg.id);
        msg.error ? rej(new Error(`${msg.error.message} (${msg.error.code})`)) : res(msg.result);
      } else if (msg.method) {
        (c.#events.get(msg.method) ?? []).forEach((fn) => fn(msg.params));
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rej(new Error(`CDP timeout: ${method}`));
      }, 20000);
      this.#pending.set(id, {
        res: (v) => { clearTimeout(timer); res(v); },
        rej: (e) => { clearTimeout(timer); rej(e); },
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    this.#events.set(method, [...(this.#events.get(method) ?? []), fn]);
  }
  close() { this.#ws.close(); }
}

async function newPage(httpBase) {
  const res = await fetch(`${httpBase}/json/new?about:blank`, { method: 'PUT' });
  const target = await res.json();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { cdp, targetId: target.id };
}

function evalJs(page, expression) {
  return page.cdp
    .send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    .then((r) => {
      if (r.exceptionDetails) fail(`page eval failed: ${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)}`);
      return r.result?.value;
    });
}

async function waitFor(page, expression, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evalJs(page, `!!(${expression})`)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  fail(`timeout waiting for ${label}: ${expression}`);
}

async function navigate(page, url) {
  const loaded = new Promise((res) => page.cdp.on('Page.loadEventFired', res));
  await page.cdp.send('Page.navigate', { url });
  await Promise.race([loaded, new Promise((r) => setTimeout(r, 10000))]);
}

function key(page, type, k, code, vk, text) {
  return page.cdp.send('Input.dispatchKeyEvent', {
    type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
}
const tab = (p) => key(p, 'keyDown', 'Tab', 'Tab', 9);
const enter = async (p) => {
  await key(p, 'keyDown', 'Enter', 'Enter', 13, '\r');
  await key(p, 'keyUp', 'Enter', 'Enter', 13);
};
const space = async (p) => {
  await key(p, 'keyDown', ' ', 'Space', 32, ' ');
  await key(p, 'keyUp', ' ', 'Space', 32);
};

// ---------- app helpers ----------

async function signIn(page, token, alias) {
  await evalJs(page, `(() => {
    document.querySelector('#token-input').value = ${JSON.stringify(token)};
    document.querySelector('#signin-btn').click();
  })()`);
  await waitFor(
    page,
    `document.querySelector('#session-name') && document.querySelector('#session-name').textContent.includes(${JSON.stringify(alias)})`,
    'sign-in'
  );
  return evalJs(page, `document.querySelector('#session-name').textContent`);
}

// ---------- main ----------

const browser = findBrowser();
const tmp = join(ROOT, '.tmp', `browser-check-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const dbPath = join(tmp, 'appealset.db');
const db = openDb(dbPath);
migrate(db);

// Provision the roster directly in the disposable db (same shape as src/seed.ts).
const roster = {};
for (const [alias, spec] of Object.entries({
  steward: { org_id: 'org-appealset', role: 'steward' },
  budget: { org_id: 'org-appealset', role: 'budget_owner' },
  'reviewer-north': { org_id: 'org-north', role: 'reviewer', consent_status: 'opted_in', languages: ['en'], calibration_expires_at: FUTURE },
  'reviewer-south': { org_id: 'org-south', role: 'reviewer', consent_status: 'opted_in', languages: ['en'], calibration_expires_at: FUTURE },
  'expert-panel': { org_id: 'org-panel', role: 'expert', consent_status: 'opted_in', languages: ['en'], calibration_expires_at: FUTURE },
  qa: { org_id: 'org-appealset', role: 'qa' },
})) {
  const actor = createActor(db, { tenant_id: 'tenant-1', principal_id: `p-${alias}`, alias, ...spec });
  roster[alias] = { id: actor.id, token: mintCredential(db, getActor(db, actor.id), 'browser-check').token };
}
db.close();

const server = startServer({ dbPath, port: 0, devFixtures: false });
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const api = async (alias, method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${roster[alias].token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) fail(`API ${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
};

let proc;
const pages = [];
try {
  console.log(`browser: ${browser}`);
  console.log(`server:  ${base} (disposable db ${dbPath})`);

  // ---- case setup over the API (steward/budget_owner credentials) ----
  const pol = await api('steward', 'POST', '/v1/policies', {
    taxonomy: ['A', 'B', 'C'],
    guideline_text: 'Choose the label matching the dominant intent.',
    expert_on_disagreement: true,
    review_price_minor: 10,
    expert_price_minor: 30,
    currency: 'USD',
  });
  const item = await api('steward', 'POST', '/v1/items', {
    org_id: 'org-vendor', language: 'en', dataset_version: 'v1', original_label: 'A',
    content: 'The committee declined to table the motion.',
    consent_scope: 'adjudication-pilot', consent_expires_at: FUTURE,
  });
  const { case: kase } = await api('steward', 'POST', '/v1/cases', {
    item_id: item.id, policy_id: pol.id, disputed_label: 'A', budget_cap_minor: 50,
  });
  await api('steward', 'POST', `/v1/cases/${kase.id}/assign`, {
    reviewer_ids: [roster['reviewer-north'].id, roster['reviewer-south'].id],
  });
  step('case setup', `case ${kase.id.slice(0, 14)}… assigned to two independent reviewers`);

  // ---- launch browser ----
  proc = spawn(
    browser,
    [
      '--remote-debugging-port=0', `--user-data-dir=${join(tmp, 'profile')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
      // Disposable local profile; --single-process also lets the check run
      // inside agents' execution sandboxes that deny Chromium's launchd
      // rendezvous. Role sessions are separate pages in one profile; each
      // signs in with its own provisioned credential.
      '--no-sandbox', '--single-process',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) res(m[1]);
    });
    proc.on('exit', () => rej(new Error(`browser exited early:\n${buf.slice(-800)}`)));
    setTimeout(() => rej(new Error(`no DevTools ws URL:\n${buf.slice(-800)}`)), 15000);
  });
  const httpBase = `http://${new URL(wsUrl).host}`;

  const revA = await newPage(httpBase);
  const revB = await newPage(httpBase);
  const exp = await newPage(httpBase);
  const qa = await newPage(httpBase);
  pages.push(revA, revB, exp, qa);
  step('browser sessions', 'four pages: reviewer×2, expert, QA');

  // ---- permission/error visibility: bad credential shows a visible error ----
  await navigate(revA, base);
  await waitFor(revA, `!document.querySelector('#signed-out').hidden`, 'sign-in form');
  const rosterHidden = await evalJs(revA, `document.querySelector('#actor-select').hidden`);
  if (!rosterHidden) fail('dev roster picker visible in normal mode');
  await evalJs(revA, `(() => {
    document.querySelector('#token-input').value = 'apsk_invalid';
    document.querySelector('#signin-btn').click();
  })()`);
  await waitFor(revA, `!document.querySelector('#status').hidden`, 'sign-in error');
  const errText = await evalJs(revA, `document.querySelector('#status').textContent`);
  if (!errText.includes('Sign-in failed')) fail(`expected visible sign-in error, got "${errText}"`);
  step('error visibility', `invalid credential -> "${errText.trim()}" (live region, normal mode: no roster picker)`);

  // ---- reviewer A: desktop workbench ----
  await revA.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await signIn(revA, roster['reviewer-north'].token, 'reviewer-north');
  step('reviewer sign-in', 'bearer credential, "reviewer-north — reviewer"');
  await waitFor(revA, `document.querySelector('h1') && document.querySelector('h1').textContent.includes('My work') && document.querySelector('[data-asg]')`, 'assignment list');
  const denied = await api('reviewer-north', 'GET', '/v1/cases').then(
    () => 'unexpected 200',
    (e) => (e.message.includes('403') ? 403 : 'other')
  );
  if (denied !== 403) fail(`reviewer GET /v1/cases expected 403, got ${denied}`);
  step('role boundary', 'reviewer credential denied steward-scoped /v1/cases (403)');

  await evalJs(revA, `document.querySelector('[data-asg]').click()`);
  await waitFor(revA, `document.querySelector('#accept-btn')`, 'task view');
  const taskText = await evalJs(revA, `document.querySelector('#view').innerText`);
  for (const leak of ['Original label', 'org-vendor', 'reviewer-south']) {
    if (taskText.includes(leak)) fail(`blindness violation: task view contains "${leak}"`);
  }
  if (!taskText.includes('USD 0.10')) fail('pay not disclosed before acceptance');
  step('blind workbench', 'pay disclosed (USD 0.10); no original label, producer org or peer identity visible');

  await evalJs(revA, `document.querySelector('#accept-btn').click()`);
  await waitFor(revA, `document.querySelector('#sub-form button[data-kind="final"]:not([disabled])')`, 'accept offer');
  await evalJs(revA, `(() => {
    const s = document.querySelector('#sub-label'); s.value = 'A'; s.dispatchEvent(new Event('change'));
    document.querySelector('#sub-rationale').value = 'Dominant reading is refusal; label A.';
    document.querySelector('#sub-form button[data-kind="final"]').click();
  })()`);
  await waitFor(revA, `document.querySelector('#status').textContent.includes('Final opinion recorded')`, 'final submission');
  step('reviewer A opinion', 'final label A submitted through the workbench');

  // ---- reload persistence ----
  await navigate(revA, base);
  await waitFor(revA, `document.querySelector('#signed-in') && !document.querySelector('#signed-in').hidden`, 'session restore');
  const restored = await evalJs(revA, `document.querySelector('#session-name').textContent`);
  if (!restored.includes('reviewer-north')) fail(`session not restored: "${restored}"`);
  step('reload persistence', 'credential session restored after full page reload');

  // ---- reviewer B: keyboard-first at 320px ----
  await navigate(revB, base);
  await revB.cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
  await signIn(revB, roster['reviewer-south'].token, 'reviewer-south');
  await waitFor(revB, `document.querySelector('h1') && document.querySelector('h1').textContent.includes('My work') && document.querySelector('[data-asg]')`, 'assignment list (320px)');
  const overflow = await evalJs(revB, `document.documentElement.scrollWidth > document.documentElement.clientWidth`);
  if (overflow) fail('horizontal overflow at 320px');
  await evalJs(revB, `document.querySelector('[data-asg]').click()`);
  await waitFor(revB, `document.querySelector('#accept-btn')`, 'task view (320px)');
  await evalJs(revB, `document.querySelector('#accept-btn').click()`);
  await waitFor(revB, `document.querySelector('#sub-form button[data-kind="final"]:not([disabled])')`, 'accept offer (320px)');

  // Keyboard: focus the label select, Tab to rationale, type, Tab to submit.
  await evalJs(revB, `document.querySelector('#sub-label').focus()`);
  await evalJs(revB, `(() => {
    const s = document.querySelector('#sub-label'); s.value = 'B'; s.dispatchEvent(new Event('change'));
  })()`);
  await tab(revB);
  const focused1 = await evalJs(revB, `document.activeElement.id`);
  if (focused1 !== 'sub-rationale') fail(`Tab from label moved to "${focused1}", expected sub-rationale`);
  await evalJs(revB, `document.querySelector('#sub-rationale').value = 'Reading as postponement refusal; label B.'`);
  await tab(revB);
  await tab(revB);
  const focused2 = await evalJs(revB, `document.activeElement.dataset && document.activeElement.dataset.kind`);
  if (focused2 !== 'final') fail(`Tab did not reach final submit (active: ${focused2})`);
  await enter(revB);
  await waitFor(revB, `document.querySelector('#status').textContent.includes('Final opinion recorded')`, 'keyboard submit result');
  step('320px + keyboard', 'no horizontal overflow; Tab reaches controls; Enter submits final label B');

  // ---- routing tick + expert adjudication ----
  await api('steward', 'POST', '/v1/worker/tick');
  await api('steward', 'POST', `/v1/cases/${kase.id}/assign-expert`, {});
  await navigate(exp, base);
  await signIn(exp, roster['expert-panel'].token, 'expert-panel');
  await waitFor(exp, `document.querySelector('h1') && document.querySelector('h1').textContent.includes('Expert queue') && document.querySelector('button[data-case]')`, 'expert queue');
  await evalJs(exp, `document.querySelector('button[data-case]').click()`);
  await waitFor(exp, `document.querySelector('#dec-form')`, 'adjudication view');
  const adjText = await evalJs(exp, `document.querySelector('#expert-detail').innerText`);
  if (!adjText.includes('Slot 1') || !adjText.includes('Slot 2')) fail('expert view lacks anonymized slots');
  if (adjText.includes('reviewer-north') || adjText.includes('reviewer-south')) fail('expert view leaks reviewer identity');
  step('expert adjudication', 'two anonymized blind rationales (Slot 1/2), no reviewer identity');

  await evalJs(exp, `(() => {
    const s = document.querySelector('#dec-label'); s.value = 'B'; s.dispatchEvent(new Event('change'));
    document.querySelector('#dec-rationale').value = 'Slot 2 reasoning is stronger on dominant intent; ruling B.';
    document.querySelector('#dec-form button[type="submit"]').click();
  })()`);
  await waitFor(exp, `document.querySelector('#status').textContent.includes('Ruling recorded')`, 'ruling');
  step('expert ruling', 'accepted label B, case state expert_decided');

  // ---- QA: patch build by keyboard, then approve + export ----
  await navigate(qa, base);
  await signIn(qa, roster.qa.token, 'qa');
  await waitFor(qa, `document.querySelector('#patch-form input[name="cid"]')`, 'patch form');
  await evalJs(qa, `document.querySelector('#patch-form input[name="cid"]').focus()`);
  await space(qa);
  const checked = await evalJs(qa, `document.querySelector('#patch-form input[name="cid"]').checked`);
  if (!checked) fail('Space did not toggle the case checkbox');
  await tab(qa);
  await enter(qa);
  await waitFor(qa, `document.querySelector('#status').textContent.includes('Patch')`, 'patch build (keyboard)');
  const built = await evalJs(qa, `document.querySelector('#status').textContent`);
  step('QA patch build (keyboard)', `Space checks case, Enter builds -> "${built.trim()}"`);

  await waitFor(qa, `document.querySelector('[data-approve]')`, 'approve button');
  await evalJs(qa, `document.querySelector('[data-approve]').click()`);
  await waitFor(qa, `document.querySelector('[data-export]')`, 'export button');
  await evalJs(qa, `document.querySelector('[data-export]').click()`);
  await waitFor(qa, `document.querySelector('#status').textContent.includes('export')`, 'patch export');
  const patchRow = await evalJs(qa, `document.querySelector('#view').innerText`);
  if (!patchRow.includes('exported')) fail('patch not exported');
  step('QA approve + export', 'patch state exported; diff applies label B');

  // ---- entitlements summary (API confirmation) ----
  const costs = await api('steward', 'GET', `/v1/cases/${kase.id}/costs`);
  const payable = (costs.entitlements ?? []).filter((e) => e.state === 'payable');
  const total = payable.reduce((s, e) => s + e.amount_minor, 0);
  if (payable.length !== 3 || total !== 50) fail(`expected 3 payable entitlements / 50 minor, got ${payable.length}/${total}`);
  step('cost audit', `3 payable entitlements, total ${total} minor (cap 50)`);

  // ---- evidence record (redacted: aliases + outcomes only) ----
  const evPath = resolve(process.env.APPEALSET_EVIDENCE ?? join(ROOT, 'build-progress/appealset/BROWSER-EVIDENCE.md'));
  writeFileSync(
    evPath,
    [
      '# Browser evidence (redacted)',
      '',
      `Generated by \`scripts/browser-check.mjs\` on ${new Date().toISOString()}.`,
      `Browser: \`${browser}\`. Disposable db/profile; no credentials recorded.`,
      '',
      '| Step | Result |',
      '| --- | --- |',
      ...evidence.map((e) => `| ${e.step} | ${e.detail.replaceAll('|', '\\|') || 'ok'} |`),
      '',
    ].join('\n')
  );
  console.log(`\nAll ${evidence.length} checks passed. Evidence: ${evPath}`);
} finally {
  for (const p of pages) p.cdp.close();
  proc?.kill('SIGKILL');
  server.close();
  if (process.env.APPEALSET_KEEP_TMP !== '1') rmSync(tmp, { recursive: true, force: true });
}
