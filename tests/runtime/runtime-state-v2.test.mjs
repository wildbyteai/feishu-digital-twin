import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { readRuntimeState, RuntimeState } from "../../runtime/src/runtime-state.mjs";

function databasePath() {
  return path.join(mkdtempSync(path.join(tmpdir(), "twin-state-")), "state.sqlite");
}

test("最小状态只保存事件去重、冻结、确认和执行元数据", () => {
  const state = new RuntimeState(databasePath(), {
    clock: () => "2026-07-16T10:00:00.000Z"
  });
  try {
    assert.equal(state.claimEvent("evt-1"), true);
    assert.equal(state.claimEvent("evt-1"), false);
    assert.equal(state.releaseEvent("evt-1"), true);
    assert.equal(state.claimEvent("evt-1"), true);
    assert.equal(state.completeEvent("evt-1"), true);
    assert.equal(state.claimEvent("evt-1"), false);

    assert.deepEqual(state.getRuntimeState(), {
      frozen: false,
      reason: null,
      updated_at: null
    });
    state.setFrozen(true, "PRINCIPAL_REQUEST");
    assert.equal(state.getRuntimeState().frozen, true);
    state.setFrozen(false, "PRINCIPAL_RESUME");
    assert.equal(state.getRuntimeState().frozen, false);

    state.recordExecution({
      command_hash: "a".repeat(64),
      status: "complete",
      result_code: "OK"
    });
    assert.equal(state.getExecution("a".repeat(64)).status, "complete");

    assert.equal(state.getSupplementCheckpoint("oc_1"), null);
    state.setSupplementCheckpoint("oc_1", "2026-07-16T10:00:00.000Z");
    assert.equal(state.getSupplementCheckpoint("oc_1"), "2026-07-16T10:00:00.000Z");
  } finally {
    state.close();
  }
});

test("只读状态在唯一运行行缺失时失败关闭", () => {
  const file = databasePath();
  const state = new RuntimeState(file);
  state.close();
  const database = new DatabaseSync(file);
  database.exec("DELETE FROM runtime_control");
  database.close();

  assert.deepEqual(readRuntimeState(file), {
    frozen: true,
    reason: "STATE_UNAVAILABLE",
    updated_at: null,
    state_available: false
  });
});

test("长期状态使用本机类型化 HMAC，待确认原始寻址在结束后立即清空", () => {
  const file = databasePath();
  const state = new RuntimeState(file, {
    clock: () => "2026-07-16T10:00:00.000Z",
    privacyKey: Buffer.alloc(32, 7)
  });
  try {
    state.claimEvent("message:om_sensitive:2026-07-16T10:00:00.000Z");
    state.completeEvent("message:om_sensitive:2026-07-16T10:00:00.000Z");
    state.setSupplementCheckpoint("oc_sensitive", "2026-07-16T10:00:00.000Z");
    state.createConfirmation({
      confirmation_id: "confirm-private",
      action_hash: "a".repeat(64),
      operator_open_id: "ou_sensitive",
      expires_at: "2026-07-16T10:05:00.000Z",
      action: { argv: ["task", "+create", "--summary", "敏感事项"] },
      reason: "敏感事项",
      source_event_id: "evt_sensitive",
      source_chat_id: "oc_sensitive",
      source_message_id: "om_sensitive"
    });

    const pendingDatabase = new DatabaseSync(file, { readOnly: true });
    const pending = pendingDatabase.prepare(`
      SELECT operator_open_id, source_chat_id FROM confirmations
      WHERE confirmation_id = 'confirm-private'
    `).get();
    pendingDatabase.close();
    assert.match(pending.operator_open_id, /^operator_[a-f0-9]{64}$/u);
    assert.equal(pending.source_chat_id, "oc_sensitive");

    assert.deepEqual(state.resolveConfirmation({
      confirmation_id: "confirm-private",
      action_hash: "a".repeat(64),
      operator_open_id: "ou_sensitive",
      event_id: "evt_confirmation_reply",
      decision: "reject"
    }), { accepted: true, status: "rejected" });
    state.clearConfirmationPayload("confirm-private");

    const database = new DatabaseSync(file, { readOnly: true });
    const serialized = JSON.stringify({
      processed: database.prepare("SELECT * FROM processed_events").all(),
      checkpoints: database.prepare("SELECT * FROM supplement_checkpoints").all(),
      confirmations: database.prepare("SELECT * FROM confirmations").all(),
      confirmationEvents: database.prepare("SELECT * FROM confirmation_events").all()
    });
    database.close();
    for (const raw of [
      "om_sensitive",
      "oc_sensitive",
      "ou_sensitive",
      "evt_sensitive",
      "evt_confirmation_reply",
      "敏感事项"
    ]) {
      assert.equal(serialized.includes(raw), false, `raw value persisted: ${raw}`);
    }
    assert.match(serialized, /event_[a-f0-9]{64}/u);
    assert.match(serialized, /checkpoint_[a-f0-9]{64}/u);
    assert.match(serialized, /operator_[a-f0-9]{64}/u);
  } finally {
    state.close();
  }
});

