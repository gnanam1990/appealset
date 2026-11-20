// AppealSet console — role-aware operator surfaces over the local API.
// Auth: provisioned apsk_ bearer credential stored in localStorage.
// When the server runs APPEALSET_DEV_FIXTURES=1 a demo roster picker also
// appears and authenticates via the dev-only x-actor-id fixture.

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const statusEl = $('#status');

let me = null; // { id, alias, role, org_id, tenant_id }
let actors = [];
let credential = null; // provisioned bearer token (normal mode)
let devActorId = null; // dev-fixture identity shortcut (dev mode only)

function fmtMoney(minor, currency = 'USD') {
  if (minor === null || minor === undefined) return '—';
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

function fmtAge(iso) {
  const ms = Date.now() - Date.parse(iso);
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function badge(state) {
  const map = {
    concordant: 'ok', expert_decided: 'ok', exported: 'ok', paid: 'ok', delivered: 'ok',
    awaiting_expert: 'pending', reviewing: 'pending', slots_reserved: 'pending',
    pending: 'pending', offered: 'pending', accepted: 'pending', draft: 'pending',
    waiting_funds: 'warn', opened: 'warn', payable: 'warn',
    unresolved: 'bad', expired: 'bad', failed: 'bad', cancelled: 'bad',
  };
  return `<span class="badge ${map[state] ?? ''}">${esc(state)}</span>`;
}

function announce(msg, kind = 'ok') {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`;
  statusEl.hidden = false;
}

async function api(method, path, body, key) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      ...(devActorId && !credential ? { 'x-actor-id': devActorId } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data.detail ? ` — ${JSON.stringify(data.detail)}` : '';
    throw new Error(`${data.message ?? res.statusText}${d}`);
  }
  return data;
}

const get = (p) => api('GET', p);
const post = (p, b, k) => api('POST', p, b ?? {}, k);

// ---------- navigation ----------

const SURFACES = {
  steward: [
    ['disputes', 'Dispute queue'],
    ['setup', 'Setup'],
  ],
  reviewer: [['workbench', 'My work']],
  expert: [['expert', 'Expert queue']],
  qa: [
    ['patches', 'Patches'],
    ['evidence', 'Case evidence'],
  ],
  budget_owner: [
    ['funds', 'Funds'],
    ['reports', 'Reports'],
  ],
  admin: [['roster', 'Roster']],
};

let currentSurface = null;

function renderNav() {
  const list = $('#nav-list');
  const surfaces = SURFACES[me.role] ?? [];
  currentSurface = surfaces[0]?.[0];
  list.innerHTML = surfaces
    .map(([id, label]) => `<li><button data-surface="${id}">${esc(label)}</button></li>`)
    .join('');
  list.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      currentSurface = b.dataset.surface;
      list.querySelectorAll('button').forEach((x) => x.removeAttribute('aria-current'));
      b.setAttribute('aria-current', 'page');
      render();
    })
  );
  if (surfaces[0]) list.querySelector('button').setAttribute('aria-current', 'page');
  render();
}

// ---------- shared fragments ----------

function caseRow(c, actions = '') {
  return `<tr>
    <td class="mono">${esc(String(c.id).slice(0, 14))}…</td>
    <td>${badge(c.state)}${c.unresolved_reason ? `<div class="muted">${esc(c.unresolved_reason)}</div>` : ''}</td>
    <td>${esc(c.disputed_label)}</td>
    <td>v${c.policy_version}</td>
    <td>${fmtMoney(c.reserved_minor)} / ${c.budget_cap_minor === null ? 'no cap' : fmtMoney(c.budget_cap_minor)}</td>
    <td>${fmtAge(c.created_at)}</td>
    <td>${actions}</td>
  </tr>`;
}

function casesTable(cases, actions) {
  if (!cases.length) {
    return `<div class="empty">No disputes yet. Open one from Setup to begin the adjudication flow.</div>`;
  }
  return `<table><thead><tr>
      <th scope="col">Case</th><th scope="col">State</th><th scope="col">Disputed label</th>
      <th scope="col">Policy</th><th scope="col">Reserved / cap</th><th scope="col">Age</th><th scope="col"></th>
    </tr></thead><tbody>${cases.map((c) => caseRow(c, actions ? actions(c) : '')).join('')}</tbody></table>`;
}

// ---------- steward ----------

async function renderDisputes() {
  const cases = await get('/v1/cases');
  const reviewers = await get('/v1/reviewers');
  view.innerHTML = `
    <h1>Dispute queue</h1>
    <p class="muted">${cases.length} case(s). Frozen taxonomy revision, funds and age shown per case.</p>
    <div class="panel">
      ${casesTable(cases, (c) => `<button class="secondary" data-case="${c.id}">Open</button>`)}
    </div>
    <div id="case-detail"></div>`;
  view.querySelectorAll('[data-case]').forEach((b) =>
    b.addEventListener('click', () => renderCaseDetail(b.dataset.case, reviewers))
  );
}

async function renderCaseDetail(caseId, reviewers) {
  const c = await get(`/v1/cases/${caseId}`);
  const assignments = await get(`/v1/cases/${caseId}/assignments`);
  const reviewerOptions = reviewers
    .filter((r) => r.role === 'reviewer')
    .map((r) => `<option value="${r.id}">${esc(r.alias)} · ${esc(r.org_id)}</option>`)
    .join('');
  const expertOptions = reviewers
    .filter((r) => r.role === 'expert')
    .map((r) => `<option value="${r.id}">${esc(r.alias)} · ${esc(r.org_id)}</option>`)
    .join('');

  $('#case-detail').innerHTML = `
    <h2>Case ${esc(caseId.slice(0, 18))}…</h2>
    <div class="panel">
      <dl class="kv">
        <dt>State</dt><dd>${badge(c.state)}</dd>
        <dt>Item hash</dt><dd>${esc(c.item_hash)}</dd>
        <dt>Policy</dt><dd>${esc(c.policy_id)} v${c.policy_version}</dd>
        <dt>Taxonomy hash</dt><dd>${esc(c.taxonomy_hash)}</dd>
        <dt>Base version</dt><dd>${esc(c.base_version)}</dd>
        <dt>Budget</dt><dd>${fmtMoney(c.reserved_minor)} reserved of ${c.budget_cap_minor === null ? 'unauthorized' : fmtMoney(c.budget_cap_minor)}</dd>
      </dl>
      <h3>Assignments</h3>
      ${
        assignments.length
          ? `<table><thead><tr><th>Slot</th><th>Kind</th><th>Reviewer</th><th>State</th><th>Pay</th><th>Lease</th></tr></thead>
             <tbody>${assignments.map((a) => `<tr><td>${a.slot}</td><td>${esc(a.kind)}</td><td>${esc(a.reviewer_alias)}</td><td>${badge(a.state)}</td><td>${fmtMoney(a.price_minor, a.currency)}</td><td>${esc(a.lease_expires_at.slice(0, 16))}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted">No assignments yet.</p>'
      }
      <h3>Actions</h3>
      <form class="inline" id="assign-form">
        <div class="field"><label for="rev-a">Reviewer A</label><select id="rev-a">${reviewerOptions}</select></div>
        <div class="field"><label for="rev-b">Reviewer B</label><select id="rev-b">${reviewerOptions}</select></div>
        <button class="primary" type="submit">Offer blind slots</button>
      </form>
      <form class="inline" id="expert-form" style="margin-top:10px">
        <div class="field"><label for="exp-pick">Expert (optional)</label><select id="exp-pick"><option value="">auto-pick eligible</option>${expertOptions}</select></div>
        <button class="secondary" type="submit">Assign expert</button>
      </form>
      <form class="inline" id="tick-form" style="margin-top:10px">
        <button class="secondary" type="submit">Run worker tick</button>
      </form>
    </div>`;

  $('#assign-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const out = await post(`/v1/cases/${caseId}/assign`, {
        reviewer_ids: [$('#rev-a').value, $('#rev-b').value],
      });
      announce(`Offered ${out.length} blind slot(s).`);
      renderCaseDetail(caseId, reviewers);
    } catch (err) { announce(err.message, 'err'); }
  });
  $('#expert-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const out = await post(`/v1/cases/${caseId}/assign-expert`, {
        expert_id: $('#exp-pick').value || undefined,
      });
      announce(`Expert offer created: ${fmtMoney(out.price_minor, out.currency)}.`);
      renderCaseDetail(caseId, reviewers);
    } catch (err) { announce(err.message, 'err'); renderCaseDetail(caseId, reviewers); }
  });
  $('#tick-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = await post('/v1/worker/tick');
    announce(`Worker tick: ${out.outbox.processed} outbox row(s), ${out.expired} lease(s) expired.`);
    renderCaseDetail(caseId, reviewers);
  });
}

async function renderSetup() {
  const policies = await get('/v1/policies');
  const items = await get('/v1/items');
  view.innerHTML = `
    <h1>Setup</h1>
    <div class="panel">
      <h2>New policy</h2>
      <form class="inline" id="pol-form">
        <div class="field"><label for="pol-tax">Taxonomy labels (comma-separated)</label><input id="pol-tax" type="text" value="A,B,C" required></div>
        <div class="field"><label for="pol-guide">Guideline text</label><input id="pol-guide" type="text" value="Choose the label matching the dominant intent." required></div>
        <div class="field"><label for="pol-rev">Review price (cents)</label><input id="pol-rev" type="number" value="10" min="0" required></div>
        <div class="field"><label for="pol-exp">Expert price (cents)</label><input id="pol-exp" type="number" value="30" min="0" required></div>
        <div class="field"><label for="pol-orgsep">Org separation</label><select id="pol-orgsep"><option value="0">not required</option><option value="1">required</option></select></div>
        <button class="primary" type="submit">Freeze policy</button>
      </form>
      ${
        policies.length
          ? `<h3>Versions</h3><table><thead><tr><th>ID</th><th>Version</th><th>Labels</th><th>Prices</th></tr></thead><tbody>${policies
              .map((p) => `<tr><td class="mono">${esc(p.id.slice(0, 14))}…</td><td>v${p.version}</td><td>${esc(JSON.parse(p.taxonomy_json).join(', '))}</td><td>${p.review_price_minor}¢ / ${p.expert_price_minor}¢</td></tr>`)
              .join('')}</tbody></table>`
          : ''
      }
    </div>
    <div class="panel">
      <h2>New item</h2>
      <form class="inline" id="item-form">
        <div class="field"><label for="it-content">Content</label><input id="it-content" type="text" required></div>
        <div class="field"><label for="it-org">Producing org</label><input id="it-org" type="text" value="org-vendor" required></div>
        <div class="field"><label for="it-lang">Language</label><input id="it-lang" type="text" value="en" required></div>
        <div class="field"><label for="it-label">Original label</label><input id="it-label" type="text" value="A"></div>
        <div class="field"><label for="it-gold">Gold label (hidden)</label><input id="it-gold" type="text"></div>
        <div class="field"><label for="it-ver">Dataset version</label><input id="it-ver" type="text" value="v1" required></div>
        <button class="primary" type="submit">Register item</button>
      </form>
      ${
        items.length
          ? `<h3>Items</h3><table><thead><tr><th>ID</th><th>Lang</th><th>Version</th><th>Hash</th></tr></thead><tbody>${items
              .map((i) => `<tr><td class="mono">${esc(i.id.slice(0, 14))}…</td><td>${esc(i.language)}</td><td>${esc(i.dataset_version)}</td><td class="mono">${esc(i.content_hash.slice(0, 16))}…</td></tr>`)
              .join('')}</tbody></table>`
          : ''
      }
    </div>
    <div class="panel">
      <h2>Open dispute</h2>
      <form class="inline" id="case-form">
        <div class="field"><label for="c-item">Item</label><select id="c-item">${items.map((i) => `<option value="${i.id}">${esc(i.id.slice(0, 14))}… (${esc(i.dataset_version)})</option>`).join('')}</select></div>
        <div class="field"><label for="c-pol">Policy</label><select id="c-pol">${policies.map((p) => `<option value="${p.id}">v${p.version}</option>`).join('')}</select></div>
        <div class="field"><label for="c-label">Disputed label</label><input id="c-label" type="text" value="A" required></div>
        <div class="field"><label for="c-cap">Budget cap (cents)</label><input id="c-cap" type="number" value="50" min="0"></div>
        <button class="primary" type="submit">Open case</button>
      </form>
    </div>`;

  $('#pol-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await post('/v1/policies', {
        taxonomy: $('#pol-tax').value.split(',').map((s) => s.trim()).filter(Boolean),
        guideline_text: $('#pol-guide').value,
        review_price_minor: Number($('#pol-rev').value),
        expert_price_minor: Number($('#pol-exp').value),
        require_org_separation: $('#pol-orgsep').value === '1',
      });
      announce('Policy version frozen.');
      renderSetup();
    } catch (err) { announce(err.message, 'err'); }
  });
  $('#item-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await post('/v1/items', {
        content: $('#it-content').value,
        org_id: $('#it-org').value,
        language: $('#it-lang').value,
        original_label: $('#it-label').value || undefined,
        gold_label: $('#it-gold').value || undefined,
        dataset_version: $('#it-ver').value,
        consent_scope: 'adjudication-pilot',
        consent_expires_at: new Date(Date.now() + 365 * 864e5).toISOString(),
      });
      announce('Item registered.');
      renderSetup();
    } catch (err) { announce(err.message, 'err'); }
  });
  $('#case-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const out = await post('/v1/cases', {
        item_id: $('#c-item').value,
        policy_id: $('#c-pol').value,
        disputed_label: $('#c-label').value,
        budget_cap_minor: $('#c-cap').value === '' ? undefined : Number($('#c-cap').value),
      }, `console-${Date.now()}`);
      announce(out.deduplicated ? 'Case already existed for this item and policy.' : `Case ${out.case.id.slice(0, 14)}… opened.`);
    } catch (err) { announce(err.message, 'err'); }
  });
}

// ---------- reviewer ----------

async function renderWorkbench(assignmentId) {
  if (assignmentId) return renderTask(assignmentId);
  const mine = await get('/v1/me/assignments');
  view.innerHTML = `
    <h1>My work</h1>
    ${
      mine.length
        ? `<div class="panel"><table><thead><tr><th>Assignment</th><th>Kind</th><th>State</th><th>Pay</th><th>Due</th><th></th></tr></thead>
          <tbody>${mine.map((a) => `<tr>
            <td class="mono">${esc(a.id.slice(0, 14))}…</td><td>${esc(a.kind)}</td><td>${badge(a.state)}</td>
            <td>${fmtMoney(a.price_minor, a.currency)}</td><td>${esc(a.lease_expires_at.slice(0, 16))}</td>
            <td><button class="secondary" data-asg="${a.id}">Open</button></td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">No assignments. Blind review offers appear here when a steward assigns you a slot.</div>`
    }`;
  view.querySelectorAll('[data-asg]').forEach((b) =>
    b.addEventListener('click', () => renderTask(b.dataset.asg))
  );
}

async function renderTask(asgId) {
  let t;
  try {
    t = await get(`/v1/assignments/${asgId}/task`);
  } catch (err) {
    view.innerHTML = `<div class="empty">Assignment unavailable: ${esc(err.message)}</div>`;
    return;
  }
  const canSubmit = t.state === 'accepted';
  view.innerHTML = `
    <h1>${t.kind === 'expert' ? 'Expert adjudication' : 'Blind review'}</h1>
    <div class="panel">
      <dl class="kv">
        <dt>Assignment</dt><dd>${esc(t.assignment_id)}</dd>
        <dt>State</dt><dd>${badge(t.state)}${t.stale ? ' <span class="badge bad">stale</span>' : ''}</dd>
        <dt>Pay</dt><dd>${fmtMoney(t.pay.amount_minor, t.pay.currency)}</dd>
        <dt>Due</dt><dd>${esc(t.lease_expires_at)}</dd>
        <dt>Item hash</dt><dd>${esc(t.item.content_hash)}</dd>
        <dt>Dataset</dt><dd>${esc(t.item.dataset_version)} · ${esc(t.item.language)}</dd>
      </dl>
      <h3>Item under review</h3>
      <div class="rationale">${esc(t.item.content)}</div>
      <h3>Policy v${t.policy.version}</h3>
      <p>${esc(t.policy.guideline_text)}</p>
      <p class="muted">Labels: ${t.policy.taxonomy.map((l) => `<span class="badge">${esc(l)}</span>`).join(' ')}</p>
      ${t.expert_context ? `
        <h3>Blind rationales (anonymized)</h3>
        ${t.expert_context.blind_rationales.map((r) => `
          <div class="rationale"><span class="slot">Slot ${r.slot} · ${r.abstain ? 'abstained' : `label ${esc(r.label)}`}</span>
          <p>${esc(r.rationale)}</p></div>`).join('')}` : ''}
      ${t.state === 'offered' ? `<button class="primary" id="accept-btn">Accept offer (${fmtMoney(t.pay.amount_minor, t.pay.currency)})</button>` : ''}
    </div>
    <div class="panel">
      <h2>Opinion</h2>
      <form id="sub-form">
        <div class="field" style="margin-bottom:8px">
          <label for="sub-label">Label</label>
          <select id="sub-label">
            <option value="">— abstain —</option>
            ${t.policy.taxonomy.map((l) => `<option>${esc(l)}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="margin-bottom:8px">
          <label for="sub-rationale">Rationale</label>
          <textarea id="sub-rationale" required></textarea>
        </div>
        <button class="secondary" type="submit" data-kind="draft" ${canSubmit ? '' : 'disabled'}>Save draft</button>
        <button class="primary" type="submit" data-kind="final" ${canSubmit ? '' : 'disabled'}>Submit final opinion</button>
        ${t.final ? `<p class="muted">Final v${t.final.version} recorded: ${t.final.abstain ? 'abstain' : `label ${esc(t.final.label)}`}.</p>` : ''}
      </form>
    </div>`;

  const acceptBtn = $('#accept-btn');
  if (acceptBtn) acceptBtn.addEventListener('click', async () => {
    try {
      await post(`/v1/assignments/${asgId}/accept`);
      announce('Offer accepted.');
      renderTask(asgId);
    } catch (err) { announce(err.message, 'err'); }
  });

  $('#sub-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const kind = e.submitter.dataset.kind;
    const label = $('#sub-label').value;
    try {
      await post(`/v1/assignments/${asgId}/submission`, {
        kind,
        label: label || undefined,
        abstain: label === '',
        rationale: $('#sub-rationale').value,
      });
      announce(kind === 'final' ? 'Final opinion recorded.' : 'Draft saved.');
      renderTask(asgId);
    } catch (err) { announce(err.message, 'err'); }
  });
}

// ---------- expert queue ----------

async function renderExpert() {
  // The expert's queue = their own expert-kind assignments.
  const mine = await get('/v1/me/assignments');
  const expert = mine.filter((a) => a.kind === 'expert');
  view.innerHTML = `
    <h1>Expert queue</h1>
    ${
      expert.length
        ? `<div class="panel"><table><thead><tr><th>Assignment</th><th>Case</th><th>State</th><th>Pay</th><th></th></tr></thead>
          <tbody>${expert.map((a) => `<tr><td class="mono">${esc(a.id.slice(0, 14))}…</td><td class="mono">${esc(a.case_id.slice(0, 14))}…</td><td>${badge(a.state)}</td><td>${fmtMoney(a.price_minor, a.currency)}</td><td><button class="secondary" data-asg="${a.id}" data-case="${a.case_id}">Adjudicate</button></td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">No escalations. Conflicting blind reviews are routed here after both submissions close.</div>`
    }
    <div id="expert-detail"></div>`;
  view.querySelectorAll('[data-asg]').forEach((b) =>
    b.addEventListener('click', () => renderAdjudication(b.dataset.asg, b.dataset.case))
  );
}

async function renderAdjudication(asgId, caseId) {
  const t = await get(`/v1/assignments/${asgId}/task`);
  const el = $('#expert-detail');
  el.innerHTML = `
    <h2>Case ${esc(caseId.slice(0, 18))}…</h2>
    <div class="panel">
      <h3>Item</h3>
      <div class="rationale">${esc(t.item.content)}</div>
      <p class="muted">Policy v${t.policy.version}: ${esc(t.policy.guideline_text)}</p>
      ${t.expert_context ? t.expert_context.blind_rationales.map((r) => `
        <div class="rationale"><span class="slot">Slot ${r.slot} · ${r.abstain ? 'abstained' : `label ${esc(r.label)}`}</span>
        <p>${esc(r.rationale)}</p></div>`).join('') : '<p class="muted">Blind rationales unlock after both submissions close.</p>'}
      <h3>Ruling</h3>
      <form id="dec-form">
        <div class="field" style="margin-bottom:8px">
          <label for="dec-label">Accepted label</label>
          <select id="dec-label">
            <option value="">— abstain (leave unresolved) —</option>
            ${t.policy.taxonomy.map((l) => `<option>${esc(l)}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="margin-bottom:8px">
          <label for="dec-rationale">Rationale</label>
          <textarea id="dec-rationale" required></textarea>
        </div>
        <button class="primary" type="submit">Record ruling</button>
      </form>
    </div>`;
  $('#dec-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = $('#dec-label').value;
    try {
      const out = await post(`/v1/cases/${caseId}/decision`, {
        label: label || undefined,
        abstain: label === '',
        rationale: $('#dec-rationale').value,
      });
      announce(`Ruling recorded: ${out.state}.`);
      renderExpert();
    } catch (err) { announce(err.message, 'err'); }
  });
}

// ---------- QA ----------

async function renderPatches() {
  const patches = await get('/v1/patches');
  const cases = await get('/v1/cases');
  const decided = cases.filter((c) => ['concordant', 'expert_decided', 'unresolved', 'exported'].includes(c.state));
  view.innerHTML = `
    <h1>Patches</h1>
    <div class="panel">
      <h2>Build patch</h2>
      ${
        decided.length
          ? `<form id="patch-form"><table><thead><tr><th></th><th>Case</th><th>State</th><th>Decision</th></tr></thead><tbody>
            ${decided.map((c) => `<tr><td><input type="checkbox" name="cid" value="${c.id}"></td><td class="mono">${esc(c.id.slice(0, 14))}…</td><td>${badge(c.state)}</td><td>${esc(c.unresolved_reason ?? '')}</td></tr>`).join('')}
            </tbody></table>
            <p><button class="primary" type="submit">Build deterministic patch</button></p></form>`
          : '<p class="muted">No decided cases yet.</p>'
      }
    </div>
    <div class="panel">
      <h2>Versions</h2>
      ${
        patches.length
          ? `<table><thead><tr><th>Seq</th><th>Source</th><th>Entries</th><th>Excluded</th><th>Hash</th><th>State</th><th></th></tr></thead><tbody>
            ${patches.map((p) => `<tr>
              <td>${p.seq}</td><td>${esc(p.source_version)}</td><td>${p.diff.length}</td><td>${p.excluded.length}</td>
              <td class="mono">${esc(p.hash.slice(0, 16))}…</td><td>${badge(p.state)}</td>
              <td>
                ${p.state === 'draft' ? `<button class="secondary" data-approve="${p.id}">Approve</button>` : ''}
                ${p.state === 'approved' ? `<button class="primary" data-export="${p.id}">Export</button>` : ''}
              </td></tr>`).join('')}</tbody></table>`
          : '<div class="empty">No patches. QA-approved exports appear here and remain reproducible.</div>'
      }
      <div id="patch-detail"></div>
    </div>`;

  const form = $('#patch-form');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = [...form.querySelectorAll('input[name="cid"]:checked')].map((i) => i.value);
    try {
      const p = await post('/v1/patches', { case_ids: ids });
      announce(`Patch ${p.seq} built: ${p.diff.length} entr(ies), ${p.excluded.length} excluded. Hash ${p.hash.slice(0, 16)}…`);
      $('#patch-detail').innerHTML = `<pre class="mono">${esc(JSON.stringify({ diff: p.diff, excluded: p.excluded }, null, 2))}</pre>`;
      renderPatches();
    } catch (err) { announce(err.message, 'err'); }
  });
  view.querySelectorAll('[data-approve]').forEach((b) =>
    b.addEventListener('click', async () => {
      try { await post(`/v1/patches/${b.dataset.approve}/approve`); announce('Patch approved.'); renderPatches(); }
      catch (err) { announce(err.message, 'err'); }
    })
  );
  view.querySelectorAll('[data-export]').forEach((b) =>
    b.addEventListener('click', async () => {
      try { await post(`/v1/patches/${b.dataset.export}/export`); announce('Patch exported.'); renderPatches(); }
      catch (err) { announce(err.message, 'err'); }
    })
  );
}

async function renderEvidence() {
  const cases = await get('/v1/cases');
  view.innerHTML = `
    <h1>Case evidence</h1>
    <div class="panel">
      <form class="inline" id="bundle-form">
        <div class="field"><label for="ev-case">Case</label>
        <select id="ev-case">${cases.map((c) => `<option value="${c.id}">${esc(c.id.slice(0, 14))}… ${esc(c.state)}</option>`).join('')}</select></div>
        <button class="secondary" type="submit" data-op="bundle">Load bundle</button>
        <button class="secondary" type="submit" data-op="verify">Verify replay</button>
      </form>
      <div id="ev-out"></div>
    </div>`;
  $('#bundle-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#ev-case').value;
    try {
      const data = e.submitter.dataset.op === 'verify'
        ? await post(`/v1/cases/${id}/verify`)
        : await get(`/v1/cases/${id}/bundle`);
      $('#ev-out').innerHTML = `<pre class="mono">${esc(JSON.stringify(data, null, 2))}</pre>`;
    } catch (err) { announce(err.message, 'err'); }
  });
}

// ---------- budget owner ----------

async function renderFunds() {
  const cases = await get('/v1/cases');
  const ents = await get('/v1/entitlements');
  view.innerHTML = `
    <h1>Funds</h1>
    <div class="panel">
      <h2>Case budgets</h2>
      ${casesTable(cases, (c) => `<button class="secondary" data-cap="${c.id}">Set cap</button>`)}
      <div id="cap-form"></div>
    </div>
    <div class="panel">
      <h2>Entitlements</h2>
      ${
        ents.length
          ? `<table><thead><tr><th>ID</th><th>Amount</th><th>State</th><th>Provider</th><th></th></tr></thead><tbody>
            ${ents.map((e) => `<tr><td class="mono">${esc(e.id.slice(0, 14))}…</td><td>${fmtMoney(e.amount_minor, e.currency)}</td><td>${badge(e.state)}</td><td>${esc(e.provider ?? '—')}</td>
              <td>${e.state === 'payable' ? `<button class="secondary" data-dispatch="${e.id}">Dispatch</button>` : ''}
                  ${e.state === 'pending' ? `<button class="secondary" data-reconcile="${e.id}">Reconcile</button>` : ''}</td></tr>`).join('')}</tbody></table>
            <p class="muted">Provider LOCAL-LEDGER is a team-controlled recorder; it is not a live payment rail.</p>`
          : '<div class="empty">No entitlements. Delivered work records payable compensation here.</div>'
      }
    </div>`;

  view.querySelectorAll('[data-cap]').forEach((b) =>
    b.addEventListener('click', () => {
      $('#cap-form').innerHTML = `
        <form class="inline" id="cap-set">
          <div class="field"><label for="cap-val">New cap (cents) for ${esc(b.dataset.cap.slice(0, 14))}…</label>
          <input id="cap-val" type="number" min="0" required></div>
          <button class="primary" type="submit">Authorize</button>
        </form>`;
      $('#cap-set').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await post(`/v1/cases/${b.dataset.cap}/budget`, { cap_minor: Number($('#cap-val').value), currency: 'USD' });
          announce('Budget cap authorized.');
          renderFunds();
        } catch (err) { announce(err.message, 'err'); }
      });
    })
  );
  view.querySelectorAll('[data-dispatch]').forEach((b) =>
    b.addEventListener('click', async () => {
      try { const o = await post(`/v1/entitlements/${b.dataset.dispatch}/dispatch`); announce(`Dispatched → ${o.state} (${o.provider_ref})`); renderFunds(); }
      catch (err) { announce(err.message, 'err'); }
    })
  );
  view.querySelectorAll('[data-reconcile]').forEach((b) =>
    b.addEventListener('click', async () => {
      try { const o = await post(`/v1/entitlements/${b.dataset.reconcile}/reconcile`); announce(`Reconciled → ${o.state}`); renderFunds(); }
      catch (err) { announce(err.message, 'err'); }
    })
  );
}

