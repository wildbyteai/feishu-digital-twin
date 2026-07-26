import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DEFAULT_REQUIRED_IGNORED_PATHS,
  auditGitIsolation,
  auditPrivateState,
  cleanupTemporaryAuthArtifacts,
  compareContinuityBaseline,
  createContinuityBaseline,
  evaluateContinuityHealth,
  hardenPrivateStatePermissions,
  runControlledChange
} from "../../ops/continuity-gate.mjs";
import {
  createLocalContinuityAdapters,
  runLocalContinuityCheck,
  validateContinuityManifest
} from "../../ops/local-continuity.mjs";
import { runIsolatedContinuityExercise } from "../../ops/continuity-exercise.mjs";
import { createIsolatedTestEnvironment } from "../../ops/isolated-test-environment.mjs";
import { readRuntimeHealthSnapshot } from "../../runtime/src/runtime-health-snapshot.mjs";

test("私有运行态目录和敏感文件权限不符合 0700/0600 时失败关闭", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "twin-private-state-"));
  const runtimeRoot = path.join(projectRoot, ".runtime");
  const workbuddyRoot = path.join(projectRoot, ".workbuddy");
  mkdirSync(runtimeRoot, { mode: 0o755 });
  mkdirSync(workbuddyRoot, { mode: 0o755 });
  writeFileSync(path.join(runtimeRoot, "config.json"), "secret-body", { mode: 0o644 });
  writeFileSync(path.join(workbuddyRoot, "memory.md"), "private-memory", { mode: 0o644 });

  const manifest = {
    private_roots: [
      { role: "runtime", path: ".runtime", required: true, protect_all_files: true },
      { role: "workbuddy", path: ".workbuddy", required: true, protect_all_files: true }
    ]
  };
  const failed = await auditPrivateState(manifest, { projectRoot });

  assert.equal(failed.healthy, false);
  assert.deepEqual(
    [...new Set(failed.violations.map((violation) => violation.code))].sort(),
    ["directory-mode", "sensitive-file-mode"]
  );
  assert.doesNotMatch(JSON.stringify(failed), /secret-body|private-memory/u);

  chmodSync(runtimeRoot, 0o700);
  chmodSync(workbuddyRoot, 0o700);
  chmodSync(path.join(runtimeRoot, "config.json"), 0o600);
  chmodSync(path.join(workbuddyRoot, "memory.md"), 0o600);

  const passed = await auditPrivateState(manifest, { projectRoot });
  assert.equal(passed.healthy, true);
  assert.deepEqual(passed.violations, []);
});

test("授权完成后私有运行目录仍残留临时二维码时失败关闭", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "twin-private-auth-"));
  const runtimeRoot = path.join(projectRoot, ".runtime");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  writeFileSync(path.join(runtimeRoot, "calendar-auth-qr.png"), "temporary", { mode: 0o600 });
  writeFileSync(path.join(runtimeRoot, "fixture-base-oauth.png"), "temporary", { mode: 0o600 });

  const report = await auditPrivateState({
    authorization_complete: true,
    private_roots: [{
      role: "runtime",
      path: ".runtime",
      required: true,
      protect_all_files: true,
      cleanup_temporary_auth_artifacts: true
    }]
  }, { projectRoot });

  assert.equal(report.healthy, false);
  assert.equal(report.temporary_auth_artifact_count, 2);
  assert.equal(
    report.violations.some((violation) => violation.code === "temporary-auth-artifact-present"),
    true
  );
});

test("Codex 私有根只强制凭据和状态文件为 0600，不破坏普通 Skill 文件", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "twin-private-codex-"));
  const codexRoot = path.join(projectRoot, ".codex-runtime");
  mkdirSync(path.join(codexRoot, "skills"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(codexRoot, "auth.json"), "credential", { mode: 0o644 });
  writeFileSync(path.join(codexRoot, "state.sqlite"), "state", { mode: 0o600 });
  writeFileSync(path.join(codexRoot, "skills", "SKILL.md"), "public instructions", { mode: 0o644 });
  const manifest = {
    private_roots: [{
      role: "codex",
      path: ".codex-runtime",
      required: true,
      sensitive_basenames: ["auth.json", "config.toml"],
      sensitive_suffixes: [".sqlite", ".sqlite-shm", ".sqlite-wal", ".log"]
    }]
  };

  const failed = await auditPrivateState(manifest, { projectRoot });
  assert.equal(failed.healthy, false);
  assert.equal(failed.sensitive_file_count, 2);
  assert.equal(failed.violations.length, 1);

  chmodSync(path.join(codexRoot, "auth.json"), 0o600);
  const passed = await auditPrivateState(manifest, { projectRoot });
  assert.equal(passed.healthy, true);
});

test("Codex 一次性运行目录在审计途中消失时不误报整个私有根损坏", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "twin-private-codex-race-"));
  const codexRoot = path.join(projectRoot, ".codex-runtime");
  mkdirSync(codexRoot, { mode: 0o700 });
  const resolvedCodexRoot = await fsPromises.realpath(codexRoot);
  const disappearingEntry = path.join(resolvedCodexRoot, ".run-disappeared");
  let disappearingEntryInspected = false;
  const filesystem = {
    lstat: async (target) => {
      if (target === disappearingEntry) {
        disappearingEntryInspected = true;
        const error = new Error("simulated transient removal");
        error.code = "ENOENT";
        throw error;
      }
      return fsPromises.lstat(target);
    },
    readdir: async (target) => target === resolvedCodexRoot
      ? [...await fsPromises.readdir(target), path.basename(disappearingEntry)]
      : fsPromises.readdir(target),
    realpath: (target) => fsPromises.realpath(target)
  };

  const report = await auditPrivateState({
    private_roots: [{ role: "codex", path: ".codex-runtime", required: true }]
  }, { projectRoot, filesystem });

  assert.equal(disappearingEntryInspected, true);
  assert.equal(report.healthy, true);
  assert.deepEqual(report.violations, []);
});

