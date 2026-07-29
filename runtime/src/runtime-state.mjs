import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadOrCreatePrivacyKey, PrivacyProjection } from "./privacy-projection.mjs";

const PROCESSED_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PROCESSED_EVENT_MAINTENANCE_HASH = "f3560cd711175cf1ff041cbd39a5d796e0f4db8dba6fd559ccb97ef194adfac9";
const SUPPLEMENT_CHECKPOINT_EVENT_PREFIX = "checkpoint:";
const PRIVACY_PROJECTION_VERSION = 1;
const READ_ONLY_SNAPSHOT_ATTEMPTS = 3;
const STATE_DATA_TABLES = [
  "processed_events",
  "runtime_control",
  "confirmations",
  "confirmation_events",
  "executions",
  "supplement_checkpoints",
  "daily_memory_locks"
];

function stateFilePaths(databasePath) {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
}

function existingMetadata(filename) {
  try {
    return lstatSync(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function preparePrivateStatePath(databasePath) {
  if (databasePath === ":memory:") return;
  const directory = existingMetadata(path.dirname(databasePath));
  if (!directory?.isDirectory() || directory.isSymbolicLink()) {
    throw new TypeError("state database directory must be a real directory");
  }
  if (process.platform !== "win32" && (directory.mode & 0o077) !== 0) {
    throw new TypeError("state database directory must use mode 0700");
  }
  const database = existingMetadata(databasePath);
  if (database && (!database.isFile() || database.isSymbolicLink())) {
    throw new TypeError("state database must be a regular file");
  }
}

function protectStateFiles(databasePath) {
  if (databasePath === ":memory:" || process.platform === "win32") return;
  for (const filename of stateFilePaths(databasePath)) {
    const metadata = existingMetadata(filename);
    if (!metadata) continue;
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new TypeError("state database files must be regular files");
    }
    chmodSync(filename, 0o600);
  }
}

function queryRuntimeState(database) {
  const hasRuntimeControl = database.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'runtime_control'
  `).get();
  if (!hasRuntimeControl) return null;
  const row = database.prepare(`
    SELECT frozen, reason, updated_at FROM runtime_control WHERE singleton = 1
  `).get();
  return row ? {
    frozen: row.frozen === 1,
    reason: row.reason,
    updated_at: row.updated_at
  } : null;
}

function validateReadOnlyStateFiles(databasePath) {
  for (const metadata of stateFilePaths(databasePath).slice(1).map(existingMetadata)) {
    if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
      throw new TypeError("state database files must be regular files");
    }
    if (metadata && process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new TypeError("state database files must not be accessible by group or other users");
    }
  }
}

function captureStateSnapshot(databasePath) {
  validateReadOnlyStateFiles(databasePath);
  const walPath = `${databasePath}-wal`;
  const walMetadata = existingMetadata(walPath);
  const files = [databasePath, ...(walMetadata ? [walPath] : [])].map((filename) => {
    const metadata = existingMetadata(filename);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      throw new Error("state database changed while creating a read-only snapshot");
    }
    return {
      filename,
      identity: {
        dev: metadata.dev,
        ino: metadata.ino,
        mode: metadata.mode,
        size: metadata.size
      },
      content: readFileSync(filename)
    };
  });
  return { files, wal_present: walMetadata !== null };
}

function stateSnapshotStillMatches(databasePath, snapshot) {
  if (Boolean(existingMetadata(`${databasePath}-wal`)) !== snapshot.wal_present) return false;
  return snapshot.files.every(({ filename, identity, content }) => {
    const metadata = existingMetadata(filename);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) return false;
    if (
      metadata.dev !== identity.dev ||
      metadata.ino !== identity.ino ||
      metadata.mode !== identity.mode ||
      metadata.size !== identity.size
    ) return false;
    return readFileSync(filename).equals(content);
  });
}

function openStateSnapshot(snapshot) {
  const directory = mkdtempSync(path.join(tmpdir(), "feishu-digital-twin-state-"));
  chmodSync(directory, 0o700);
  const snapshotPath = path.join(directory, "state.sqlite");
  try {
    for (const { filename, content } of snapshot.files) {
      const suffix = filename.endsWith("-wal") ? "-wal" : "";
      writeFileSync(`${snapshotPath}${suffix}`, content, { mode: 0o600, flag: "wx" });
    }
    return {
      database: new DatabaseSync(snapshotPath, { readOnly: true }),
      cleanup: () => rmSync(directory, { recursive: true, force: true })
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function readRuntimeState(databasePath) {
  requireText(databasePath, "databasePath");
  preparePrivateStatePath(databasePath);
  const databaseMetadata = existingMetadata(databasePath);
  if (!databaseMetadata) throw new TypeError("state database must already exist");
  if (process.platform !== "win32" && (databaseMetadata.mode & 0o077) !== 0) {
    throw new TypeError("state database must not be accessible by group or other users");
  }
  let lastError = null;
  for (let attempt = 0; attempt < READ_ONLY_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      const snapshot = captureStateSnapshot(databasePath);
      const { database, cleanup } = openStateSnapshot(snapshot);
      let result;
      try {
        result = queryRuntimeState(database) ?? {
          frozen: true,
          reason: "STATE_UNAVAILABLE",
          updated_at: null,
          state_available: false
        };
      } finally {
        try {
          database.close();
        } finally {
          cleanup();
        }
      }
      if (stateSnapshotStillMatches(databasePath, snapshot)) return result;
      lastError = new Error("state database changed while creating a read-only snapshot");
    } catch (error) {
      if (error instanceof TypeError) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error("state database changed while creating a read-only snapshot");
}

function requireText(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireTimestamp(value, name) {
  requireText(value, name);
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${name} must be an ISO date-time`);
  return value;
}

function requireIdentity(value, name) {
  requireText(value, name);
  if (!new Set(["user", "bot"]).has(value)) {
    throw new TypeError(`${name} must be user or bot`);
  }
  return value;
}

function transact(database, operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export class RuntimeState {
  constructor(databasePath, {
    clock = () => new Date().toISOString(),
    claimTtlMs = 5 * 60 * 1000,
    dailyMemoryLockTtlMs = 30 * 60 * 1000,
    stateRetentionMs = STATE_RETENTION_MS,
    privacyKey,
    privacyKeyPath = databasePath === ":memory:" ? null : `${databasePath}.privacy-key`,
    database
  } = {}) {
    requireText(databasePath, "databasePath");
    preparePrivateStatePath(databasePath);
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    if (!Number.isInteger(claimTtlMs) || claimTtlMs <= 0) {
      throw new TypeError("claimTtlMs must be a positive integer");
    }
    if (!Number.isInteger(dailyMemoryLockTtlMs) || dailyMemoryLockTtlMs <= 0) {
      throw new TypeError("dailyMemoryLockTtlMs must be a positive integer");
    }
    if (
      !Number.isInteger(stateRetentionMs) ||
      stateRetentionMs <= 0 ||
      stateRetentionMs > STATE_RETENTION_MS
    ) {
      throw new TypeError(
        `stateRetentionMs must be between 1 and ${STATE_RETENTION_MS}`
      );
    }
    this.clock = clock;
    this.claimTtlMs = claimTtlMs;
    this.dailyMemoryLockTtlMs = dailyMemoryLockTtlMs;
    this.stateRetentionMs = stateRetentionMs;
    const ownsDatabase = database === undefined;
    this.database = database ?? new DatabaseSync(databasePath);
    try {
      this.database.exec("PRAGMA busy_timeout = 5000;");
      transact(this.database, () => {
        this.assertPrivacyProjectionCompatible();
        protectStateFiles(databasePath);
        this.privacy = new PrivacyProjection(
          privacyKey ?? (privacyKeyPath
            ? loadOrCreatePrivacyKey(privacyKeyPath)
            : Buffer.alloc(32))
        );
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS processed_events (
            event_id TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK (status IN ('claimed', 'complete')),
            claimed_at TEXT NOT NULL,
            claim_expires_at TEXT NOT NULL,
            completed_at TEXT
          );
          CREATE TABLE IF NOT EXISTS runtime_control (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            frozen INTEGER NOT NULL CHECK (frozen IN (0, 1)),
            reason TEXT,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS confirmations (
            confirmation_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL DEFAULT 'command' CHECK (kind IN ('command', 'capability')),
            action_hash TEXT NOT NULL,
            action_id TEXT,
            operator_open_id TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            action_json TEXT,
            reason TEXT,
            requires_yes INTEGER NOT NULL DEFAULT 0 CHECK (requires_yes IN (0, 1)),
            source_event_id TEXT,
            source_chat_id TEXT,
            source_message_id TEXT,
            source_reply_identity TEXT NOT NULL DEFAULT 'user' CHECK (source_reply_identity IN ('user', 'bot')),
            status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
            created_at TEXT NOT NULL,
            resolved_at TEXT,
            resolved_event_id TEXT
          );
          CREATE TABLE IF NOT EXISTS confirmation_events (
            event_id TEXT PRIMARY KEY,
            confirmation_id TEXT NOT NULL,
            received_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS executions (
            command_hash TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            result_code TEXT,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS supplement_checkpoints (
            chat_id TEXT PRIMARY KEY,
            last_read_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS daily_memory_locks (
            target_date TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            acquired_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS privacy_metadata (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            projection_version INTEGER NOT NULL,
            key_fingerprint TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS processed_events_completed_at_idx
            ON processed_events (status, completed_at);
        `);
        const confirmationColumns = new Set(this.database.prepare(
          "PRAGMA table_info(confirmations)"
        ).all().map((column) => column.name));
        for (const [name, type] of [
          ["kind", "TEXT NOT NULL DEFAULT 'command'"],
          ["action_id", "TEXT"],
          ["action_json", "TEXT"],
          ["reason", "TEXT"],
          ["requires_yes", "INTEGER NOT NULL DEFAULT 0"],
          ["source_event_id", "TEXT"],
          ["source_chat_id", "TEXT"],
          ["source_message_id", "TEXT"],
          ["source_reply_identity", "TEXT NOT NULL DEFAULT 'user'"]
        ]) {
          if (!confirmationColumns.has(name)) {
            this.database.exec(`ALTER TABLE confirmations ADD COLUMN ${name} ${type}`);
          }
        }
        this.initializePrivacyProjection();
      });
      this.database.exec("PRAGMA journal_mode = WAL;");
      protectStateFiles(databasePath);
      this.expireConfirmations();
    } catch (error) {
      if (ownsDatabase) this.database.close();
      throw error;
    }
  }

  eventKey(eventId) {
    requireText(eventId, "eventId");
    const projected = this.privacy.identifier("event", eventId);
    return eventId.startsWith(SUPPLEMENT_CHECKPOINT_EVENT_PREFIX)
      ? `${SUPPLEMENT_CHECKPOINT_EVENT_PREFIX}${projected}`
      : projected;
  }

  checkpointKey(chatId) {
    return this.privacy.identifier("checkpoint", requireText(chatId, "chatId"));
  }

  operatorKey(openId) {
    return this.privacy.identifier("operator", requireText(openId, "operator_open_id"));
  }

  executionKey(value) {
    return this.privacy.identifier("execution", requireText(value, "execution_key"));
  }

  confirmationEventKey(eventId) {
    return this.privacy.identifier("confirmation-event", requireText(eventId, "event_id"));
  }

  assertPrivacyProjectionCompatible() {
    const tables = new Set(this.database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map((row) => row.name));
    const metadata = tables.has("privacy_metadata")
      ? this.database.prepare(`
          SELECT singleton FROM privacy_metadata WHERE singleton = 1
        `).get()
      : null;
    if (metadata) return;
    const hasLegacyData = STATE_DATA_TABLES.some((table) => (
      tables.has(table) && this.database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
    ));
    if (hasLegacyData) {
      throw new Error(
        "legacy state database contains data without privacy_metadata; use the local legacy entry"
      );
    }
  }

  initializePrivacyProjection() {
    const fingerprint = this.privacy.fingerprint();
    const existing = this.database.prepare(`
      SELECT projection_version, key_fingerprint FROM privacy_metadata WHERE singleton = 1
    `).get();
    if (existing) {
      if (existing.projection_version !== PRIVACY_PROJECTION_VERSION) {
        throw new Error("unsupported privacy projection version");
      }
      if (existing.key_fingerprint !== fingerprint) {
        throw new Error("privacy projection key does not match this state database");
      }
      return;
    }

    this.database.prepare(`
      INSERT INTO privacy_metadata (singleton, projection_version, key_fingerprint)
      VALUES (1, ?, ?)
    `).run(PRIVACY_PROJECTION_VERSION, fingerprint);
  }

  now() {
    return requireTimestamp(this.clock(), "clock result");
  }

  claimEvent(eventId) {
    this.maintainState();
    const eventKey = this.eventKey(eventId);
    const now = this.now();
    const expiresAt = new Date(Date.parse(now) + this.claimTtlMs).toISOString();
    const result = this.database.prepare(`
      INSERT INTO processed_events (
        event_id, status, claimed_at, claim_expires_at, completed_at
      ) VALUES (?, 'claimed', ?, ?, NULL)
      ON CONFLICT(event_id) DO UPDATE SET
        status = 'claimed',
        claimed_at = excluded.claimed_at,
        claim_expires_at = excluded.claim_expires_at,
        completed_at = NULL
      WHERE processed_events.status = 'claimed'
        AND processed_events.claim_expires_at <= excluded.claimed_at
    `).run(eventKey, now, expiresAt);
    return result.changes === 1;
  }

  releaseEvent(eventId) {
    const eventKey = this.eventKey(eventId);
    return this.database.prepare(`
      DELETE FROM processed_events WHERE event_id = ? AND status = 'claimed'
    `).run(eventKey).changes === 1;
  }

  completeEvent(eventId) {
    requireText(eventId, "eventId");
    if (eventId.startsWith(SUPPLEMENT_CHECKPOINT_EVENT_PREFIX)) {
      return this.releaseEvent(eventId);
    }
    const now = this.now();
    const eventKey = this.eventKey(eventId);
    return this.database.prepare(`
      UPDATE processed_events
      SET status = 'complete', completed_at = ?, claim_expires_at = ?
      WHERE event_id = ? AND status = 'claimed'
    `).run(now, now, eventKey).changes === 1;
  }

  maintainProcessedEvents({ force = false } = {}) {
    const result = this.maintainState({ force });
    return {
      ran: result.ran,
      deleted: result.deleted.processed_events
    };
  }

  maintainState({ force = false } = {}) {
    if (typeof force !== "boolean") throw new TypeError("force must be a boolean");
    const now = this.now();
    const previous = this.database.prepare(`
      SELECT updated_at FROM executions WHERE command_hash = ?
    `).get(PROCESSED_EVENT_MAINTENANCE_HASH)?.updated_at;
    if (!force && previous && Date.parse(now) - Date.parse(previous) < MAINTENANCE_INTERVAL_MS) {
      return {
        ran: false,
        deleted: {
          processed_events: 0,
          confirmations: 0,
          confirmation_events: 0,
          executions: 0,
          daily_memory_locks: 0
        }
      };
    }

    this.expireConfirmations();
    return transact(this.database, () => {
      const current = this.database.prepare(`
        SELECT updated_at FROM executions WHERE command_hash = ?
      `).get(PROCESSED_EVENT_MAINTENANCE_HASH)?.updated_at;
      if (!force && current && Date.parse(now) - Date.parse(current) < MAINTENANCE_INTERVAL_MS) {
        return {
          ran: false,
          deleted: {
            processed_events: 0,
            confirmations: 0,
            confirmation_events: 0,
            executions: 0,
            daily_memory_locks: 0
          }
        };
      }
      const transientEventsDeleted = this.database.prepare(`
        DELETE FROM processed_events
        WHERE (event_id GLOB ? AND status = 'complete')
          OR (status = 'claimed' AND claim_expires_at <= ?)
      `).run(`${SUPPLEMENT_CHECKPOINT_EVENT_PREFIX}*`, now).changes;
      const cutoff = new Date(Date.parse(now) - Math.min(
        PROCESSED_EVENT_RETENTION_MS,
        this.stateRetentionMs
      )).toISOString();
      const expiredDeleted = this.database.prepare(`
        DELETE FROM processed_events
        WHERE status = 'complete' AND completed_at IS NOT NULL AND completed_at < ?
      `).run(cutoff).changes;
      const stateCutoff = new Date(Date.parse(now) - this.stateRetentionMs).toISOString();
      this.database.prepare(`
        DELETE FROM supplement_checkpoints
        WHERE julianday(last_read_at) < julianday(?)
      `).run(stateCutoff);
      const confirmationEventsDeleted = this.database.prepare(`
        DELETE FROM confirmation_events WHERE received_at < ?
      `).run(stateCutoff).changes;
      const confirmationsDeleted = this.database.prepare(`
        DELETE FROM confirmations
        WHERE status != 'pending' AND resolved_at IS NOT NULL AND resolved_at < ?
      `).run(stateCutoff).changes;
      const executionsDeleted = this.database.prepare(`
        DELETE FROM executions WHERE command_hash != ? AND updated_at < ?
      `).run(PROCESSED_EVENT_MAINTENANCE_HASH, stateCutoff).changes;
      const dailyMemoryLocksDeleted = this.database.prepare(`
        DELETE FROM daily_memory_locks WHERE expires_at < ?
      `).run(stateCutoff).changes;
      this.database.prepare(`
        INSERT INTO executions (command_hash, status, result_code, updated_at)
        VALUES (?, 'complete', 'STATE_RETENTION', ?)
        ON CONFLICT(command_hash) DO UPDATE SET
          status = excluded.status,
          result_code = excluded.result_code,
          updated_at = excluded.updated_at
      `).run(PROCESSED_EVENT_MAINTENANCE_HASH, now);
      return {
        ran: true,
        deleted: {
          processed_events: transientEventsDeleted + expiredDeleted,
          confirmations: confirmationsDeleted,
          confirmation_events: confirmationEventsDeleted,
          executions: executionsDeleted,
          daily_memory_locks: dailyMemoryLocksDeleted
        }
      };
    });
  }

  claimDailyMemoryRun(targetDate, ownerId) {
    requireText(targetDate, "targetDate");
    requireText(ownerId, "ownerId");
    this.maintainProcessedEvents();
    const now = this.now();
    const expiresAt = new Date(Date.parse(now) + this.dailyMemoryLockTtlMs).toISOString();
    const result = this.database.prepare(`
      INSERT INTO daily_memory_locks (target_date, owner_id, acquired_at, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(target_date) DO UPDATE SET
        owner_id = excluded.owner_id,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
      WHERE daily_memory_locks.expires_at <= excluded.acquired_at
    `).run(targetDate, ownerId, now, expiresAt);
    return result.changes === 1;
  }

  renewDailyMemoryRun(targetDate, ownerId) {
    requireText(targetDate, "targetDate");
    requireText(ownerId, "ownerId");
    const now = this.now();
    const expiresAt = new Date(Date.parse(now) + this.dailyMemoryLockTtlMs).toISOString();
    return this.database.prepare(`
      UPDATE daily_memory_locks
      SET expires_at = ?
      WHERE target_date = ? AND owner_id = ? AND expires_at > ?
    `).run(expiresAt, targetDate, ownerId, now).changes === 1;
  }

  releaseDailyMemoryRun(targetDate, ownerId) {
    requireText(targetDate, "targetDate");
    requireText(ownerId, "ownerId");
    return this.database.prepare(`
      DELETE FROM daily_memory_locks WHERE target_date = ? AND owner_id = ?
    `).run(targetDate, ownerId).changes === 1;
  }

  getRuntimeState() {
    return queryRuntimeState(this.database) ?? {
      frozen: false,
      reason: null,
      updated_at: null
    };
  }

  setFrozen(frozen, reason) {
    if (typeof frozen !== "boolean") throw new TypeError("frozen must be a boolean");
    requireText(reason, "reason");
    this.database.prepare(`
      INSERT INTO runtime_control (singleton, frozen, reason, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        frozen = excluded.frozen,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `).run(frozen ? 1 : 0, reason, this.now());
    return this.getRuntimeState();
  }

  createConfirmation({
    confirmation_id,
    kind = "command",
    action_hash = null,
    action_id = null,
    operator_open_id,
    expires_at,
    action = null,
    reason = null,
    requires_yes = false,
    source_event_id = null,
    source_chat_id = null,
    source_message_id = null,
    source_reply_identity = "user"
  }) {
    requireText(confirmation_id, "confirmation_id");
    if (kind !== "command" && kind !== "capability") {
      throw new TypeError("kind must be command or capability");
    }
    if (kind === "command") {
      requireText(action_hash, "action_hash");
      if (action_id !== null) {
        throw new TypeError("command confirmation cannot store a capability action reference");
      }
    } else {
      requireText(action_id, "action_id");
      if (action_hash !== null) {
        throw new TypeError("capability confirmation cannot store an action_hash");
      }
      if (action !== null) {
        throw new TypeError("capability confirmation cannot store a command action");
      }
      if (requires_yes) {
        throw new TypeError("capability confirmation cannot require command --yes");
      }
    }
    requireText(operator_open_id, "operator_open_id");
    requireTimestamp(expires_at, "expires_at");
    const now = this.now();
    if (Date.parse(expires_at) <= Date.parse(now)) {
      throw new TypeError("expires_at must be in the future");
    }
    if (action !== null && (typeof action !== "object" || !Array.isArray(action.argv))) {
      throw new TypeError("action must be null or a command object");
    }
    if (typeof requires_yes !== "boolean") throw new TypeError("requires_yes must be a boolean");
    requireIdentity(source_reply_identity, "source_reply_identity");
    for (const [value, name] of [
      [reason, "reason"],
      [source_event_id, "source_event_id"],
      [source_chat_id, "source_chat_id"],
      [source_message_id, "source_message_id"]
    ]) {
      if (value !== null && typeof value !== "string") {
        throw new TypeError(`${name} must be a string or null`);
      }
    }
    this.database.prepare(`
      INSERT INTO confirmations (
        confirmation_id, kind, action_hash, action_id,
        operator_open_id, expires_at,
        action_json, reason, requires_yes, source_event_id, source_chat_id, source_message_id,
        source_reply_identity, status, created_at, resolved_at, resolved_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)
    `).run(
      confirmation_id,
      kind,
      kind === "command" ? action_hash : action_id,
      action_id,
      this.operatorKey(operator_open_id),
      expires_at,
      action === null ? null : JSON.stringify(action),
      reason,
      requires_yes ? 1 : 0,
      source_event_id,
      source_chat_id,
      source_message_id,
      source_reply_identity,
      now
    );
  }

  getConfirmation(confirmationId) {
    requireText(confirmationId, "confirmationId");
    const row = this.database.prepare(`
      SELECT confirmation_id, kind, action_hash, action_id,
             operator_open_id, expires_at,
             action_json, reason, requires_yes, source_event_id, source_chat_id, source_message_id,
             source_reply_identity, status, created_at, resolved_at, resolved_event_id
      FROM confirmations WHERE confirmation_id = ?
    `).get(confirmationId);
    if (!row) return null;
    return {
      ...row,
      action_hash: row.kind === "command" ? row.action_hash : null,
      requires_yes: row.requires_yes === 1,
      action: row.action_json === null ? null : JSON.parse(row.action_json)
    };
  }

  resolveConfirmation({
    confirmation_id,
    action_hash = null,
    action_id = null,
    operator_open_id,
    event_id,
    decision
  }) {
    requireText(confirmation_id, "confirmation_id");
    const hasActionHash = typeof action_hash === "string" && action_hash.length > 0;
    const hasActionId = typeof action_id === "string" && action_id.length > 0;
    if (hasActionHash === hasActionId) {
      throw new TypeError("exactly one of action_hash or action_id must be a non-empty string");
    }
    const operatorKey = this.operatorKey(operator_open_id);
    const confirmationEventKey = this.confirmationEventKey(event_id);
    if (decision !== "approve" && decision !== "reject") {
      throw new TypeError("decision must be approve or reject");
    }

    return transact(this.database, () => {
      if (this.database.prepare(`
        SELECT event_id FROM confirmation_events WHERE event_id = ?
      `).get(confirmationEventKey)) {
        return { accepted: false, reason: "DUPLICATE_EVENT" };
      }
      const confirmation = this.getConfirmation(confirmation_id);
      if (!confirmation) return { accepted: false, reason: "NOT_FOUND" };
      if (confirmation.status !== "pending") {
        return { accepted: false, reason: "ALREADY_RESOLVED" };
      }
      if (
        (confirmation.kind === "command" && confirmation.action_hash !== action_hash) ||
        (confirmation.kind === "capability" && confirmation.action_id !== action_id)
      ) {
        return { accepted: false, reason: "ACTION_MISMATCH" };
      }
      if (confirmation.operator_open_id !== operatorKey) {
        return { accepted: false, reason: "OPERATOR_MISMATCH" };
      }

      const now = this.now();
      if (Date.parse(now) >= Date.parse(confirmation.expires_at)) {
        this.database.prepare(`
          UPDATE confirmations
          SET status = 'expired', resolved_at = ?, resolved_event_id = ?,
              action_json = NULL, reason = NULL,
              source_event_id = NULL, source_chat_id = NULL, source_message_id = NULL
          WHERE confirmation_id = ? AND status = 'pending'
        `).run(now, confirmationEventKey, confirmation_id);
        this.database.prepare(`
          INSERT INTO confirmation_events (event_id, confirmation_id, received_at)
          VALUES (?, ?, ?)
        `).run(confirmationEventKey, confirmation_id, now);
        return { accepted: false, reason: "EXPIRED" };
      }

      const status = decision === "approve" ? "approved" : "rejected";
      this.database.prepare(`
        UPDATE confirmations
        SET status = ?, resolved_at = ?, resolved_event_id = ?
        WHERE confirmation_id = ? AND status = 'pending'
      `).run(status, now, confirmationEventKey, confirmation_id);
      this.database.prepare(`
        INSERT INTO confirmation_events (event_id, confirmation_id, received_at)
        VALUES (?, ?, ?)
      `).run(confirmationEventKey, confirmation_id, now);
      return { accepted: true, status };
    });
  }

  expireConfirmations() {
    const now = this.now();
    const expired = this.database.prepare(`
      UPDATE confirmations
      SET status = 'expired', resolved_at = ?, action_json = NULL, reason = NULL,
          source_event_id = NULL, source_chat_id = NULL, source_message_id = NULL
      WHERE status = 'pending' AND expires_at <= ?
    `).run(now, now).changes;
    const resolved = this.database.prepare(`
      UPDATE confirmations
      SET action_json = NULL, reason = NULL,
          source_event_id = NULL, source_chat_id = NULL, source_message_id = NULL
      WHERE status != 'pending' AND (
        action_json IS NOT NULL OR reason IS NOT NULL OR source_event_id IS NOT NULL OR
        source_chat_id IS NOT NULL OR source_message_id IS NOT NULL
      )
    `).run().changes;
    return expired + resolved;
  }

  clearConfirmationPayload(confirmationId) {
    requireText(confirmationId, "confirmationId");
    return this.database.prepare(`
      UPDATE confirmations
      SET action_json = NULL, reason = NULL,
          source_event_id = NULL, source_chat_id = NULL, source_message_id = NULL
      WHERE confirmation_id = ?
    `).run(confirmationId).changes === 1;
  }

  recordExecution({ command_hash, status, result_code = null }) {
    requireText(command_hash, "command_hash");
    requireText(status, "status");
    if (result_code !== null && typeof result_code !== "string") {
      throw new TypeError("result_code must be a string or null");
    }
    this.database.prepare(`
      INSERT INTO executions (command_hash, status, result_code, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(command_hash) DO UPDATE SET
        status = excluded.status,
        result_code = excluded.result_code,
        updated_at = excluded.updated_at
    `).run(command_hash, status, result_code, this.now());
  }

  getExecution(commandHash) {
    requireText(commandHash, "commandHash");
    return this.database.prepare(`
      SELECT command_hash, status, result_code, updated_at
      FROM executions WHERE command_hash = ?
    `).get(commandHash) ?? null;
  }

  getSupplementCheckpoint(chatId) {
    const checkpointKey = this.checkpointKey(chatId);
    return this.database.prepare(`
      SELECT last_read_at FROM supplement_checkpoints WHERE chat_id = ?
    `).get(checkpointKey)?.last_read_at ?? null;
  }

  areEventsComplete(eventIds) {
    if (!Array.isArray(eventIds)) throw new TypeError("eventIds must be an array");
    const statement = this.database.prepare(`
      SELECT status FROM processed_events WHERE event_id = ?
    `);
    return [...new Set(eventIds.map((eventId) => this.eventKey(eventId)))]
      .every((eventKey) => statement.get(eventKey)?.status === "complete");
  }

  setSupplementCheckpoint(chatId, lastReadAt) {
    const checkpointKey = this.checkpointKey(chatId);
    requireTimestamp(lastReadAt, "lastReadAt");
    const normalizedLastReadAt = new Date(Date.parse(lastReadAt)).toISOString();
    this.database.prepare(`
      INSERT INTO supplement_checkpoints (chat_id, last_read_at)
      VALUES (?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET last_read_at = excluded.last_read_at
      WHERE julianday(supplement_checkpoints.last_read_at) < julianday(excluded.last_read_at)
    `).run(checkpointKey, normalizedLastReadAt);
  }

  close() {
    this.database.close();
  }
}
