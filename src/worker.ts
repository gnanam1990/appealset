import { openDb } from './lib/db.ts';
import type { Db } from './lib/db.ts';
import { migrate } from './lib/migrations.ts';
import { routeCase } from './domain/routing.ts';
import { expireStaleLeases } from './domain/assignments.ts';
import { nowIso } from './lib/hash.ts';

const MAX_ATTEMPTS = 5;

/**
 * Process pending outbox rows once. Claimed rows go through idempotent domain
 * handlers, so a crash between the domain write and marking the row done is
 * safe: the next pass re-runs the handler and it no-ops.
 */
export function processOutboxOnce(db: Db): { processed: number; dead: number } {
  const rows = db
    .prepare(`SELECT * FROM outbox WHERE status IN ('pending','processing') ORDER BY id LIMIT 50`)
    .all() as { id: number; tenant_id: string; kind: string; payload_json: string; attempts: number }[];
  let processed = 0;
  let dead = 0;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (row.kind === 'route_case') {
        routeCase(db, payload.case_id as string);
      } else {
        throw new Error(`unknown outbox kind ${row.kind}`);
      }
      db.prepare(`UPDATE outbox SET status = 'done', processed_at = ?, attempts = attempts + 1 WHERE id = ?`).run(
        nowIso(),
        row.id
      );
      processed++;
    } catch (err) {
      const attempts = row.attempts + 1;
      const deadRow = attempts >= MAX_ATTEMPTS;
      db.prepare(
        `UPDATE outbox SET status = ?, attempts = ?, last_error = ? WHERE id = ?`
      ).run(deadRow ? 'dead' : 'pending', attempts, String(err), row.id);
      if (deadRow) dead++;
    }
  }
  return { processed, dead };
}

export function runWorkerTick(db: Db): { outbox: { processed: number; dead: number }; expired: number } {
  const expired = expireStaleLeases(db);
  const outbox = processOutboxOnce(db);
  return { outbox, expired };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.APPEALSET_DB ?? 'data/appealset.db';
  const db = openDb(dbPath);
  migrate(db);
  const intervalMs = Number(process.env.APPEALSET_WORKER_INTERVAL_MS ?? 1000);
  const timer = setInterval(() => {
    try {
      runWorkerTick(db);
    } catch (err) {
      console.error('[worker] tick failed:', err);
    }
  }, intervalMs);
  const stop = () => {
    clearInterval(timer);
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`[worker] appealset worker running (db=${dbPath}, interval=${intervalMs}ms)`);
}