test("私有根允许解析后仍在根内的依赖链接，但拒绝逃逸到根外", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "twin-private-links-"));
  const privateRoot = path.join(projectRoot, ".codex-runtime");
  mkdirSync(path.join(privateRoot, "package", "bin"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(privateRoot, "package", "bin", "cli.mjs"), "", { mode: 0o644 });
  symlinkSync("package/bin/cli.mjs", path.join(privateRoot, "internal-cli"));
  const manifest = {
    private_roots: [{ role: "codex", path: ".codex-runtime", required: true }]
  };

  const internal = await auditPrivateState(manifest, { projectRoot });
  assert.equal(internal.healthy, true);
  assert.equal(internal.internal_symlink_count, 1);

  writeFileSync(path.join(projectRoot, "outside"), "", { mode: 0o600 });
  symlinkSync("../outside", path.join(privateRoot, "outside-link"));
  const escaped = await auditPrivateState(manifest, { projectRoot });
  assert.equal(escaped.healthy, false);
  assert.equal(
    escaped.violations.some((violation) => violation.code === "private-state-symlink-escape"),
    true
  );
});

test("Codex arg0 官方助手缓存允许固定工具链接指向私有根外", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "twin-codex-arg0-cache-"));
  const codexRoot = path.join(projectRoot, ".codex-runtime");
  const cacheRoot = path.join(
    codexRoot,
    "codex-home",
    "tmp",
    "arg0",
    "codex-arg0Fixture"
  );
  const assistantRoot = mkdtempSync(path.join(tmpdir(), "twin-codex-assistant-"));
  const assistantExecutable = path.join(assistantRoot, "codex");
  mkdirSync(cacheRoot, { recursive: true, mode: 0o755 });
  writeFileSync(assistantExecutable, "official assistant executable", { mode: 0o755 });
  writeFileSync(path.join(cacheRoot, ".lock"), "", { mode: 0o600 });
  for (const helper of ["applypatch", "apply_patch", "codex-execve-wrapper"]) {
    symlinkSync(assistantExecutable, path.join(cacheRoot, helper));
  }
  const manifest = {
    private_roots: [{ role: "codex", path: ".codex-runtime", required: true }]
  };

  const auditedBefore = await auditPrivateState(manifest, { projectRoot });
  assert.equal(auditedBefore.healthy, false);
  assert.equal(
    auditedBefore.violations.every((violation) => violation.code === "directory-mode"),
    true
  );

  const hardened = await hardenPrivateStatePermissions(manifest, { projectRoot });
  const auditedAfter = await auditPrivateState(manifest, { projectRoot });

  assert.equal(hardened.changed_directory_count > 0, true);
  assert.equal(auditedAfter.healthy, true);
  assert.deepEqual(auditedAfter.violations, []);
});

test("Codex arg0 固定助手名称以外的外链仍然失败关闭", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "twin-codex-other-link-"));
  const codexRoot = path.join(projectRoot, ".codex-runtime");
  const otherCache = path.join(
    codexRoot,
    "codex-home",
    "tmp",
    "arg0",
    "codex-arg0Fixture"
  );
  const outsideRoot = mkdtempSync(path.join(tmpdir(), "twin-codex-other-target-"));
  const outsideExecutable = path.join(outsideRoot, "codex");
  mkdirSync(otherCache, { recursive: true, mode: 0o700 });
  writeFileSync(outsideExecutable, "outside executable", { mode: 0o755 });
  symlinkSync(outsideExecutable, path.join(otherCache, "unapproved-helper"));
  const manifest = {
    private_roots: [{ role: "codex", path: ".codex-runtime", required: true }]
  };

  const audited = await auditPrivateState(manifest, { projectRoot });

  assert.equal(audited.healthy, false);
  assert.equal(
    audited.violations.some((violation) => violation.code === "private-state-symlink-escape"),
    true
  );
  await assert.rejects(
    () => hardenPrivateStatePermissions(manifest, { projectRoot }),
    /private state contains an escaping symlink/u
  );
});

test("Codex arg0 同名助手指向非 Codex 目标时仍然失败关闭", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "twin-codex-untrusted-target-"));
  const codexRoot = path.join(projectRoot, ".codex-runtime");
  const cacheRoot = path.join(
    codexRoot,
    "codex-home",
    "tmp",
    "arg0",
    "codex-arg0Fixture"
  );
  const outsideRoot = mkdtempSync(path.join(tmpdir(), "twin-codex-untrusted-executable-"));
  const outsideExecutable = path.join(outsideRoot, "not-codex");
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  writeFileSync(outsideExecutable, "untrusted executable", { mode: 0o755 });
  writeFileSync(path.join(cacheRoot, ".lock"), "", { mode: 0o600 });
  for (const helper of ["applypatch", "apply_patch", "codex-execve-wrapper"]) {
    symlinkSync(outsideExecutable, path.join(cacheRoot, helper));
  }
  const manifest = {
    private_roots: [{ role: "codex", path: ".codex-runtime", required: true }]
  };

  const audited = await auditPrivateState(manifest, { projectRoot });

  assert.equal(audited.healthy, false);
  assert.equal(
    audited.violations.some((violation) => violation.code === "private-state-symlink-escape"),
    true
  );
  await assert.rejects(
    () => hardenPrivateStatePermissions(manifest, { projectRoot }),
    /private state contains an escaping symlink/u
  );
});

