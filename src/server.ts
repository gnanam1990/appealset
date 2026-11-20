import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './lib/db.ts';
import { openDb } from './lib/db.ts';
import { migrate } from './lib/migrations.ts';
import { DomainError, badRequest, notFound } from './lib/errors.ts';
import { hashObject, nowIso } from './lib/hash.ts';
import { requireActor, requireRole, createActor, listReviewers } from './domain/actors.ts';
import {
  createPolicy, listPolicies, createItem, listItems, updateItemContent,
  createCase, listCases, getCase, presentCase, setCaseBudget,
} from './domain/intake.ts';
import {
  assignReviewers, assignExpert, acceptAssignment, caseAssignments, actorAssignments,
} from './domain/assignments.ts';
import { taskView, submit } from './domain/submissions.ts';
import { recordExpertDecision } from './domain/routing.ts';
import { buildPatch, approvePatch, exportPatch, listPatches, getPatch } from './domain/patches.ts';
import {
  caseCosts, overviewReport, calibrationReport, dispatchPayout, reconcilePayout,
  listEntitlements, caseBundle, verifyReplay,
} from './domain/reports.ts';
import { runWorkerTick } from './worker.ts';
import { LocalLedgerAdapter, type PaymentAdapter } from './payments/local-ledger.ts';
import type { Actor, Role } from './domain/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = join(__dirname, 'console');

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Ctx {
  db: Db;
  req: IncomingMessage;
  actor: Actor;
  params: Record<string, string>;
  body: Record<string, unknown>;
  adapter: PaymentAdapter;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  roles: Role[] | null;
  handler: Handler;
}

function route(method: string, path: string, roles: Role[] | null, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:[^/]+/g, (m) => (keys.push(m.slice(1)), '([^/]+)')) + '$'
  );
  return { method, pattern, keys, roles, handler };
}