test("公共状态拒绝原地改写含数据但无隐私元数据的旧库", () => {
  const file = databasePath();
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE processed_events (
      event_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('claimed', 'complete')),
      claimed_at TEXT NOT NULL,
      claim_expires_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE supplement_checkpoints (
      chat_id TEXT PRIMARY KEY,
      last_read_at TEXT NOT NULL
    );
    INSERT INTO processed_events VALUES (
      'message:om_legacy', 'complete',
      '2026-07-24T01:00:00.000Z', '2026-07-24T01:00:00.000Z',
      '2026-07-24T01:00:00.000Z'
    );
    INSERT INTO supplement_checkpoints VALUES (
      'oc_legacy', '2026-07-24T01:00:00.000Z'
    );
  `);
  const schemaBefore = database.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `).all();
  const eventsBefore = database.prepare("SELECT * FROM processed_events").all();
  const checkpointsBefore = database.prepare("SELECT * FROM supplement_checkpoints").all();
  database.close();
  const bytesBefore = readFileSync(file);
  const modeBefore = statSync(file).mode & 0o777;

  assert.throws(
    () => new RuntimeState(file),
    /legacy state database.*privacy_metadata/u
  );
  assert.deepEqual(readFileSync(file), bytesBefore);
  assert.equal(statSync(file).mode & 0o777, modeBefore);

  const unchanged = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(unchanged.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `).all(), schemaBefore);
  assert.deepEqual(unchanged.prepare("SELECT * FROM processed_events").all(), eventsBefore);
  assert.deepEqual(
    unchanged.prepare("SELECT * FROM supplement_checkpoints").all(),
    checkpointsBefore
  );
  unchanged.close();
  assert.equal(existsSync(`${file}.privacy-key`), false);
});

test("未显式配置秘密时在状态库旁原子创建 0600 的本机投影密钥", () => {
  const file = databasePath();
  const state = new RuntimeState(file, {
    clock: () => "2026-07-16T10:00:00.000Z"
  });
  state.close();

  const keyPath = `${file}.privacy-key`;
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.match(readFileSync(keyPath, "utf8"), /^[a-f0-9]{64}\n$/u);
});

test("状态库、WAL、SHM 与投影密钥只允许当前用户读取", () => {
  const file = databasePath();
  writeFileSync(file, "", { mode: 0o644 });
  const state = new RuntimeState(file, {
    clock: () => "2026-07-16T10:00:00.000Z"
  });
  try {
    state.claimEvent("message:permission-check");
    for (const filename of [file, `${file}-wal`, `${file}-shm`, `${file}.privacy-key`]) {
      assert.equal(statSync(filename).mode & 0o777, 0o600, filename);
    }
  } finally {
    state.close();
  }
});

test("状态库拒绝非私有目录和符号链接", () => {
  const publicDirectory = mkdtempSync(path.join(tmpdir(), "twin-state-public-"));
  chmodSync(publicDirectory, 0o755);
  assert.throws(
    () => new RuntimeState(path.join(publicDirectory, "state.sqlite")),
    /state database directory must use mode 0700/u
  );

  const privateDirectory = mkdtempSync(path.join(tmpdir(), "twin-state-link-"));
  const target = path.join(privateDirectory, "target.sqlite");
  const linked = path.join(privateDirectory, "state.sqlite");
  writeFileSync(target, "", { mode: 0o600 });
  symlinkSync(target, linked);
  assert.throws(
    () => new RuntimeState(linked),
    /state database must be a regular file/u
  );
});

test("补读游标事件完成或延期后不形成长期去重历史", () => {
  const state = new RuntimeState(databasePath(), {
    clock: () => "2026-07-16T10:00:00.000Z"
  });
  try {
    assert.equal(state.claimEvent("checkpoint:oc_1:first"), true);
    assert.equal(state.completeEvent("checkpoint:oc_1:first"), true);
    assert.equal(state.claimEvent("checkpoint:oc_1:first"), true);
    assert.equal(state.releaseEvent("checkpoint:oc_1:first"), true);

    assert.equal(state.claimEvent("message:om_1"), true);
    assert.equal(state.completeEvent("message:om_1"), true);
    assert.equal(state.claimEvent("message:om_1"), false);
  } finally {
    state.close();
  }
});

test("已完成真实事件保留三十天且维护每天最多实际执行一次", () => {
  let now = "2026-05-24T00:00:00.000Z";
  const state = new RuntimeState(databasePath(), { clock: () => now });
  try {
    assert.equal(state.claimEvent("message:expired"), true);
    assert.equal(state.completeEvent("message:expired"), true);

    now = "2026-05-25T00:00:00.000Z";
    assert.equal(state.claimEvent("message:boundary"), true);
    assert.equal(state.completeEvent("message:boundary"), true);

    now = "2026-06-23T00:00:00.000Z";
    assert.equal(state.claimEvent("message:fresh"), true);
    assert.equal(state.completeEvent("message:fresh"), true);

    now = "2026-06-24T00:00:00.000Z";
    assert.equal(state.claimEvent("message:claimed"), true);
    const first = state.maintainProcessedEvents({ force: true });
    assert.deepEqual(first, { ran: true, deleted: 0 });
    assert.equal(state.claimEvent("message:expired"), true);
    assert.equal(state.claimEvent("message:boundary"), false);
    assert.equal(state.claimEvent("message:fresh"), false);
    assert.equal(state.claimEvent("message:claimed"), false);

    now = "2026-05-01T00:00:00.000Z";
    assert.equal(state.claimEvent("message:late-fixture"), true);
    assert.equal(state.completeEvent("message:late-fixture"), true);
    now = "2026-06-24T01:00:00.000Z";
    assert.deepEqual(state.maintainProcessedEvents(), { ran: false, deleted: 0 });
    assert.equal(state.claimEvent("message:late-fixture"), false);

    now = "2026-06-25T00:00:00.001Z";
    assert.deepEqual(state.maintainProcessedEvents(), { ran: true, deleted: 4 });
    assert.equal(state.claimEvent("message:late-fixture"), true);
  } finally {
    state.close();
  }
});

test("部署者可以缩短状态保留期但不能超过三十天硬上限", () => {
  let now = "2026-07-01T00:00:00.000Z";
  const state = new RuntimeState(databasePath(), {
    clock: () => now,
    stateRetentionMs: 7 * 24 * 60 * 60 * 1000
  });
  try {
    assert.equal(state.claimEvent("message:old-seven-day"), true);
    assert.equal(state.completeEvent("message:old-seven-day"), true);
    state.setSupplementCheckpoint("oc_old-seven-day", now);

    now = "2026-07-08T00:00:00.001Z";
    assert.equal(state.maintainState({ force: true }).ran, true);
    assert.equal(state.claimEvent("message:old-seven-day"), true);
    assert.equal(state.getSupplementCheckpoint("oc_old-seven-day"), null);
  } finally {
    state.close();
  }

  assert.throws(
    () => new RuntimeState(databasePath(), {
      stateRetentionMs: 31 * 24 * 60 * 60 * 1000
    }),
    /stateRetentionMs must be between/u
  );
});

test("统一维护会删除所有已过期的处理中事件并保留仍有效的处理中事件", () => {
  let now = "2026-07-24T00:00:00.000Z";
  const state = new RuntimeState(databasePath(), {
    clock: () => now,
    claimTtlMs: 5 * 60 * 1000
  });
  try {
    assert.equal(state.claimEvent("message:expired-claim"), true);
    now = "2026-07-24T00:04:00.000Z";
    assert.equal(state.claimEvent("message:active-claim"), true);

    now = "2026-07-24T00:06:00.000Z";
    assert.deepEqual(state.maintainProcessedEvents({ force: true }), {
      ran: true,
      deleted: 1
    });
    assert.equal(state.releaseEvent("message:expired-claim"), false);
    assert.equal(state.releaseEvent("message:active-claim"), true);
  } finally {
    state.close();
  }
});

test("统一维护会清理过期去重、确认、确认事件、执行摘要和日报锁", () => {
  let now = "2026-05-01T00:00:00.000Z";
  const file = databasePath();
  const state = new RuntimeState(file, {
    clock: () => now,
    dailyMemoryLockTtlMs: 60_000,
    privacyKey: Buffer.alloc(32, 9)
  });
  try {
    state.claimEvent("message:old");
    state.completeEvent("message:old");
    state.recordExecution({ command_hash: "e".repeat(64), status: "complete", result_code: "OK" });
    state.createConfirmation({
      confirmation_id: "confirm-old",
      action_hash: "f".repeat(64),
      operator_open_id: "ou_principal",
      expires_at: "2026-05-01T00:05:00.000Z",
      action: { argv: ["task", "+create"] },
      reason: "temporary"
    });
    assert.deepEqual(state.resolveConfirmation({
      confirmation_id: "confirm-old",
      action_hash: "f".repeat(64),
      operator_open_id: "ou_principal",
      event_id: "confirmation-old",
      decision: "reject"
    }), { accepted: true, status: "rejected" });
    state.clearConfirmationPayload("confirm-old");
    assert.equal(state.claimDailyMemoryRun("2026-05-01", "owner-old"), true);

    now = "2026-06-01T00:00:00.001Z";
    const result = state.maintainState({ force: true });
    assert.equal(result.ran, true);
    assert.deepEqual(result.deleted, {
      processed_events: 1,
      confirmations: 1,
      confirmation_events: 1,
      executions: 1,
      daily_memory_locks: 1
    });

    const database = new DatabaseSync(file, { readOnly: true });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM confirmations").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM confirmation_events").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM daily_memory_locks").get().count, 0);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM executions WHERE result_code != 'STATE_RETENTION'
    `).get().count, 0);
    database.close();
  } finally {
    state.close();
  }
});