test("敏感名称的根内符号链接不能绕过权限或授权图清理", async () => {
  const codexProject = mkdtempSync(path.join(tmpdir(), "twin-sensitive-link-"));
  const codexRoot = path.join(codexProject, ".codex-runtime");
  mkdirSync(path.join(codexRoot, "package"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(codexRoot, "package", "data"), "credential", { mode: 0o644 });
  symlinkSync("package/data", path.join(codexRoot, "auth.json"));
  const codexManifest = {
    private_roots: [{ role: "codex", path: ".codex-runtime", required: true }]
  };

  const codexAudit = await auditPrivateState(codexManifest, { projectRoot: codexProject });
  assert.equal(codexAudit.healthy, false);
  assert.equal(
    codexAudit.violations.some((violation) => violation.code === "sensitive-file-symlink"),
    true
  );
  await assert.rejects(
    () => hardenPrivateStatePermissions(codexManifest, { projectRoot: codexProject }),
    /sensitive private state must not use symbolic links/u
  );

  const runtimeProject = mkdtempSync(path.join(tmpdir(), "twin-auth-link-"));
  const runtimeRoot = path.join(runtimeProject, ".runtime");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  const retainedTarget = path.join(runtimeRoot, "qr-data");
  const authLink = path.join(runtimeRoot, "authorization-qr.png");
  writeFileSync(retainedTarget, "temporary", { mode: 0o600 });
  symlinkSync("qr-data", authLink);
  const runtimeAudit = await auditPrivateState({
    authorization_complete: true,
    private_roots: [{ role: "runtime", path: ".runtime", required: true }]
  }, { projectRoot: runtimeProject });
  assert.equal(runtimeAudit.healthy, false);
  assert.equal(runtimeAudit.temporary_auth_artifact_count, 1);

  const cleaned = await cleanupTemporaryAuthArtifacts({
    projectRoot: runtimeProject,
    privateRoots: [".runtime"]
  });
  assert.equal(cleaned.removed_count, 1);
  assert.equal(cleaned.skipped_symlink_count, 0);
  assert.equal(existsSync(authLink), false);
  assert.equal(existsSync(retainedTarget), true);
});

test("任何服务探针前先拒绝私有根或日志的符号链接逃逸", async () => {
  const createManifest = (runtimePath = ".runtime") => ({
    schema_version: 1,
    state_database: `${runtimePath}/state.sqlite`,
    private_roots: [
      { role: "runtime", path: runtimePath },
      { role: "codex", path: ".codex-runtime" },
      { role: "workbuddy", path: ".workbuddy" }
    ],
    policy: {
      supplement_max_age_seconds: 600,
      daily_memory_max_age_seconds: 129600
    },
    services: [
      {
        role: "realtime",
        label: "event",
        signal_log: `${runtimePath}/event.stderr.log`,
        result_log: `${runtimePath}/event.stdout.log`
      },
      {
        role: "supplement",
        label: "supplement",
        signal_log: `${runtimePath}/supplement.stderr.log`,
        result_log: `${runtimePath}/supplement.stdout.log`
      },
      {
        role: "daily_memory",
        label: "daily",
        signal_log: `${runtimePath}/daily-memory.stderr.log`,
        result_log: `${runtimePath}/daily-memory.stdout.log`
      }
    ]
  });
  const assertRejectedBeforeProbe = async (projectRoot, manifest) => {
    let probeCount = 0;
    const probe = async () => {
      probeCount += 1;
      return {};
    };
    await assert.rejects(
      () => runLocalContinuityCheck(manifest, {
        projectRoot,
        adapters: {
          probeService: probe,
          probeRuntimeState: probe,
          probeGit: probe
        }
      }),
      /private state path containment check failed/u
    );
    assert.equal(probeCount, 0);
  };

  const logProject = mkdtempSync(path.join(tmpdir(), "twin-log-link-"));
  for (const directory of [".runtime", ".codex-runtime", ".workbuddy"]) {
    mkdirSync(path.join(logProject, directory), { mode: 0o700 });
  }
  const outsideLog = path.join(logProject, "outside.log");
  writeFileSync(outsideLog, "private body", { mode: 0o600 });
  symlinkSync("../outside.log", path.join(logProject, ".runtime", "event.stderr.log"));
  await assertRejectedBeforeProbe(logProject, createManifest());

  const sensitiveProject = mkdtempSync(path.join(tmpdir(), "twin-sensitive-probe-link-"));
  for (const directory of [".runtime", ".codex-runtime", ".workbuddy"]) {
    mkdirSync(path.join(sensitiveProject, directory), { mode: 0o700 });
  }
  writeFileSync(path.join(sensitiveProject, ".runtime", "safe.log"), "private body", {
    mode: 0o600
  });
  symlinkSync("safe.log", path.join(sensitiveProject, ".runtime", "event.stderr.log"));
  await assertRejectedBeforeProbe(sensitiveProject, createManifest());

  const rootProject = mkdtempSync(path.join(tmpdir(), "twin-root-link-"));
  const outsideRoot = mkdtempSync(path.join(tmpdir(), "twin-outside-root-"));
  mkdirSync(path.join(outsideRoot, "runtime"), { mode: 0o700 });
  symlinkSync(outsideRoot, path.join(rootProject, "private"));
  for (const directory of [".codex-runtime", ".workbuddy"]) {
    mkdirSync(path.join(rootProject, directory), { mode: 0o700 });
  }
  await assertRejectedBeforeProbe(rootProject, createManifest("private/runtime"));
});

test("权限加固只收紧目录和敏感文件，不改普通 Skill 文件模式", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "twin-private-harden-"));
  const codexRoot = path.join(projectRoot, ".codex-runtime");
  mkdirSync(path.join(codexRoot, "skills"), { recursive: true, mode: 0o755 });
  writeFileSync(path.join(codexRoot, "auth.json"), "credential", { mode: 0o644 });
  const skill = path.join(codexRoot, "skills", "SKILL.md");
  writeFileSync(skill, "instructions", { mode: 0o644 });
  const manifest = {
    private_roots: [{
      role: "codex",
      path: ".codex-runtime",
      required: true,
      sensitive_basenames: ["auth.json"]
    }]
  };

  const result = await hardenPrivateStatePermissions(manifest, { projectRoot });
  const audited = await auditPrivateState(manifest, { projectRoot });

  assert.equal(result.changed_directory_count > 0, true);
  assert.equal(result.changed_file_count, 1);
  assert.equal(audited.healthy, true);
  assert.equal(statSync(skill).mode & 0o777, 0o644);
});