async function renderReports() {
  const ov = await get('/v1/reports/overview');
  const cal = await get('/v1/reports/calibration');
  view.innerHTML = `
    <h1>Reports</h1>
    <div class="panel">
      <h2>Overview</h2>
      <pre class="mono">${esc(JSON.stringify(ov, null, 2))}</pre>
    </div>
    <div class="panel">
      <h2>Calibration</h2>
      ${
        cal.status === 'unavailable'
          ? `<div class="empty">Calibration unavailable: ${esc(cal.reason)}. ${esc(cal.detail)}</div>`
          : `<table><thead><tr><th>Reviewer</th><th>Language</th><th>Reviewed</th><th>Agreed</th><th>Rate</th></tr></thead><tbody>
            ${cal.cohorts.map((c) => `<tr><td>${esc(c.reviewer_alias)}</td><td>${esc(c.language)}</td><td>${c.reviewed}</td><td>${c.agreed}</td><td>${(c.agreement_rate * 100).toFixed(0)}%</td></tr>`).join('')}</tbody></table>`
      }
    </div>`;
}

// ---------- admin ----------

async function renderRoster() {
  const list = await get('/v1/credentials');
  view.innerHTML = `
    <h1>Roster</h1>
    <div class="panel"><table><thead><tr><th>Alias</th><th>Role</th><th>Credential</th><th>Status</th><th>Created</th></tr></thead><tbody>
    ${list.map((c) => `<tr><td>${esc(c.actor_alias)}</td><td>${esc(c.actor_role)}</td><td class="mono">${esc(c.id.slice(0, 14))}…</td><td>${c.revoked_at ? badge('bad') + ' revoked' : 'active'}</td><td>${esc(c.created_at.slice(0, 16))}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="panel"><button class="secondary" id="tick">Run worker tick</button></div>`;
  $('#tick').addEventListener('click', async () => {
    const out = await post('/v1/worker/tick');
    announce(`Tick: ${out.outbox.processed} outbox, ${out.expired} expired.`);
  });
}

// ---------- boot ----------

const RENDERERS = {
  disputes: renderDisputes,
  setup: renderSetup,
  workbench: renderWorkbench,
  expert: renderExpert,
  patches: renderPatches,
  evidence: renderEvidence,
  funds: renderFunds,
  reports: renderReports,
  roster: renderRoster,
};

async function render() {
  const fn = RENDERERS[currentSurface];
  if (!fn) {
    view.innerHTML = `<div class="empty">No work surface for role ${esc(me.role)}.</div>`;
    return;
  }
  try {
    await fn();
  } catch (err) {
    announce(err.message, 'err');
  }
}

function showSignedIn() {
  $('#signed-in').hidden = false;
  $('#signed-out').hidden = true;
  $('#session-name').textContent = `${me.alias} — ${me.role}`;
  $('#session-note').textContent = `${me.org_id} · ${me.tenant_id}`;
}

function showSignedOut(msg) {
  $('#signed-in').hidden = true;
  $('#signed-out').hidden = false;
  view.innerHTML = `<div class="empty">${esc(msg)}</div>`;
}

async function signIn() {
  try {
    me = await get('/v1/session');
    showSignedIn();
    renderNav();
  } catch (err) {
    announce(`Sign-in failed: ${err.message}`, 'err');
  }
}

function signOut() {
  credential = null;
  devActorId = null;
  me = null;
  try {
    localStorage.removeItem('appealset-cred');
    localStorage.removeItem('appealset-actor');
  } catch { /* private mode */ }
  $('#nav-list').innerHTML = '';
  showSignedOut('Signed out.');
}

async function boot() {
  $('#signin-btn').addEventListener('click', async () => {
    credential = $('#token-input').value.trim() || null;
    devActorId = null;
    await signIn();
    if (credential) {
      try { localStorage.setItem('appealset-cred', credential); } catch { /* private mode */ }
    }
  });
  $('#signout-btn').addEventListener('click', signOut);
  $('#token-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#signin-btn').click();
  });

  // Dev fixture: the actor picker exists only when the server runs with
  // APPEALSET_DEV_FIXTURES=1; selecting an entry uses the x-actor-id shortcut.
  let roster = null;
  try {
    const r = await fetch('/v1/session/actors');
    if (r.ok) roster = await r.json();
  } catch { /* server down */ }
  if (roster) {
    const sel = $('#actor-select');
    sel.hidden = false;
    sel.innerHTML =
      '<option value="">— demo roster —</option>' +
      roster.map((a) => `<option value="${a.id}">${esc(a.alias)} — ${esc(a.role)}</option>`).join('');
    sel.addEventListener('change', async () => {
      if (!sel.value) return;
      devActorId = sel.value;
      credential = null;
      try { localStorage.setItem('appealset-actor', devActorId); } catch { /* private mode */ }
      await signIn();
    });
  }

  // Restore a previous session.
  let savedCred = null;
  let savedActor = null;
  try {
    savedCred = localStorage.getItem('appealset-cred');
    savedActor = localStorage.getItem('appealset-actor');
  } catch { /* private mode */ }
  if (savedCred) {
    credential = savedCred;
    await signIn();
    return;
  }
  if (savedActor && roster && roster.some((a) => a.id === savedActor)) {
    devActorId = savedActor;
    $('#actor-select').value = savedActor;
    await signIn();
    return;
  }
  showSignedOut(
    'Sign in with a provisioned credential (apsk_…). ' +
      (roster
        ? 'This server runs with dev fixtures: pick a demo roster entry above instead.'
        : 'Ask your steward or admin for a credential.')
  );
}

boot();