test("即使未启用每日记忆，常规消息也会每天触发一次状态维护", () => {
  let now = "2026-05-01T00:00:00.000Z";
  const state = new RuntimeState(databasePath(), {
    clock: () => now,
    privacyKey: Buffer.alloc(32, 11)
  });
  try {
    assert.equal(state.claimEvent("message:old"), true);
    assert.equal(state.completeEvent("message:old"), true);
    now = "2026-06-01T00:00:00.001Z";
    assert.equal(state.claimEvent("message:new"), true);
    assert.equal(state.claimEvent("message:old"), true);
  } finally {
    state.close();
  }
});

test("受控维护清除已完成和已过期游标但保留活跃游标与真实事件", () => {
  const file = databasePath();
  const state = new RuntimeState(file, {
    clock: () => "2026-06-24T01:00:00.000Z"
  });
  try {
    const insert = state.database.prepare(`
      INSERT INTO processed_events (
        event_id, status, claimed_at, claim_expires_at, completed_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    insert.run(
      state.eventKey("checkpoint:oc_legacy:1"),
      "complete",
      "2026-06-24T00:00:00.000Z",
      "2026-06-24T00:00:00.000Z",
      "2026-06-24T00:00:00.000Z"
    );
    insert.run(
      state.eventKey("checkpoint:oc_expired:1"),
      "claimed",
      "2026-06-24T00:00:00.000Z",
      "2026-06-24T00:30:00.000Z",
      null
    );
    insert.run(
      state.eventKey("checkpoint:oc_active:1"),
      "claimed",
      "2026-06-24T00:00:00.000Z",
      "2026-06-24T02:00:00.000Z",
      null
    );
    insert.run(
      state.eventKey("message:om_kept"),
      "complete",
      "2026-06-24T00:00:00.000Z",
      "2026-06-24T00:00:00.000Z",
      "2026-06-24T00:00:00.000Z"
    );
    assert.deepEqual(state.maintainProcessedEvents({ force: true }), { ran: true, deleted: 2 });
    assert.equal(state.claimEvent("checkpoint:oc_legacy:1"), true);
    assert.equal(state.releaseEvent("checkpoint:oc_legacy:1"), true);
    assert.equal(state.claimEvent("checkpoint:oc_expired:1"), true);
    assert.equal(state.releaseEvent("checkpoint:oc_expired:1"), true);
    assert.equal(state.claimEvent("checkpoint:oc_active:1"), false);
    assert.equal(state.claimEvent("message:om_kept"), false);
  } finally {
    state.close();
  }
});

test("延迟到达的旧补读批次不能让聊天游标回退", () => {
  const state = new RuntimeState(databasePath(), {
    clock: () => "2026-06-24T01:00:00.000Z"
  });
  try {
    state.setSupplementCheckpoint("oc_1", "2026-06-24T08:05:00.000+08:00");
    state.setSupplementCheckpoint("oc_1", "2026-06-24T00:04:00.000Z");
    assert.equal(
      state.getSupplementCheckpoint("oc_1"),
      "2026-06-24T00:05:00.000Z"
    );
    state.setSupplementCheckpoint("oc_1", "2026-06-24T08:06:00.000+08:00");
    assert.equal(
      state.getSupplementCheckpoint("oc_1"),
      "2026-06-24T00:06:00.000Z"
    );
  } finally {
    state.close();
  }
});

test("统一维护会清理超过三十天未活跃的补读游标并保留边界与近期游标", () => {
  const state = new RuntimeState(databasePath(), {
    clock: () => "2026-07-24T00:00:00.000Z"
  });
  try {
    state.setSupplementCheckpoint("oc_inactive", "2026-06-23T23:59:59.999Z");
    state.setSupplementCheckpoint("oc_boundary", "2026-06-24T00:00:00.000Z");
    state.setSupplementCheckpoint("oc_recent", "2026-07-23T00:00:00.000Z");

    state.maintainState({ force: true });

    assert.equal(state.getSupplementCheckpoint("oc_inactive"), null);
    assert.equal(
      state.getSupplementCheckpoint("oc_boundary"),
      "2026-06-24T00:00:00.000Z"
    );
    assert.equal(
      state.getSupplementCheckpoint("oc_recent"),
      "2026-07-23T00:00:00.000Z"
    );
  } finally {
    state.close();
  }
});

test("日报锁过期接管后旧进程不能续租或释放新进程的锁", () => {
  let now = "2026-07-16T10:00:00.000Z";
  const state = new RuntimeState(databasePath(), {
    clock: () => now,
    dailyMemoryLockTtlMs: 5 * 60 * 1000
  });
  try {
    assert.equal(state.claimDailyMemoryRun("2026-07-16", "owner-1"), true);
    assert.equal(state.claimDailyMemoryRun("2026-07-16", "owner-2"), false);

    now = "2026-07-16T10:06:00.000Z";
    assert.equal(state.claimDailyMemoryRun("2026-07-16", "owner-2"), true);
    assert.equal(state.renewDailyMemoryRun("2026-07-16", "owner-1"), false);
    assert.equal(state.releaseDailyMemoryRun("2026-07-16", "owner-1"), false);
    assert.equal(state.renewDailyMemoryRun("2026-07-16", "owner-2"), true);
  } finally {
    state.close();
  }
});

test("官方私有事件确认只验证操作者、动作绑定、时效和单次消费", () => {
  let now = "2026-07-16T10:00:00.000Z";
  const state = new RuntimeState(databasePath(), { clock: () => now });
  try {
    state.createConfirmation({
      confirmation_id: "confirm-1",
      action_hash: "b".repeat(64),
      operator_open_id: "ou_principal",
      expires_at: "2026-07-16T10:05:00.000Z",
      requires_yes: true,
      action: { argv: ["drive", "+delete", "--token", "file_x"] },
      reason: "删除文件"
    });
    assert.equal(state.getConfirmation("confirm-1").requires_yes, true);

    assert.deepEqual(state.resolveConfirmation({
      confirmation_id: "confirm-1",
      action_hash: "b".repeat(64),
      operator_open_id: "ou_other",
      event_id: "callback-wrong",
      decision: "approve"
    }), { accepted: false, reason: "OPERATOR_MISMATCH" });

    assert.deepEqual(state.resolveConfirmation({
      confirmation_id: "confirm-1",
      action_hash: "b".repeat(64),
      operator_open_id: "ou_principal",
      event_id: "callback-1",
      decision: "approve"
    }), { accepted: true, status: "approved" });
    state.expireConfirmations();
    assert.equal(state.getConfirmation("confirm-1").action, null);
    assert.equal(state.getConfirmation("confirm-1").reason, null);

    assert.deepEqual(state.resolveConfirmation({
      confirmation_id: "confirm-1",
      action_hash: "b".repeat(64),
      operator_open_id: "ou_principal",
      event_id: "callback-2",
      decision: "approve"
    }), { accepted: false, reason: "ALREADY_RESOLVED" });

    state.createConfirmation({
      confirmation_id: "confirm-2",
      action_hash: "c".repeat(64),
      operator_open_id: "ou_principal",
      expires_at: "2026-07-16T10:05:00.000Z",
      action: { argv: ["task", "+create", "--summary", "过期事项"] },
      reason: "过期事项"
    });
    now = "2026-07-16T10:06:00.000Z";
    assert.deepEqual(state.resolveConfirmation({
      confirmation_id: "confirm-2",
      action_hash: "c".repeat(64),
      operator_open_id: "ou_principal",
      event_id: "callback-expired",
      decision: "approve"
    }), { accepted: false, reason: "EXPIRED" });
    assert.equal(state.getConfirmation("confirm-2").action, null);
    assert.equal(state.getConfirmation("confirm-2").reason, null);
  } finally {
    state.close();
  }
});

test("能力动作确认只保存公开动作引用并按 action_id 单次消费", () => {
  const file = databasePath();
  let now = "2026-07-16T10:00:00.000Z";
  const state = new RuntimeState(file, {
    clock: () => now,
    privacyKey: Buffer.alloc(32, 13)
  });
  try {
    state.createConfirmation({
      confirmation_id: "confirm-capability-1",
      kind: "capability",
      action_id: "action-public-1",
      operator_open_id: "ou_principal",
      expires_at: "2026-07-16T10:05:00.000Z",
      reason: "审批动作待本人确认",
      source_event_id: "evt_source",
      source_chat_id: "oc_source",
      source_message_id: "om_source",
      confirmation_token: "private-oa-token",
      confirmation_phrase: "private-oa-phrase",
      confirm_tool: "approval.confirm"
    });

    const confirmation = state.getConfirmation("confirm-capability-1");
    assert.equal(confirmation.kind, "capability");
    assert.equal(confirmation.action_id, "action-public-1");
    assert.equal(confirmation.action, null);

    const database = new DatabaseSync(file, { readOnly: true });
    const persisted = database.prepare(`
      SELECT * FROM confirmations WHERE confirmation_id = ?
    `).get("confirm-capability-1");
    database.close();
    assert.deepEqual({
      kind: persisted.kind,
      action_id: persisted.action_id,
      action_json: persisted.action_json
    }, {
      kind: "capability",
      action_id: "action-public-1",
      action_json: null
    });
    assert.doesNotMatch(
      JSON.stringify(persisted),
      /private-oa-token|private-oa-phrase|approval\.confirm/u
    );

    assert.deepEqual(state.resolveConfirmation({
      confirmation_id: "confirm-capability-1",
      action_id: "action-forged",
      operator_open_id: "ou_principal",
      event_id: "callback-forged",
      decision: "approve"
    }), { accepted: false, reason: "ACTION_MISMATCH" });
    assert.deepEqual(state.resolveConfirmation({
      confirmation_id: "confirm-capability-1",
      action_id: "action-public-1",
      operator_open_id: "ou_other",
      event_id: "callback-wrong-operator",
      decision: "approve"
    }), { accepted: false, reason: "OPERATOR_MISMATCH" });
    assert.deepEqual(state.resolveConfirmation({
      confirmation_id: "confirm-capability-1",
      action_id: "action-public-1",
      operator_open_id: "ou_principal",
      event_id: "callback-capability-1",
      decision: "approve"
    }), { accepted: true, status: "approved" });
    assert.deepEqual(state.resolveConfirmation({
      confirmation_id: "confirm-capability-1",
      action_id: "action-public-1",
      operator_open_id: "ou_principal",
      event_id: "callback-capability-1",
      decision: "approve"
    }), { accepted: false, reason: "DUPLICATE_EVENT" });
    assert.deepEqual(state.resolveConfirmation({
      confirmation_id: "confirm-capability-1",
      action_id: "action-public-1",
      operator_open_id: "ou_principal",
      event_id: "callback-capability-replay",
      decision: "approve"
    }), { accepted: false, reason: "ALREADY_RESOLVED" });

    state.createConfirmation({
      confirmation_id: "confirm-capability-expired",
      kind: "capability",
      action_id: "action-public-expired",
      operator_open_id: "ou_principal",
      expires_at: "2026-07-16T10:05:00.000Z"
    });
    now = "2026-07-16T10:06:00.000Z";
    assert.deepEqual(state.resolveConfirmation({
      confirmation_id: "confirm-capability-expired",
      action_id: "action-public-expired",
      operator_open_id: "ou_principal",
      event_id: "callback-capability-expired",
      decision: "approve"
    }), { accepted: false, reason: "EXPIRED" });
  } finally {
    state.close();
  }
});

test("能力动作确认拒绝持久化命令载荷且旧命令确认默认兼容", () => {
  const state = new RuntimeState(databasePath(), {
    clock: () => "2026-07-16T10:00:00.000Z"
  });
  try {
    assert.throws(() => state.createConfirmation({
      confirmation_id: "confirm-capability-secret",
      kind: "capability",
      action_id: "action-public-secret-test",
      operator_open_id: "ou_principal",
      expires_at: "2026-07-16T10:05:00.000Z",
      action: {
        argv: ["approval.confirm", "--token", "private-token", "--phrase", "private-phrase"]
      }
    }), /capability confirmation cannot store a command action/u);
    assert.equal(state.getConfirmation("confirm-capability-secret"), null);

    state.createConfirmation({
      confirmation_id: "confirm-command-compatible",
      action_hash: "d".repeat(64),
      operator_open_id: "ou_principal",
      expires_at: "2026-07-16T10:05:00.000Z",
      action: { argv: ["task", "+create"] }
    });
    const command = state.getConfirmation("confirm-command-compatible");
    assert.equal(command.kind, "command");
    assert.equal(command.action_hash, "d".repeat(64));
    assert.equal(command.action_id, null);
    assert.deepEqual(command.action, { argv: ["task", "+create"] });
    assert.deepEqual(state.resolveConfirmation({
      confirmation_id: "confirm-command-compatible",
      action_hash: "d".repeat(64),
      operator_open_id: "ou_principal",
      event_id: "callback-command-compatible",
      decision: "reject"
    }), { accepted: true, status: "rejected" });
  } finally {
    state.close();
  }
});

test("旧状态库中的命令确认行迁移后默认保持 command 类型", () => {
  const file = databasePath();
  const privacyKey = Buffer.alloc(32, 15);
  const initialized = new RuntimeState(file, { privacyKey });
  initialized.close();

  const legacy = new DatabaseSync(file);
  legacy.exec(`
    DROP TABLE confirmations;
    CREATE TABLE confirmations (
      confirmation_id TEXT PRIMARY KEY,
      action_hash TEXT NOT NULL,
      operator_open_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      action_json TEXT,
      reason TEXT,
      requires_yes INTEGER NOT NULL DEFAULT 0 CHECK (requires_yes IN (0, 1)),
      source_event_id TEXT,
      source_chat_id TEXT,
      source_message_id TEXT,
      source_reply_identity TEXT NOT NULL DEFAULT 'user'
        CHECK (source_reply_identity IN ('user', 'bot')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_event_id TEXT
    );
  `);
  legacy.prepare(`
    INSERT INTO confirmations (
      confirmation_id, action_hash, operator_open_id, expires_at, action_json,
      status, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    "confirm-legacy-command",
    "e".repeat(64),
    "operator_legacy_projected",
    "2026-07-16T10:05:00.000Z",
    JSON.stringify({ argv: ["task", "+create"] }),
    "2026-07-16T10:00:00.000Z"
  );
  legacy.close();

  const migrated = new RuntimeState(file, {
    clock: () => "2026-07-16T10:00:00.000Z",
    privacyKey
  });
  try {
    const confirmation = migrated.getConfirmation("confirm-legacy-command");
    assert.equal(confirmation.kind, "command");
    assert.equal(confirmation.action_hash, "e".repeat(64));
    assert.equal(confirmation.action_id, null);
    assert.deepEqual(confirmation.action, { argv: ["task", "+create"] });
  } finally {
    migrated.close();
  }
});

test("短暂的 SQLite 写锁会等待释放而不是立即失败", async () => {
  const file = databasePath();
  const state = new RuntimeState(file, {
    clock: () => "2026-07-16T10:00:00.000Z"
  });
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(workerData);
    database.exec("BEGIN IMMEDIATE");
    parentPort.postMessage("locked");
    setTimeout(() => {
      database.exec("COMMIT");
      database.close();
      parentPort.postMessage("released");
    }, 150);
  `, { eval: true, workerData: file });
  try {
    const [message] = await once(worker, "message");
    assert.equal(message, "locked");
    const startedAt = Date.now();
    assert.equal(state.setFrozen(true, "CONCURRENT_TEST").frozen, true);
    assert.ok(Date.now() - startedAt >= 100);
    await once(worker, "exit");
  } finally {
    await worker.terminate();
    state.close();
  }
});