test("Git 二次路径检查拒绝已跟踪私有状态且要求本地秘密路径被忽略", () => {
  const requiredIgnoredPaths = [
    ".runtime/config.json",
    ".codex-runtime/codex-home/auth.json",
    ".workbuddy/memory/example.md",
    "config.local.json",
    ".env"
  ];
  const failed = auditGitIsolation({
    trackedPaths: [
      "config.example.json",
      ".workbuddy/memory/real.md",
      "deploy/private/service-account.json",
      "deploy/fixture-base-oauth.png",
      "custom-private-root/memory.md"
    ],
    ignoredPaths: requiredIgnoredPaths.filter((entry) => entry !== ".env"),
    requiredIgnoredPaths,
    privateRootPaths: ["custom-private-root"]
  });

  assert.equal(failed.healthy, false);
  assert.deepEqual(
    failed.violations.map((violation) => violation.code).sort(),
    [
      "required-path-not-ignored",
      "sensitive-tracked-path",
      "sensitive-tracked-path",
      "sensitive-tracked-path",
      "sensitive-tracked-path"
    ]
  );
  assert.equal(
    failed.violations.some((violation) => violation.location === "config.example.json"),
    false
  );

  const passed = auditGitIsolation({
    trackedPaths: ["config.example.json", "deploy/launchd/service.plist.template"],
    ignoredPaths: requiredIgnoredPaths,
    requiredIgnoredPaths
  });
  assert.equal(passed.healthy, true);
});

test("退出码为零但补读游标陈旧时仍判定服务不健康", () => {
  const now = "2026-07-21T08:00:00.000Z";
  const snapshot = {
    captured_at: now,
    services: {
      realtime: {
        loaded: true,
        state: "running",
        pid_present: true,
        latest_signal: "ready"
      },
      supplement: {
        loaded: true,
        state: "not running",
        last_exit_code: 0,
        latest_signal: "ready"
      },
      daily_memory: {
        loaded: true,
        state: "not running",
        last_exit_code: 0,
        last_result_parseable: true,
        last_result_has_target_date: true,
        last_result_at: "2026-07-21T00:10:00.000Z"
      }
    },
    runtime: {
      frozen: false,
      processed_complete_count: 100,
      supplement_checkpoint_count: 2,
      supplement_checkpoint_latest_at: "2026-07-21T07:59:30.000Z",
      daily_memory_expired_lock_count: 0
    }
  };
  const policy = {
    supplement_max_age_seconds: 600,
    daily_memory_max_age_seconds: 129600
  };

  const healthy = evaluateContinuityHealth(snapshot, { now, policy });
  assert.equal(healthy.healthy, true);

  const stale = evaluateContinuityHealth({
    ...snapshot,
    runtime: {
      ...snapshot.runtime,
      supplement_checkpoint_latest_at: "2026-07-21T07:40:00.000Z"
    }
  }, { now, policy });
  assert.equal(stale.healthy, false);
  assert.equal(
    stale.violations.some((violation) => violation.code === "supplement-checkpoint-stale"),
    true
  );
  assert.equal(stale.services.supplement.last_exit_ok, true);

  const future = evaluateContinuityHealth({
    ...snapshot,
    runtime: {
      ...snapshot.runtime,
      supplement_checkpoint_latest_at: "2026-07-21T08:10:00.000Z"
    }
  }, { now, policy });
  assert.equal(future.healthy, false);
  assert.equal(
    future.violations.some((violation) => violation.code === "supplement-checkpoint-in-future"),
    true
  );
});

test("前后基线比较拒绝冻结状态或去重进度倒退", () => {
  const report = {
    schema_version: 1,
    captured_at: "2026-07-21T08:00:00.000Z",
    healthy: true,
    services: {
      realtime: { healthy: true },
      supplement: {
        checkpoint_latest_at: "2026-07-21T07:59:30.000Z"
      },
      daily_memory: {
        result_at: "2026-07-21T00:10:00.000Z"
      }
    },
    runtime: {
      frozen: false,
      processed_complete_count: 100
    }
  };
  const baseline = createContinuityBaseline(report);
  assert.equal(JSON.stringify(baseline).includes("label"), false);

  const unchanged = compareContinuityBaseline(baseline, report);
  assert.equal(unchanged.healthy, true);

  const regressed = compareContinuityBaseline(baseline, {
    ...report,
    runtime: {
      frozen: true,
      processed_complete_count: 99
    }
  });
  assert.equal(regressed.healthy, false);
  assert.deepEqual(
    regressed.violations.map((violation) => violation.code).sort(),
    ["freeze-state-changed", "processed-count-regressed"]
  );
});

test("基线比较拒绝实时重启循环、错误增量和重复执行增量", () => {
  const report = {
    schema_version: 1,
    captured_at: "2026-07-21T08:00:00.000Z",
    healthy: true,
    services: {
      realtime: {
        runs: 10,
        error_signal_count: 2,
        result_parse_error_count: 0,
        duplicate_successful_execution_count: 0,
        successful_execution_without_hash_count: 0,
        failed_execution_count: 1
      },
      supplement: {
        runs: 100,
        checkpoint_latest_at: "2026-07-21T07:59:30.000Z",
        error_signal_count: 0,
        result_parse_error_count: 0,
        duplicate_successful_execution_count: 0,
        successful_execution_without_hash_count: 0,
        failed_execution_count: 2
      },
      daily_memory: {
        runs: 5,
        result_at: "2026-07-21T00:10:00.000Z",
        error_signal_count: 0,
        duplicate_successful_execution_count: 0,
        successful_execution_without_hash_count: 0,
        failed_execution_count: 0
      }
    },
    runtime: {
      frozen: false,
      processed_complete_count: 100
    }
  };
  const baseline = createContinuityBaseline(report);
  const failed = compareContinuityBaseline(baseline, {
    ...report,
    captured_at: "2026-07-21T08:05:00.000Z",
    services: {
      ...report.services,
      realtime: {
        ...report.services.realtime,
        runs: 12,
        error_signal_count: 3,
        duplicate_successful_execution_count: 1
      },
      supplement: { ...report.services.supplement, runs: 120 },
      daily_memory: { ...report.services.daily_memory, runs: 8 }
    }
  });

  assert.equal(failed.healthy, false);
  assert.deepEqual(
    failed.violations.map((violation) => violation.code).sort(),
    [
      "daily-memory-run-count-excessive",
      "realtime-duplicate-success-increased",
      "realtime-error-signal-increased",
      "realtime-run-count-increased",
      "supplement-run-count-excessive"
    ]
  );

  const onePlannedReload = compareContinuityBaseline(baseline, {
    ...report,
    services: {
      ...report.services,
      realtime: { ...report.services.realtime, runs: 11 }
    }
  }, { allowedRealtimeRunDelta: 1 });
  assert.equal(onePlannedReload.healthy, true);
});

