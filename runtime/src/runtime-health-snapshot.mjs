import { DatabaseSync } from "node:sqlite";

export function readRuntimeHealthSnapshot(databasePath, { now = new Date().toISOString() } = {}) {
  if (typeof databasePath !== "string" || databasePath.length === 0) {
    throw new TypeError("databasePath is required");
  }
  if (Number.isNaN(Date.parse(now))) throw new TypeError("now must be an ISO date-time");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const runtime = database.prepare(`
      SELECT frozen FROM runtime_control WHERE singleton = 1
    `).get();
    const processed = database.prepare(`
      SELECT COUNT(*) AS count FROM processed_events WHERE status = 'complete'
    `).get();
    const checkpoint = database.prepare(`
      SELECT COUNT(*) AS count, MAX(last_read_at) AS latest_at FROM supplement_checkpoints
    `).get();
    const expiredLocks = database.prepare(`
      SELECT COUNT(*) AS count FROM daily_memory_locks WHERE expires_at <= ?
    `).get(now);
    return {
      frozen: runtime?.frozen === 1,
      processed_complete_count: Number(processed?.count ?? 0),
      supplement_checkpoint_count: Number(checkpoint?.count ?? 0),
      supplement_checkpoint_latest_at: checkpoint?.latest_at ?? null,
      daily_memory_expired_lock_count: Number(expiredLocks?.count ?? 0)
    };
  } finally {
    database.close();
  }
}