const routes: Route[] = [
  route('GET', '/v1/health', null, () => ({ ok: true, service: 'appealset', time: nowIso() })),

  // Local demo only: lets the console offer an actor picker. A real deployment
  // replaces x-actor-id auth with SSO and drops this endpoint.
  route('GET', '/v1/session/actors', null, (c) =>
    (c.db
      .prepare('SELECT id, tenant_id, alias, role, org_id FROM actors ORDER BY role, alias')
      .all() as Record<string, unknown>[]).map((a) => ({
        id: a.id, tenant_id: a.tenant_id, alias: a.alias, role: a.role, org_id: a.org_id,
      }))),

  route('POST', '/v1/actors', ['admin'], (c) => createActor(c.db, c.body as never)),
  route('GET', '/v1/reviewers', ['admin', 'steward', 'qa', 'budget_owner'], (c) =>
    listReviewers(c.db, c.actor.tenant_id)),

  route('POST', '/v1/policies', ['steward'], (c) => createPolicy(c.db, c.actor, c.body as never)),
  route('GET', '/v1/policies', null, (c) => listPolicies(c.db, c.actor.tenant_id)),

  route('POST', '/v1/items', ['steward'], (c) => createItem(c.db, c.actor, c.body as never)),
  route('GET', '/v1/items', ['admin', 'steward', 'qa', 'budget_owner'], (c) =>
    listItems(c.db, c.actor.tenant_id)),
  route('PATCH', '/v1/items/:id/content', ['steward'], (c) =>
    updateItemContent(c.db, c.actor, c.params.id, String(c.body.content ?? ''))),

  route('POST', '/v1/cases', ['steward'], (c) => createCase(c.db, c.actor, c.body as never)),
  route('GET', '/v1/cases', ['admin', 'steward', 'qa', 'budget_owner', 'expert'], (c) =>
    listCases(c.db, c.actor.tenant_id)),
  route('GET', '/v1/cases/:id', ['admin', 'steward', 'qa', 'budget_owner'], (c) =>
    presentCase(getCase(c.db, c.actor.tenant_id, c.params.id))),
  route('POST', '/v1/cases/:id/budget', ['budget_owner'], (c) =>
    setCaseBudget(c.db, c.actor, c.params.id, c.body.cap_minor as number, c.body.currency as string)),
  route('POST', '/v1/cases/:id/assign', ['steward'], (c) =>
    assignReviewers(c.db, c.actor, c.params.id, c.body.reviewer_ids as string[], c.body.lease_ms as number | undefined)),
  route('POST', '/v1/cases/:id/assign-expert', ['steward'], (c) =>
    assignExpert(c.db, c.actor, c.params.id, (c.body.expert_id as string) ?? null, c.body.lease_ms as number | undefined)),
  route('POST', '/v1/cases/:id/decision', ['expert', 'qa', 'steward'], (c) =>
    recordExpertDecision(c.db, c.actor, c.params.id, c.body as never)),
  route('GET', '/v1/cases/:id/costs', ['budget_owner', 'steward', 'qa'], (c) =>
    caseCosts(c.db, c.actor, c.params.id)),
  route('GET', '/v1/cases/:id/bundle', ['steward', 'qa', 'budget_owner'], (c) =>
    caseBundle(c.db, c.actor, c.params.id)),
  route('POST', '/v1/cases/:id/verify', ['steward', 'qa'], (c) =>
    verifyReplay(c.db, c.actor, c.params.id)),
  route('GET', '/v1/cases/:id/assignments', ['admin', 'steward', 'qa', 'budget_owner'], (c) =>
    caseAssignments(c.db, c.actor.tenant_id, c.params.id)),

  route('GET', '/v1/me/assignments', ['reviewer', 'expert'], (c) => actorAssignments(c.db, c.actor)),
  route('GET', '/v1/assignments/:id/task', ['reviewer', 'expert'], (c) =>
    taskView(c.db, c.actor, c.params.id)),
  route('POST', '/v1/assignments/:id/accept', ['reviewer', 'expert'], (c) =>
    acceptAssignment(c.db, c.actor, c.params.id)),
  route('POST', '/v1/assignments/:id/submission', ['reviewer', 'expert'], (c) =>
    submit(c.db, c.actor, c.params.id, c.body as never)),

  route('POST', '/v1/patches', ['qa'], (c) =>
    buildPatch(c.db, c.actor, c.body.case_ids as string[], c.body.supersedes_id as string | undefined)),
  route('GET', '/v1/patches', ['qa', 'steward'], (c) => listPatches(c.db, c.actor.tenant_id)),
  route('GET', '/v1/patches/:id', ['qa', 'steward'], (c) => getPatch(c.db, c.actor.tenant_id, c.params.id)),
  route('POST', '/v1/patches/:id/approve', ['qa'], (c) => approvePatch(c.db, c.actor, c.params.id)),
  route('POST', '/v1/patches/:id/export', ['qa'], (c) => exportPatch(c.db, c.actor, c.params.id)),

  route('GET', '/v1/reports/overview', ['admin', 'steward', 'qa', 'budget_owner'], (c) =>
    overviewReport(c.db, c.actor)),
  route('GET', '/v1/reports/calibration', ['admin', 'steward', 'qa', 'budget_owner'], (c) =>
    calibrationReport(c.db, c.actor)),
  route('GET', '/v1/entitlements', ['budget_owner', 'steward'], (c) =>
    listEntitlements(c.db, c.actor)),
  route('POST', '/v1/entitlements/:id/dispatch', ['budget_owner'], (c) =>
    dispatchPayout(c.db, c.actor, c.params.id, c.adapter)),
  route('POST', '/v1/entitlements/:id/reconcile', ['budget_owner'], (c) =>
    reconcilePayout(c.db, c.actor, c.params.id, c.adapter)),

  route('POST', '/v1/worker/tick', ['admin', 'steward'], (c) => runWorkerTick(c.db)),
];

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw badRequest('request body must be a JSON object');
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Durable idempotency: identical retry replays the stored response; a different payload conflicts. */
function withIdempotency(c: Ctx, r: Route, op: string, run: () => unknown | Promise<unknown>) {
  const key = c.req.headers['idempotency-key'] as string | undefined;
  if (!key) return run();
  const requestHash = hashObject({ op, body: c.body });
  const prior = c.db
    .prepare('SELECT * FROM idempotency WHERE tenant_id = ? AND key = ?')
    .get(c.actor.tenant_id, key) as
    | { request_hash: string; status_code: number; response_json: string }
    | undefined;
  if (prior) {
    if (prior.request_hash !== requestHash) {
      throw new DomainError(409, 'idempotency_conflict',
        'idempotency key was already used with a different payload');
    }
    return { __replay: true, status: prior.status_code, body: JSON.parse(prior.response_json) };
  }
  const runAndStore = async () => {
    const result = await run();
    const status = 200;
    c.db
      .prepare(
        `INSERT INTO idempotency (tenant_id, key, op, request_hash, status_code, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(c.actor.tenant_id, key, op, requestHash, status, JSON.stringify(result ?? {}), nowIso());
    return result;
  };
  return runAndStore();
}

export function createApp(opts: { db: Db; adapter?: PaymentAdapter }) {
  const db = opts.db;
  const adapter = opts.adapter ?? new LocalLedgerAdapter();

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (!path.startsWith('/v1/')) {
        return serveConsole(res, path);
      }

      if (path === '/v1/session/actors' || path === '/v1/health') {
        const match = routes.find((r) => r.method === req.method && r.pattern.test(path));
        if (!match) throw notFound('route not found');
        const out = await match.handler({ db, req, actor: null as unknown as Actor, params: {}, body: {}, adapter });
        return sendJson(res, 200, out ?? {});
      }

      const actor = requireActor(db, req.headers['x-actor-id'] as string | undefined);
      const match = routes.find((r) => r.method === req.method && r.pattern.test(path));
      if (!match) throw notFound('route not found');
      if (match.roles) requireRole(actor, match.roles);

      const params: Record<string, string> = {};
      const m = path.match(match.pattern)!;
      match.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));

      const body = MUTATING.has(req.method ?? '') ? await readBody(req) : {};
      const ctx: Ctx = { db, req, actor, params, body, adapter };

      const op = `${req.method} ${path}`;
      const out = MUTATING.has(req.method ?? '')
        ? await withIdempotency(ctx, match, op, () => match.handler(ctx))
        : await match.handler(ctx);

      if (out && typeof out === 'object' && '__replay' in (out as object)) {
        const replay = out as { status: number; body: unknown };
        return sendJson(res, replay.status, { ...replay.body as object, replayed: true });
      }
      sendJson(res, 200, out ?? {});
    } catch (err) {
      if (err instanceof DomainError) {
        sendJson(res, err.status, { error: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) });
      } else if (isSqliteConstraint(err)) {
        sendJson(res, 409, { error: 'conflict', message: 'uniqueness constraint violated' });
      } else {
        console.error('[server] unhandled error:', err);
        sendJson(res, 500, { error: 'internal_error', message: 'internal error' });
      }
    }
  };
}

function isSqliteConstraint(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveConsole(res: ServerResponse, path: string) {
  const rel = path === '/' ? 'index.html' : path.replace(/^\//, '');
  if (rel.includes('..')) return void res.writeHead(400).end('bad path');
  const file = join(CONSOLE_DIR, rel);
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  const ext = file.slice(file.lastIndexOf('.'));
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

export function startServer(opts: { dbPath: string; port?: number; adapter?: PaymentAdapter }): Server {
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = openDb(opts.dbPath);
  migrate(db);
  const app = createApp({ db, adapter: opts.adapter });
  const server = createServer((req, res) => {
    app(req, res).catch((err) => {
      console.error('[server] fatal:', err);
      try { res.writeHead(500).end('internal error'); } catch { /* socket closed */ }
    });
  });
  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  server.listen(port, () => console.log(`[server] appealset listening on :${port} (db=${opts.dbPath})`));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer({ dbPath: process.env.APPEALSET_DB ?? 'data/appealset.db' });
}