test("受控变更只切换一个服务，后置失败时回退并再次验收", async () => {
  const trace = [];
  let version = 1;
  const result = await runControlledChange({
    serviceRole: "realtime",
    precheck: async () => {
      trace.push("precheck");
      return { healthy: version === 1 };
    },
    isolatedTest: async () => { trace.push("isolated-test"); },
    applyChange: async () => {
      trace.push("apply");
      version = 2;
    },
    switchService: async ({ role, phase }) => {
      assert.equal(role, "realtime");
      trace.push(`switch:${phase}`);
    },
    postcheck: async () => {
      trace.push("postcheck");
      return { healthy: false };
    },
    rollbackChange: async () => {
      trace.push("rollback");
      version = 1;
    },
    verifyRollback: async () => {
      trace.push("verify-rollback");
      return { healthy: version === 1 };
    }
  });

  assert.equal(result.status, "rolled-back");
  assert.equal(version, 1);
  assert.deepEqual(trace, [
    "precheck",
    "isolated-test",
    "apply",
    "switch:apply",
    "postcheck",
    "rollback",
    "switch:rollback",
    "verify-rollback"
  ]);
});

test("应用变更部分完成后抛错也必须回退，且不切换尚未触碰的服务", async () => {
  const trace = [];
  let version = 1;
  const result = await runControlledChange({
    serviceRole: "realtime",
    precheck: async () => ({ healthy: true }),
    isolatedTest: async () => {},
    applyChange: async () => {
      trace.push("apply");
      version = 2;
      throw new Error("partial change failed");
    },
    switchService: async ({ phase }) => { trace.push(`switch:${phase}`); },
    postcheck: async () => ({ healthy: true }),
    rollbackChange: async () => {
      trace.push("rollback");
      version = 1;
    },
    verifyRollback: async () => {
      trace.push("verify-rollback");
      return { healthy: version === 1 };
    }
  });

  assert.equal(result.status, "rolled-back");
  assert.equal(version, 1);
  assert.deepEqual(trace, ["apply", "rollback", "verify-rollback"]);
});

test("授权成功后的清理只删除私有运行根内的临时授权图", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "twin-auth-cleanup-"));
  const runtimeRoot = path.join(projectRoot, ".runtime");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  const temporaryQr = path.join(runtimeRoot, "calendar-auth-qr.png");
  const temporaryAuth = path.join(runtimeRoot, "contact-profile-auth.png");
  const temporaryOauth = path.join(runtimeRoot, "fixture-base-oauth.png");
  const retainedConfig = path.join(runtimeRoot, "config.json");
  const outsideQr = path.join(projectRoot, "outside-auth-qr.png");
  writeFileSync(temporaryQr, "temporary", { mode: 0o600 });
  writeFileSync(temporaryAuth, "temporary", { mode: 0o600 });
  writeFileSync(temporaryOauth, "temporary", { mode: 0o600 });
  writeFileSync(retainedConfig, "config", { mode: 0o600 });
  writeFileSync(outsideQr, "outside", { mode: 0o600 });

  const result = await cleanupTemporaryAuthArtifacts({
    projectRoot,
    privateRoots: [".runtime"]
  });

  assert.equal(result.removed_count, 3);
  assert.equal(existsSync(temporaryQr), false);
  assert.equal(existsSync(temporaryAuth), false);
  assert.equal(existsSync(temporaryOauth), false);
  assert.equal(existsSync(retainedConfig), true);
  assert.equal(existsSync(outsideQr), true);
  await assert.rejects(
    () => cleanupTemporaryAuthArtifacts({
      projectRoot,
      privateRoots: [".missing-runtime"]
    }),
    /temporary auth cleanup root is missing/u
  );
});

test("写入型私有状态操作拒绝通过符号链接根触碰项目外文件", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "twin-write-link-"));
  const outsideRoot = mkdtempSync(path.join(tmpdir(), "twin-write-outside-"));
  const outsideRuntime = path.join(outsideRoot, "runtime");
  mkdirSync(outsideRuntime, { mode: 0o755 });
  const outsideQr = path.join(outsideRuntime, "authorization-qr.png");
  writeFileSync(outsideQr, "outside", { mode: 0o644 });
  symlinkSync(outsideRoot, path.join(projectRoot, "private"));

  await assert.rejects(
    () => cleanupTemporaryAuthArtifacts({
      projectRoot,
      privateRoots: ["private/runtime"]
    }),
    /must stay inside the project/u
  );
  await assert.rejects(
    () => hardenPrivateStatePermissions({
      private_roots: [{ role: "runtime", path: "private/runtime" }]
    }, { projectRoot }),
    /must stay inside the project/u
  );

  assert.equal(existsSync(outsideQr), true);
  assert.equal(statSync(outsideRuntime).mode & 0o777, 0o755);
  assert.equal(statSync(outsideQr).mode & 0o777, 0o644);
});

test("本机连续性检查输出角色健康事实但不泄露服务标签或绝对路径", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "twin-local-check-"));
  mkdirSync(path.join(projectRoot, ".runtime"), { mode: 0o700 });
  mkdirSync(path.join(projectRoot, ".codex-runtime"), { mode: 0o700 });
  mkdirSync(path.join(projectRoot, ".workbuddy"), { mode: 0o700 });
  const now = "2026-07-21T08:00:00.000Z";
  const requiredIgnoredPaths = [...DEFAULT_REQUIRED_IGNORED_PATHS];
  for (const root of [".runtime", ".codex-runtime", ".workbuddy"]) {
    requiredIgnoredPaths.push(
      `${root}/.continuity-ignore-probe`,
      `${root}/nested/.continuity-ignore-probe`
    );
  }
  const manifest = {
    schema_version: 1,
    state_database: ".runtime/state.sqlite",
    private_roots: [
      { role: "runtime", path: ".runtime", required: true, protect_all_files: true },
      { role: "codex", path: ".codex-runtime", required: true },
      { role: "workbuddy", path: ".workbuddy", required: true, protect_all_files: true }
    ],
    required_ignored_paths: requiredIgnoredPaths,
    policy: {
      supplement_max_age_seconds: 600,
      daily_memory_max_age_seconds: 129600
    },
    services: [
      {
        role: "realtime",
        label: "com.private.real-name.event",
        signal_log: ".runtime/event.stderr.log",
        result_log: ".runtime/event.stdout.log"
      },
      {
        role: "supplement",
        label: "com.private.real-name.supplement",
        signal_log: ".runtime/supplement.stderr.log",
        result_log: ".runtime/supplement.stdout.log"
      },
      {
        role: "daily_memory",
        label: "com.private.real-name.daily-memory",
        signal_log: ".runtime/daily-memory.stderr.log",
        result_log: ".runtime/daily-memory.stdout.log"
      }
    ]
  };
  const report = await runLocalContinuityCheck(manifest, {
    projectRoot,
    clock: () => now,
    adapters: {
      probeService: async ({ role }) => ({
        loaded: true,
        state: role === "realtime" ? "running" : "not running",
        pid_present: role === "realtime",
        last_exit_code: 0,
        latest_signal: "ready",
        ...(role === "daily_memory" ? {
          last_result_parseable: true,
          last_result_has_target_date: true,
          last_result_at: "2026-07-21T00:10:00.000Z"
        } : {})
      }),
      probeRuntimeState: async () => ({
        frozen: false,
        processed_complete_count: 10,
        supplement_checkpoint_count: 2,
        supplement_checkpoint_latest_at: "2026-07-21T07:59:30.000Z",
        daily_memory_expired_lock_count: 0
      }),
      probeGit: async () => ({
        trackedPaths: ["config.example.json"],
        ignoredPaths: requiredIgnoredPaths
      })
    }
  });

  assert.equal(report.healthy, true);
  assert.deepEqual(Object.keys(report.services), ["realtime", "supplement", "daily_memory"]);
  assert.doesNotMatch(JSON.stringify(report), /real-name|twin-local-check|state\.sqlite/u);
});

test("Codex arg0 官方助手缓存存在时连续性检查继续执行服务探针", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "twin-codex-arg0-probe-"));
  const runtimeRoot = path.join(projectRoot, ".runtime");
  const cacheRoot = path.join(
    projectRoot,
    ".codex-runtime",
    "codex-home",
    "tmp",
    "arg0",
    "codex-arg0Probe"
  );
  const assistantRoot = mkdtempSync(path.join(tmpdir(), "twin-codex-probe-target-"));
  const assistantExecutable = path.join(assistantRoot, "codex");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  writeFileSync(assistantExecutable, "official assistant executable", { mode: 0o755 });
  writeFileSync(path.join(cacheRoot, ".lock"), "", { mode: 0o600 });
  for (const helper of ["applypatch", "apply_patch", "codex-execve-wrapper"]) {
    symlinkSync(assistantExecutable, path.join(cacheRoot, helper));
  }
  const now = "2026-07-21T08:00:00.000Z";
  const manifest = {
    schema_version: 1,
    state_database: ".runtime/state.sqlite",
    git_isolation_required: false,
    private_roots: [
      { role: "runtime", path: ".runtime", required: true, protect_all_files: true },
      { role: "codex", path: ".codex-runtime", required: true }
    ],
    policy: {
      supplement_max_age_seconds: 600,
      daily_memory_max_age_seconds: 129600
    },
    services: [
      {
        role: "realtime",
        label: "app.example.realtime",
        signal_log: ".runtime/realtime.stderr.log",
        result_log: ".runtime/realtime.stdout.log"
      },
      {
        role: "supplement",
        label: "app.example.supplement",
        signal_log: ".runtime/supplement.stderr.log",
        result_log: ".runtime/supplement.stdout.log"
      },
      {
        role: "daily_memory",
        label: "app.example.daily-memory",
        signal_log: ".runtime/daily-memory.stderr.log",
        result_log: ".runtime/daily-memory.stdout.log"
      }
    ]
  };
  let serviceProbeCount = 0;
  let runtimeProbeCount = 0;

  const report = await runLocalContinuityCheck(manifest, {
    projectRoot,
    clock: () => now,
    adapters: {
      probeService: async ({ role }) => {
        serviceProbeCount += 1;
        return {
          loaded: true,
          state: role === "realtime" ? "running" : "not running",
          pid_present: role === "realtime",
          last_exit_code: 0,
          latest_signal: "ready",
          ...(role === "daily_memory" ? {
            last_result_parseable: true,
            last_result_has_target_date: true,
            last_result_at: "2026-07-21T00:10:00.000Z"
          } : {})
        };
      },
      probeRuntimeState: async () => {
        runtimeProbeCount += 1;
        return {
          frozen: false,
          processed_complete_count: 1,
          supplement_checkpoint_count: 1,
          supplement_checkpoint_latest_at: "2026-07-21T07:59:30.000Z",
          daily_memory_expired_lock_count: 0
        };
      }
    }
  });

  assert.equal(report.healthy, true);
  assert.equal(serviceProbeCount, 3);
  assert.equal(runtimeProbeCount, 1);
});

test("正式安装实例不依赖 WorkBuddy 或 Git 仓库也能检查运行连续性", async () => {
  const installationRoot = mkdtempSync(path.join(tmpdir(), "twin-installed-check-"));
  mkdirSync(path.join(installationRoot, "private"), { mode: 0o700 });
  mkdirSync(path.join(installationRoot, "codex-home"), { mode: 0o700 });
  const now = "2026-07-21T08:00:00.000Z";
  const manifest = {
    schema_version: 1,
    state_database: "private/state.sqlite",
    git_isolation_required: false,
    private_roots: [
      { role: "runtime", path: "private", required: true, protect_all_files: true },
      { role: "codex", path: "codex-home", required: true }
    ],
    policy: {
      supplement_max_age_seconds: 600,
      daily_memory_max_age_seconds: 129600
    },
    services: [
      {
        role: "realtime",
        label: "app.example.realtime",
        signal_log: "private/realtime.stderr.log",
        result_log: "private/realtime.stdout.log"
      },
      {
        role: "supplement",
        label: "app.example.supplement",
        signal_log: "private/supplement.stderr.log",
        result_log: "private/supplement.stdout.log"
      },
      {
        role: "daily_memory",
        label: "app.example.daily-memory",
        signal_log: "private/daily-memory.stderr.log",
        result_log: "private/daily-memory.stdout.log"
      }
    ]
  };
  const adapters = {
    probeService: async ({ role }) => ({
        loaded: true,
        state: role === "realtime" ? "running" : "not running",
        pid_present: role === "realtime",
        last_exit_code: 0,
        latest_signal: "ready",
        ...(role === "daily_memory" ? {
          last_result_parseable: true,
          last_result_has_target_date: true,
          last_result_at: "2026-07-21T00:10:00.000Z"
        } : {})
      }),
    probeRuntimeState: async () => ({
        frozen: false,
        processed_complete_count: 1,
        supplement_checkpoint_count: 1,
        supplement_checkpoint_latest_at: "2026-07-21T07:59:30.000Z",
        daily_memory_expired_lock_count: 0
      })
  };
  const report = await runLocalContinuityCheck(manifest, {
    projectRoot: installationRoot,
    clock: () => now,
    adapters
  });

  assert.equal(report.healthy, true);
  assert.deepEqual(report.git_isolation, {
    checked: false,
    healthy: true,
    tracked_path_count: 0,
    required_ignored_path_count: 0
  });
  await assert.rejects(
    () => runLocalContinuityCheck(manifest, {
      projectRoot: installationRoot,
      clock: () => now,
      adapters,
      requireGitIsolation: true
    }),
    /Git isolation is required/u
  );
});

test("本机硬门不能用空私有根、空忽略清单或零新鲜度关闭", async () => {
  const base = {
    schema_version: 1,
    state_database: ".runtime/state.sqlite",
    private_roots: [],
    required_ignored_paths: [],
    policy: {
      supplement_max_age_seconds: 0,
      daily_memory_max_age_seconds: 0
    },
    services: [
      {
        role: "realtime",
        label: "event",
        signal_log: ".runtime/event.stderr.log",
        result_log: ".runtime/event.stdout.log"
      },
      {
        role: "supplement",
        label: "supplement",
        signal_log: ".runtime/supplement.stderr.log",
        result_log: ".runtime/supplement.stdout.log"
      },
      {
        role: "daily_memory",
        label: "daily",
        signal_log: ".runtime/daily-memory.stderr.log",
        result_log: ".runtime/daily-memory.stdout.log"
      }
    ]
  };
  await assert.rejects(
    () => runLocalContinuityCheck(base, {
      projectRoot: process.cwd(),
      adapters: {
        probeService: async () => ({}),
        probeRuntimeState: async () => ({}),
        probeGit: async () => ({ trackedPaths: [], ignoredPaths: [] })
      }
    }),
    /private root runtime is required/u
  );

  const projectRoot = mkdtempSync(path.join(tmpdir(), "twin-required-ignore-"));
  for (const directory of [".runtime", ".codex-runtime", ".workbuddy"]) {
    mkdirSync(path.join(projectRoot, directory), { mode: 0o700 });
  }
  const now = "2026-07-21T08:00:00.000Z";
  const report = await runLocalContinuityCheck({
    ...base,
    private_roots: [
      { role: "runtime", path: ".runtime" },
      { role: "codex", path: ".codex-runtime" },
      { role: "workbuddy", path: ".workbuddy" }
    ],
    policy: {
      supplement_max_age_seconds: 600,
      daily_memory_max_age_seconds: 129600
    }
  }, {
    projectRoot,
    clock: () => now,
    adapters: {
      probeService: async ({ role }) => ({
        loaded: true,
        state: role === "realtime" ? "running" : "not running",
        pid_present: role === "realtime",
        last_exit_code: 0,
        latest_signal: "ready",
        ...(role === "daily_memory" ? {
          last_result_parseable: true,
          last_result_has_target_date: true,
          last_result_at: "2026-07-21T00:10:00.000Z"
        } : {})
      }),
      probeRuntimeState: async () => ({
        frozen: false,
        processed_complete_count: 1,
        supplement_checkpoint_count: 1,
        supplement_checkpoint_latest_at: "2026-07-21T07:59:30.000Z",
        daily_memory_expired_lock_count: 0
      }),
      probeGit: async () => ({ trackedPaths: [], ignoredPaths: [] })
    }
  });
  assert.equal(report.healthy, false);
  assert.equal(
    report.violations.some((violation) => violation.code === "required-path-not-ignored"),
    true
  );
  const normalizedManifest = {
    ...base,
    private_roots: [
      { role: "runtime", path: ".runtime" },
      { role: "codex", path: ".codex-runtime" },
      { role: "workbuddy", path: ".workbuddy" }
    ],
    policy: {
      supplement_max_age_seconds: 600,
      daily_memory_max_age_seconds: 129600
    }
  };
  const invalidPaths = [
    (manifest) => { manifest.private_roots[0].path = "./.runtime"; },
    (manifest) => { manifest.private_roots[0].path = "/tmp/runtime"; },
    (manifest) => { manifest.private_roots[0].path = ".runtime\\nested"; },
    (manifest) => { manifest.private_roots[0].path = "."; },
    (manifest) => { manifest.private_roots[0].path = ".."; },
    (manifest) => { manifest.private_roots[0].path = "../runtime"; },
    (manifest) => { manifest.state_database = ".runtime/../state.sqlite"; },
    (manifest) => { manifest.services[0].signal_log = ".runtime//event.stderr.log"; },
    (manifest) => { manifest.services[0].result_log = "./.runtime/event.stdout.log"; },
    (manifest) => { manifest.required_ignored_paths = ["../private/config.json"]; }
  ];
  for (const makeInvalid of invalidPaths) {
    const manifest = structuredClone(normalizedManifest);
    makeInvalid(manifest);
    assert.throws(
      () => validateContinuityManifest(manifest, { projectRoot }),
      /normalized project-relative path/u
    );
  }
});

test("隔离演练使用临时配置、临时 SQLite 和 Fake 适配器证明成功与回退链路", async () => {
  const result = await runIsolatedContinuityExercise();

  assert.equal(result.healthy, true);
  assert.equal(result.real_feishu_write_performed, false);
  assert.equal(result.real_service_reload_performed, false);
  assert.equal(result.isolation.temporary_config, true);
  assert.equal(result.isolation.temporary_sqlite, true);
  assert.equal(result.isolation.fake_lark_adapter, true);
  assert.equal(result.isolation.fake_inference_adapter, true);
  assert.equal(result.isolation.fake_lark_call_count, 2);
  assert.equal(result.isolation.fake_inference_call_count, 2);
  assert.equal(result.success_scenario.status, "complete");
  assert.equal(result.rollback_scenario.status, "rolled-back");
  assert.equal(result.success_scenario.persisted_version, 2);
  assert.equal(result.rollback_scenario.persisted_version, 1);
});

test("默认测试环境移除宿主凭据且不给真实 lark-cli 或 Codex 留在 PATH", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "twin-test-env-"));
  const environment = await createIsolatedTestEnvironment({
    root,
    nodePath: process.execPath,
    baseEnvironment: {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      OPENAI_API_KEY: "secret",
      LARK_TOKEN: "secret",
      CODEX_HOME: "/private/codex",
      DATABASE_URL: "postgres://production",
      LANG: "zh_CN.UTF-8"
    }
  });

  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.LARK_TOKEN, undefined);
  assert.equal(environment.CODEX_HOME, undefined);
  assert.equal(environment.DATABASE_URL, undefined);
  assert.equal(environment.LANG, "zh_CN.UTF-8");
  assert.equal(environment.TWIN_TEST_MODE, "1");
  assert.equal(environment.HOME, path.join(root, "home"));
  assert.equal(environment.PATH.startsWith(path.join(root, "bin")), true);
  assert.equal(environment.PATH.includes("/opt/homebrew/bin"), false);
  assert.equal(existsSync(path.join(root, "bin", "node")), true);
});

test("运行态健康快照以 SQLite 只读模式返回聚合数据且不改数据库", () => {
  const root = mkdtempSync(path.join(tmpdir(), "twin-health-state-"));
  const databasePath = path.join(root, "state.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE runtime_control (singleton INTEGER PRIMARY KEY, frozen INTEGER NOT NULL);
    CREATE TABLE processed_events (event_id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE supplement_checkpoints (chat_id TEXT PRIMARY KEY, last_read_at TEXT NOT NULL);
    CREATE TABLE daily_memory_locks (target_date TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
    INSERT INTO runtime_control VALUES (1, 0);
    INSERT INTO processed_events VALUES ('synthetic-event', 'complete');
    INSERT INTO supplement_checkpoints VALUES ('synthetic-chat', '2026-07-21T07:59:30.000Z');
    INSERT INTO daily_memory_locks VALUES ('2026-07-20', '2026-07-21T07:00:00.000Z');
  `);
  database.close();
  const before = statSync(databasePath);

  const snapshot = readRuntimeHealthSnapshot(databasePath, {
    now: "2026-07-21T08:00:00.000Z"
  });
  const after = statSync(databasePath);

  assert.deepEqual(snapshot, {
    frozen: false,
    processed_complete_count: 1,
    supplement_checkpoint_count: 1,
    supplement_checkpoint_latest_at: "2026-07-21T07:59:30.000Z",
    daily_memory_expired_lock_count: 1
  });
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("本机探针只从脱敏日志累计 ready/error、失败和重复结果", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "twin-health-logs-"));
  const runtimeRoot = path.join(projectRoot, ".runtime");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  writeFileSync(path.join(runtimeRoot, "event.stderr.log"), [
    JSON.stringify({ type: "error", message: "private body must be discarded" }),
    JSON.stringify({ type: "ready", component: "supervisor" })
  ].join("\n"), { mode: 0o600 });
  writeFileSync(path.join(runtimeRoot, "event.stdout.log"), [
    JSON.stringify({
      outcome: "reply",
      executions: [{ status: "complete", execution_hash: "exec-1" }]
    }),
    "not-json private body",
    JSON.stringify({
      outcome: "reply",
      executions: [
        { status: "duplicate", execution_hash: "exec-1" },
        { status: "failed", execution_hash: "exec-2" },
        { status: "complete", execution_hash: "exec-1" }
      ]
    })
  ].join("\n"), { mode: 0o600 });
  const adapters = createLocalContinuityAdapters({ launchd_domain: "gui/current" }, {
    projectRoot,
    commandRunner: () => ({
      status: 0,
      stdout: "state = running\nruns = 4\npid = 123\nlast exit code = 143\n",
      stderr: ""
    })
  });

  const result = await adapters.probeService({
    role: "realtime",
    label: "private-label",
    signal_log: ".runtime/event.stderr.log",
    result_log: ".runtime/event.stdout.log"
  });

  assert.deepEqual(result, {
    loaded: true,
    state: "running",
    pid_present: true,
    runs: 4,
    last_exit_code: 143,
    latest_signal: "ready",
    ready_signal_count: 1,
    error_signal_count: 1,
    result_record_count: 2,
    result_parse_error_count: 1,
    prevented_duplicate_execution_count: 1,
    successful_execution_count: 2,
    duplicate_successful_execution_count: 1,
    successful_execution_without_hash_count: 0,
    failed_execution_count: 1,
    reply_outcome_count: 2,
    confirm_outcome_count: 0
  });
  assert.doesNotMatch(JSON.stringify(result), /private body|private-label/u);
});
