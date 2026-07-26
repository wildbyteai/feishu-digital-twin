import { chmod, lstat, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const SENSITIVE_FILE_MODE = 0o600;
const REQUIRED_PRIVATE_ROOT_ROLES = new Set(["runtime", "codex"]);
const CODEX_SENSITIVE_BASENAMES = new Set(["auth.json", "config.toml"]);
const CODEX_SENSITIVE_SUFFIXES = [".sqlite", ".sqlite-shm", ".sqlite-wal", ".log"];
const CODEX_ARG0_HELPER_BASENAMES = new Set([
  "applypatch",
  "apply_patch",
  "codex-execve-wrapper"
]);
const CODEX_ARG0_CACHE_BASENAMES = new Set([
  ".lock",
  ...CODEX_ARG0_HELPER_BASENAMES
]);
const PRIVATE_STATE_FILESYSTEM = Object.freeze({ lstat, readdir, realpath });

export const DEFAULT_REQUIRED_IGNORED_PATHS = Object.freeze([
  ".runtime/config.json",
  ".runtime/state.sqlite",
  ".runtime/runtime.log",
  ".codex-runtime/codex-home/auth.json",
  "config.json",
  "config.local.json",
  ".env",
  ".env.local",
  "auth.json",
  "credentials.json",
  "client_secret.json",
  "service_account.json",
  "authorization-qr.png",
  "login-auth.png",
  "debug.zip",
  "diagnostics.zip"
]);

function permissionMode(stats) {
  return stats.mode & 0o777;
}

function relativeLocation(projectRoot, target) {
  const relative = path.relative(projectRoot, target);
  return relative || ".";
}

function insideProject(projectRoot, target) {
  const relative = path.relative(projectRoot, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isSensitivePrivateFile(root, target) {
  if (root.role === "runtime") return true;
  const basename = path.basename(target);
  if (root.role === "codex" && CODEX_SENSITIVE_BASENAMES.has(basename)) return true;
  if (root.role === "codex" && CODEX_SENSITIVE_SUFFIXES.some(
    (suffix) => basename.endsWith(suffix)
  )) return true;
  if (root.protect_all_files === true) return true;
  if (root.sensitive_basenames?.includes(basename)) return true;
  return root.sensitive_suffixes?.some((suffix) => basename.endsWith(suffix)) === true;
}

function privateRootIsRequired(root) {
  if (REQUIRED_PRIVATE_ROOT_ROLES.has(root.role)) return true;
  return root.required === true;
}

async function isTrustedCodexArg0HelperLink(
  root,
  privateRoot,
  target,
  resolved,
  filesystem
) {
  if (root.role !== "codex") return false;
  const segments = path.relative(privateRoot, target).split(path.sep);
  if (!(segments.length === 5 &&
    segments[0] === "codex-home" &&
    segments[1] === "tmp" &&
    segments[2] === "arg0" &&
    /^codex-arg0[^/]+$/u.test(segments[3]) &&
    CODEX_ARG0_HELPER_BASENAMES.has(segments[4]))) return false;
  if (!/^codex(?:\.exe)?$/iu.test(path.basename(resolved))) return false;
  const executable = await filesystem.lstat(resolved);
  if (!executable.isFile() || executable.isSymbolicLink()) return false;
  if (process.platform !== "win32" && (executable.mode & 0o111) === 0) return false;
  const cacheDirectory = path.dirname(target);
  const entries = await filesystem.readdir(cacheDirectory);
  if (
    entries.length !== CODEX_ARG0_CACHE_BASENAMES.size ||
    entries.some((entry) => !CODEX_ARG0_CACHE_BASENAMES.has(entry))
  ) return false;
  const lock = await filesystem.lstat(path.join(cacheDirectory, ".lock"));
  if (!lock.isFile() || lock.isSymbolicLink() || lock.size !== 0) return false;
  for (const helper of CODEX_ARG0_HELPER_BASENAMES) {
    const helperPath = path.join(cacheDirectory, helper);
    const helperStats = await filesystem.lstat(helperPath);
    if (!helperStats.isSymbolicLink()) return false;
    if (await filesystem.realpath(helperPath) !== resolved) return false;
  }
  return true;
}

function repositoryPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isPublicExample(pathname) {
  return /(?:^|[._-])(example|sample|template|schema)(?:[._-]|$)/iu.test(pathname);
}

function isSensitiveRepositoryPath(value) {
  const pathname = repositoryPath(value);
  const basename = path.posix.basename(pathname);
  if (/^(\.runtime|\.codex-runtime|\.workbuddy)(?:\/|$)/u.test(pathname)) return true;
  if (isPublicExample(pathname)) return false;
  if (/^\.env(?:\.|$)/u.test(basename)) return true;
  if (/^(config(?:\.[a-z0-9_-]+)?\.local\.json|config\.json)$/iu.test(basename)) return true;
  if (/^(auth|credentials?|client[_-]?secret|service[_-]?account)\.(json|ya?ml|toml)$/iu.test(basename)) return true;
  if (isTemporaryAuthArtifact(basename)) return true;
  if (/\.(sqlite(?:-shm|-wal)?|db|log|pem|key|p12|pfx)$/iu.test(basename)) return true;
  return /(?:^|[._-])(debug|diagnostics?)(?:[._-].*)?\.zip$/iu.test(basename);
}

export function auditGitIsolation({
  trackedPaths,
  ignoredPaths,
  requiredIgnoredPaths = DEFAULT_REQUIRED_IGNORED_PATHS,
  privateRootPaths = []
}) {
  if (!Array.isArray(trackedPaths) || !Array.isArray(ignoredPaths) ||
      !Array.isArray(privateRootPaths)) {
    throw new TypeError("trackedPaths, ignoredPaths and privateRootPaths must be arrays");
  }
  const ignored = new Set(ignoredPaths.map(repositoryPath));
  const privateRoots = privateRootPaths.map((value) => (
    repositoryPath(value).replace(/\/$/u, "")
  ));
  const violations = [];
  for (const tracked of trackedPaths) {
    const location = repositoryPath(tracked);
    const insidePrivateRoot = privateRoots.some((root) => (
      location === root || location.startsWith(`${root}/`)
    ));
    if (insidePrivateRoot || isSensitiveRepositoryPath(location)) {
      violations.push({
        code: "sensitive-tracked-path",
        location
      });
    }
  }
  for (const required of requiredIgnoredPaths) {
    const location = repositoryPath(required);
    if (!ignored.has(location)) {
      violations.push({ code: "required-path-not-ignored", location });
    }
  }
  return {
    healthy: violations.length === 0,
    tracked_path_count: trackedPaths.length,
    required_ignored_path_count: requiredIgnoredPaths.length,
    violations
  };
}

function ageSeconds(timestamp, now, field) {
  const then = Date.parse(timestamp);
  const current = Date.parse(now);
  if (!Number.isFinite(then) || !Number.isFinite(current)) {
    throw new TypeError(`${field} must be an ISO date-time`);
  }
  return Math.floor((current - then) / 1000);
}

function checkScheduledService(role, service, violations) {
  const loaded = service?.loaded === true;
  const running = service?.state === "running";
  const lastExitOk = running || service?.last_exit_code === 0;
  if (!loaded) violations.push({ code: "service-not-loaded", role });
  if (!lastExitOk) violations.push({ code: "scheduled-service-last-exit-failed", role });
  return {
    loaded,
    running,
    last_exit_ok: lastExitOk,
    runs: nonNegativeCounter(service?.runs)
  };
}

export function evaluateContinuityHealth(snapshot, { now = new Date().toISOString(), policy } = {}) {
  if (!snapshot?.services || !snapshot.runtime || !policy) {
    throw new TypeError("snapshot services/runtime and policy are required");
  }
  const violations = [];
  const realtime = snapshot.services.realtime ?? {};
  const realtimeHealthy = realtime.loaded === true &&
    realtime.state === "running" &&
    realtime.pid_present === true &&
    realtime.latest_signal === "ready";
  if (realtime.loaded !== true) {
    violations.push({ code: "service-not-loaded", role: "realtime" });
  } else if (realtime.state !== "running" || realtime.pid_present !== true) {
    violations.push({ code: "continuous-service-not-running", role: "realtime" });
  }
  if (realtime.latest_signal !== "ready") {
    violations.push({ code: "continuous-service-not-ready", role: "realtime" });
  }
  if (realtime.result_parse_error_count > 0) {
    violations.push({ code: "service-result-log-parse-error", role: "realtime" });
  }
  if (realtime.duplicate_successful_execution_count > 0) {
    violations.push({ code: "duplicate-successful-execution", role: "realtime" });
  }
  if (realtime.successful_execution_without_hash_count > 0) {
    violations.push({ code: "successful-execution-missing-hash", role: "realtime" });
  }

  const supplement = checkScheduledService(
    "supplement",
    snapshot.services.supplement,
    violations
  );
  if (snapshot.services.supplement?.latest_signal !== "ready") {
    violations.push({ code: "supplement-not-ready", role: "supplement" });
  }
  if (snapshot.services.supplement?.result_parse_error_count > 0) {
    violations.push({ code: "service-result-log-parse-error", role: "supplement" });
  }
  if (snapshot.services.supplement?.duplicate_successful_execution_count > 0) {
    violations.push({ code: "duplicate-successful-execution", role: "supplement" });
  }
  if (snapshot.services.supplement?.successful_execution_without_hash_count > 0) {
    violations.push({ code: "successful-execution-missing-hash", role: "supplement" });
  }
  const supplementTimestamp = snapshot.runtime.supplement_checkpoint_latest_at;
  const supplementAge = supplementTimestamp
    ? ageSeconds(supplementTimestamp, now, "supplement checkpoint")
    : null;
  if (snapshot.runtime.supplement_checkpoint_count <= 0 || supplementAge === null) {
    violations.push({ code: "supplement-checkpoint-missing", role: "supplement" });
  } else if (supplementAge < -60) {
    violations.push({ code: "supplement-checkpoint-in-future", role: "supplement" });
  } else if (supplementAge > policy.supplement_max_age_seconds) {
    violations.push({ code: "supplement-checkpoint-stale", role: "supplement" });
  }

  const dailyMemory = checkScheduledService(
    "daily_memory",
    snapshot.services.daily_memory,
    violations
  );
  const dailyTimestamp = snapshot.services.daily_memory?.last_result_at;
  const dailyAge = dailyTimestamp
    ? ageSeconds(dailyTimestamp, now, "daily memory result")
    : null;
  if (
    snapshot.services.daily_memory?.last_result_parseable !== true ||
    snapshot.services.daily_memory?.last_result_has_target_date !== true ||
    dailyAge === null
  ) {
    violations.push({ code: "daily-memory-result-missing", role: "daily_memory" });
  } else if (dailyAge < -60) {
    violations.push({ code: "daily-memory-result-in-future", role: "daily_memory" });
  } else if (dailyAge > policy.daily_memory_max_age_seconds) {
    violations.push({ code: "daily-memory-result-stale", role: "daily_memory" });
  }
  if (snapshot.runtime.daily_memory_expired_lock_count > 0) {
    violations.push({ code: "daily-memory-expired-lock", role: "daily_memory" });
  }
  if (snapshot.services.daily_memory?.result_parse_error_count > 0) {
    violations.push({ code: "service-result-log-parse-error", role: "daily_memory" });
  }
  if (snapshot.services.daily_memory?.duplicate_successful_execution_count > 0) {
    violations.push({ code: "duplicate-successful-execution", role: "daily_memory" });
  }
  if (snapshot.services.daily_memory?.successful_execution_without_hash_count > 0) {
    violations.push({ code: "successful-execution-missing-hash", role: "daily_memory" });
  }

  return {
    schema_version: 1,
    captured_at: snapshot.captured_at ?? now,
    healthy: violations.length === 0,
    services: {
      realtime: {
        loaded: realtime.loaded === true,
        running: realtime.state === "running",
        ready: realtime.latest_signal === "ready",
        healthy: realtimeHealthy,
        runs: nonNegativeCounter(realtime.runs),
        ready_signal_count: nonNegativeCounter(realtime.ready_signal_count),
        error_signal_count: nonNegativeCounter(realtime.error_signal_count),
        result_parse_error_count: nonNegativeCounter(realtime.result_parse_error_count),
        prevented_duplicate_execution_count:
          nonNegativeCounter(realtime.prevented_duplicate_execution_count),
        successful_execution_count:
          nonNegativeCounter(realtime.successful_execution_count),
        duplicate_successful_execution_count:
          nonNegativeCounter(realtime.duplicate_successful_execution_count),
        successful_execution_without_hash_count:
          nonNegativeCounter(realtime.successful_execution_without_hash_count),
        failed_execution_count: nonNegativeCounter(realtime.failed_execution_count)
      },
      supplement: {
        ...supplement,
        ready: snapshot.services.supplement?.latest_signal === "ready",
        checkpoint_count: snapshot.runtime.supplement_checkpoint_count,
        checkpoint_latest_at: supplementTimestamp ?? null,
        checkpoint_age_seconds: supplementAge,
        ready_signal_count:
          nonNegativeCounter(snapshot.services.supplement?.ready_signal_count),
        error_signal_count:
          nonNegativeCounter(snapshot.services.supplement?.error_signal_count),
        result_parse_error_count:
          nonNegativeCounter(snapshot.services.supplement?.result_parse_error_count),
        prevented_duplicate_execution_count:
          nonNegativeCounter(snapshot.services.supplement?.prevented_duplicate_execution_count),
        successful_execution_count:
          nonNegativeCounter(snapshot.services.supplement?.successful_execution_count),
        duplicate_successful_execution_count:
          nonNegativeCounter(snapshot.services.supplement?.duplicate_successful_execution_count),
        successful_execution_without_hash_count:
          nonNegativeCounter(snapshot.services.supplement?.successful_execution_without_hash_count),
        failed_execution_count:
          nonNegativeCounter(snapshot.services.supplement?.failed_execution_count)
      },
      daily_memory: {
        ...dailyMemory,
        result_parseable: snapshot.services.daily_memory?.last_result_parseable === true,
        result_at: dailyTimestamp ?? null,
        result_age_seconds: dailyAge,
        error_signal_count:
          nonNegativeCounter(snapshot.services.daily_memory?.error_signal_count),
        result_parse_error_count:
          nonNegativeCounter(snapshot.services.daily_memory?.result_parse_error_count),
        prevented_duplicate_execution_count:
          nonNegativeCounter(snapshot.services.daily_memory?.prevented_duplicate_execution_count),
        successful_execution_count:
          nonNegativeCounter(snapshot.services.daily_memory?.successful_execution_count),
        duplicate_successful_execution_count:
          nonNegativeCounter(snapshot.services.daily_memory?.duplicate_successful_execution_count),
        successful_execution_without_hash_count:
          nonNegativeCounter(snapshot.services.daily_memory?.successful_execution_without_hash_count),
        failed_execution_count:
          nonNegativeCounter(snapshot.services.daily_memory?.failed_execution_count)
      }
    },
    runtime: {
      frozen: snapshot.runtime.frozen === true,
      processed_complete_count: snapshot.runtime.processed_complete_count,
      daily_memory_expired_lock_count: snapshot.runtime.daily_memory_expired_lock_count
    },
    violations
  };
}

function compareTimestamp(current, baseline, code, violations) {
  if (baseline === null || baseline === undefined) return;
  const baselineTime = Date.parse(baseline);
  const currentTime = Date.parse(current);
  if (!Number.isFinite(currentTime) || currentTime < baselineTime) {
    violations.push({ code });
  }
}

function nonNegativeCounter(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function compareCounter(currentValue, baselineValue, {
  increaseCode,
  regressionCode,
  allowedIncrease = 0
}, violations) {
  const current = nonNegativeCounter(currentValue);
  const baseline = nonNegativeCounter(baselineValue);
  if (current < baseline) {
    violations.push({ code: regressionCode });
  } else if (current > baseline + allowedIncrease) {
    violations.push({ code: increaseCode });
  }
}

export function createContinuityBaseline(report) {
  if (report?.healthy !== true) {
    throw new Error("cannot capture an unhealthy continuity report");
  }
  return {
    schema_version: 1,
    captured_at: report.captured_at,
    invariants: {
      frozen: report.runtime.frozen === true,
      processed_complete_count: report.runtime.processed_complete_count,
      supplement_checkpoint_latest_at:
        report.services.supplement.checkpoint_latest_at ?? null,
      daily_memory_result_at: report.services.daily_memory.result_at ?? null,
      service_counters: {
        realtime: {
          runs: nonNegativeCounter(report.services.realtime.runs),
          error_signal_count: nonNegativeCounter(report.services.realtime.error_signal_count),
          result_parse_error_count:
            nonNegativeCounter(report.services.realtime.result_parse_error_count),
          duplicate_successful_execution_count:
            nonNegativeCounter(report.services.realtime.duplicate_successful_execution_count),
          successful_execution_without_hash_count:
            nonNegativeCounter(report.services.realtime.successful_execution_without_hash_count),
          failed_execution_count:
            nonNegativeCounter(report.services.realtime.failed_execution_count)
        },
        supplement: {
          runs: nonNegativeCounter(report.services.supplement.runs),
          error_signal_count: nonNegativeCounter(report.services.supplement.error_signal_count),
          result_parse_error_count:
            nonNegativeCounter(report.services.supplement.result_parse_error_count),
          duplicate_successful_execution_count:
            nonNegativeCounter(report.services.supplement.duplicate_successful_execution_count),
          successful_execution_without_hash_count:
            nonNegativeCounter(report.services.supplement.successful_execution_without_hash_count),
          failed_execution_count:
            nonNegativeCounter(report.services.supplement.failed_execution_count)
        },
        daily_memory: {
          runs: nonNegativeCounter(report.services.daily_memory.runs),
          error_signal_count:
            nonNegativeCounter(report.services.daily_memory.error_signal_count),
          result_parse_error_count:
            nonNegativeCounter(report.services.daily_memory.result_parse_error_count),
          duplicate_successful_execution_count:
            nonNegativeCounter(report.services.daily_memory.duplicate_successful_execution_count),
          successful_execution_without_hash_count:
            nonNegativeCounter(report.services.daily_memory.successful_execution_without_hash_count),
          failed_execution_count:
            nonNegativeCounter(report.services.daily_memory.failed_execution_count)
        }
      }
    }
  };
}

export function compareContinuityBaseline(
  baseline,
  report,
  { allowedRealtimeRunDelta = 0 } = {}
) {
  if (baseline?.schema_version !== 1 || !baseline.invariants) {
    throw new TypeError("a version 1 continuity baseline is required");
  }
  const violations = [];
  if (report?.healthy !== true) violations.push({ code: "current-health-failed" });
  if ((report?.runtime?.frozen === true) !== baseline.invariants.frozen) {
    violations.push({ code: "freeze-state-changed" });
  }
  if (
    !Number.isInteger(report?.runtime?.processed_complete_count) ||
    report.runtime.processed_complete_count < baseline.invariants.processed_complete_count
  ) {
    violations.push({ code: "processed-count-regressed" });
  }
  compareTimestamp(
    report?.services?.supplement?.checkpoint_latest_at,
    baseline.invariants.supplement_checkpoint_latest_at,
    "supplement-checkpoint-regressed",
    violations
  );
  if (!new Set([0, 1]).has(allowedRealtimeRunDelta)) {
    throw new TypeError("allowedRealtimeRunDelta must be 0 or 1");
  }
  const baselineCounters = baseline.invariants.service_counters ?? {};
  const currentCounters = report?.services ?? {};
  const baselineCapturedAt = Date.parse(baseline.captured_at);
  const currentCapturedAt = Date.parse(report?.captured_at);
  if (!Number.isFinite(baselineCapturedAt) || !Number.isFinite(currentCapturedAt) ||
      currentCapturedAt < baselineCapturedAt) {
    violations.push({ code: "capture-time-regressed" });
  }
  const elapsedSeconds = Number.isFinite(baselineCapturedAt) && Number.isFinite(currentCapturedAt)
    ? Math.max(0, Math.floor((currentCapturedAt - baselineCapturedAt) / 1000))
    : 0;
  compareCounter(
    currentCounters.realtime?.runs,
    baselineCounters.realtime?.runs,
    {
      increaseCode: "realtime-run-count-increased",
      regressionCode: "realtime-run-count-regressed",
      allowedIncrease: allowedRealtimeRunDelta
    },
    violations
  );
  compareCounter(
    currentCounters.supplement?.runs,
    baselineCounters.supplement?.runs,
    {
      increaseCode: "supplement-run-count-excessive",
      regressionCode: "supplement-run-count-regressed",
      allowedIncrease: Math.ceil(elapsedSeconds / 30) + 2
    },
    violations
  );
  compareCounter(
    currentCounters.daily_memory?.runs,
    baselineCounters.daily_memory?.runs,
    {
      increaseCode: "daily-memory-run-count-excessive",
      regressionCode: "daily-memory-run-count-regressed",
      allowedIncrease: Math.ceil(elapsedSeconds / 86_400) + 1
    },
    violations
  );
  for (const [role, fields] of Object.entries({
    realtime: {
      error_signal_count: "realtime-error-signal",
      result_parse_error_count: "realtime-result-parse-error",
      duplicate_successful_execution_count: "realtime-duplicate-success",
      successful_execution_without_hash_count: "realtime-success-missing-hash",
      failed_execution_count: "realtime-failed-execution"
    },
    supplement: {
      error_signal_count: "supplement-error-signal",
      result_parse_error_count: "supplement-result-parse-error",
      duplicate_successful_execution_count: "supplement-duplicate-success",
      successful_execution_without_hash_count: "supplement-success-missing-hash",
      failed_execution_count: "supplement-failed-execution"
    },
    daily_memory: {
      error_signal_count: "daily-memory-error-signal",
      result_parse_error_count: "daily-memory-result-parse-error",
      duplicate_successful_execution_count: "daily-memory-duplicate-success",
      successful_execution_without_hash_count: "daily-memory-success-missing-hash",
      failed_execution_count: "daily-memory-failed-execution"
    }
  })) {
    for (const [field, code] of Object.entries(fields)) {
      compareCounter(
        currentCounters[role]?.[field],
        baselineCounters[role]?.[field],
        {
          increaseCode: `${code}-increased`,
          regressionCode: `${code}-regressed`
        },
        violations
      );
    }
  }
  compareTimestamp(
    report?.services?.daily_memory?.result_at,
    baseline.invariants.daily_memory_result_at,
    "daily-memory-result-regressed",
    violations
  );
  return {
    schema_version: 1,
    healthy: violations.length === 0,
    baseline_captured_at: baseline.captured_at,
    current_captured_at: report?.captured_at ?? null,
    violations
  };
}

function requireOperation(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  return value;
}

export async function runControlledChange({
  serviceRole,
  precheck,
  isolatedTest,
  applyChange,
  switchService,
  postcheck,
  rollbackChange,
  verifyRollback
}) {
  if (typeof serviceRole !== "string" || serviceRole.length === 0) {
    throw new TypeError("serviceRole must name exactly one service");
  }
  const operations = {
    precheck: requireOperation(precheck, "precheck"),
    isolatedTest: requireOperation(isolatedTest, "isolatedTest"),
    applyChange: requireOperation(applyChange, "applyChange"),
    switchService: requireOperation(switchService, "switchService"),
    postcheck: requireOperation(postcheck, "postcheck"),
    rollbackChange: requireOperation(rollbackChange, "rollbackChange"),
    verifyRollback: requireOperation(verifyRollback, "verifyRollback")
  };
  const before = await operations.precheck();
  if (before?.healthy !== true) throw new Error("pre-change continuity check failed");
  await operations.isolatedTest();
  let serviceSwitchAttempted = false;
  try {
    await operations.applyChange();
    serviceSwitchAttempted = true;
    await operations.switchService({ role: serviceRole, phase: "apply" });
    const after = await operations.postcheck();
    if (after?.healthy !== true) throw new Error("post-change continuity check failed");
    return { status: "complete", service_role: serviceRole };
  } catch {
    await operations.rollbackChange();
    if (serviceSwitchAttempted) {
      await operations.switchService({ role: serviceRole, phase: "rollback" });
    }
    const restored = await operations.verifyRollback();
    if (restored?.healthy !== true) {
      throw new Error("rollback continuity check failed");
    }
    return { status: "rolled-back", service_role: serviceRole };
  }
}

function isTemporaryAuthArtifact(basename) {
  return /(?:^|[-_.])(?:auth|authorization|login|oauth)(?=[-_.]|$).*\.(png|jpe?g|svg)$/iu.test(basename);
}

async function removeAuthArtifacts(target, report) {
  const stats = await lstat(target);
  if (stats.isSymbolicLink()) {
    if (isTemporaryAuthArtifact(path.basename(target))) {
      await unlink(target);
      report.removed_count += 1;
      return;
    }
    report.skipped_symlink_count += 1;
    return;
  }
  if (stats.isDirectory()) {
    for (const entry of await readdir(target)) {
      await removeAuthArtifacts(path.join(target, entry), report);
    }
    return;
  }
  if (stats.isFile() && isTemporaryAuthArtifact(path.basename(target))) {
    await unlink(target);
    report.removed_count += 1;
  }
}

async function assertDirectPrivateRoot(projectRoot, target, description) {
  const stats = await lstat(target);
  let resolved;
  try {
    resolved = await realpath(target);
  } catch (error) {
    if (stats.isSymbolicLink()) {
      throw new Error(`${description} must not be a broken symbolic link`);
    }
    throw error;
  }
  if (!insideProject(projectRoot, resolved)) {
    throw new Error(`${description} must stay inside the project`);
  }
  if (stats.isSymbolicLink() || resolved !== target) {
    throw new Error(`${description} must not traverse symbolic links`);
  }
}

export async function cleanupTemporaryAuthArtifacts({ projectRoot, privateRoots }) {
  if (!Array.isArray(privateRoots) || privateRoots.length === 0) {
    throw new TypeError("privateRoots must contain at least one private root");
  }
  const resolvedProjectRoot = await realpath(path.resolve(projectRoot ?? process.cwd()));
  const report = { removed_count: 0, skipped_symlink_count: 0 };
  for (const privateRoot of privateRoots) {
    const target = path.resolve(resolvedProjectRoot, privateRoot);
    if (!insideProject(resolvedProjectRoot, target)) {
      throw new Error("temporary auth cleanup root must stay inside the project");
    }
    try {
      await assertDirectPrivateRoot(
        resolvedProjectRoot,
        target,
        "temporary auth cleanup root"
      );
      await removeAuthArtifacts(target, report);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error("temporary auth cleanup root is missing");
      }
      throw error;
    }
  }
  return report;
}

async function inspectEntry(target, root, context, report) {
  const stats = await context.filesystem.lstat(target);
  const location = relativeLocation(context.projectRoot, target);
  if (stats.isSymbolicLink()) {
    try {
      const resolved = await context.filesystem.realpath(target);
      if (await isTrustedCodexArg0HelperLink(
        root,
        context.privateRoot,
        target,
        resolved,
        context.filesystem
      )) return;
      if (insideProject(context.privateRoot, resolved)) {
        if (
          context.authorizationComplete === true &&
          (root.role === "runtime" || root.cleanup_temporary_auth_artifacts === true) &&
          isTemporaryAuthArtifact(path.basename(target))
        ) {
          report.temporary_auth_artifact_count += 1;
          report.violations.push({
            code: "temporary-auth-artifact-present",
            role: root.role,
            location
          });
        }
        if (isSensitivePrivateFile(root, target)) {
          report.violations.push({
            code: "sensitive-file-symlink",
            role: root.role,
            location
          });
          return;
        }
        report.internal_symlink_count += 1;
        return;
      }
      report.violations.push({
        code: "private-state-symlink-escape",
        role: root.role,
        location
      });
    } catch {
      report.violations.push({
        code: "private-state-symlink-broken",
        role: root.role,
        location
      });
    }
    return;
  }
  if (stats.isDirectory()) {
    report.directory_count += 1;
    if (permissionMode(stats) !== PRIVATE_DIRECTORY_MODE) {
      report.violations.push({
        code: "directory-mode",
        role: root.role,
        location,
        expected_mode: "0700",
        actual_mode: permissionMode(stats).toString(8).padStart(4, "0")
      });
    }
    for (const entry of await context.filesystem.readdir(target)) {
      try {
        await inspectEntry(path.join(target, entry), root, context, report);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return;
  }
  if (!stats.isFile()) return;
  if (
    context.authorizationComplete === true &&
    (root.role === "runtime" || root.cleanup_temporary_auth_artifacts === true) &&
    isTemporaryAuthArtifact(path.basename(target))
  ) {
    report.temporary_auth_artifact_count += 1;
    report.violations.push({
      code: "temporary-auth-artifact-present",
      role: root.role,
      location
    });
  }
  if (!isSensitivePrivateFile(root, target)) return;
  report.sensitive_file_count += 1;
  if (permissionMode(stats) !== SENSITIVE_FILE_MODE) {
    report.violations.push({
      code: "sensitive-file-mode",
      role: root.role,
      location,
      expected_mode: "0600",
      actual_mode: permissionMode(stats).toString(8).padStart(4, "0")
    });
  }
}

export async function auditPrivateState(manifest, {
  projectRoot = process.cwd(),
  filesystem = PRIVATE_STATE_FILESYSTEM
} = {}) {
  if (!manifest || !Array.isArray(manifest.private_roots)) {
    throw new TypeError("manifest.private_roots is required");
  }
  for (const operation of ["lstat", "readdir", "realpath"]) {
    if (typeof filesystem?.[operation] !== "function") {
      throw new TypeError(`filesystem.${operation} is required`);
    }
  }
  const resolvedProjectRoot = await filesystem.realpath(path.resolve(projectRoot));
  const report = {
    healthy: false,
    directory_count: 0,
    sensitive_file_count: 0,
    temporary_auth_artifact_count: 0,
    internal_symlink_count: 0,
    violations: []
  };
  for (const root of manifest.private_roots) {
    if (typeof root?.role !== "string" || typeof root.path !== "string") {
      throw new TypeError("each private root requires role and path");
    }
    const target = path.resolve(resolvedProjectRoot, root.path);
    if (!insideProject(resolvedProjectRoot, target)) {
      report.violations.push({ code: "private-root-outside-project", role: root.role });
      continue;
    }
    try {
      const rootStats = await filesystem.lstat(target);
      let resolvedTarget;
      try {
        resolvedTarget = await filesystem.realpath(target);
      } catch (error) {
        if (rootStats.isSymbolicLink()) {
          report.violations.push({ code: "private-root-symlink-broken", role: root.role });
          continue;
        }
        throw error;
      }
      if (!insideProject(resolvedProjectRoot, resolvedTarget)) {
        report.violations.push({ code: "private-root-outside-project", role: root.role });
        continue;
      }
      if (rootStats.isSymbolicLink() || resolvedTarget !== target) {
        report.violations.push({ code: "private-root-symlink", role: root.role });
        continue;
      }
      await inspectEntry(target, root, {
        projectRoot: resolvedProjectRoot,
        privateRoot: target,
        authorizationComplete: manifest.authorization_complete === true,
        filesystem
      }, report);
    } catch (error) {
      if (error?.code === "ENOENT" && !privateRootIsRequired(root)) continue;
      if (error?.code === "ENOENT") {
        report.violations.push({ code: "private-root-missing", role: root.role });
        continue;
      }
      throw error;
    }
  }
  report.healthy = report.violations.length === 0;
  return report;
}

async function hardenEntry(target, root, privateRoot, report) {
  const stats = await lstat(target);
  if (stats.isSymbolicLink()) {
    const resolved = await realpath(target);
    if (await isTrustedCodexArg0HelperLink(
      root,
      privateRoot,
      target,
      resolved,
      PRIVATE_STATE_FILESYSTEM
    )) return;
    if (!insideProject(privateRoot, resolved)) {
      throw new Error("private state contains an escaping symlink");
    }
    if (isSensitivePrivateFile(root, target)) {
      throw new Error("sensitive private state must not use symbolic links");
    }
    report.internal_symlink_count += 1;
    return;
  }
  if (stats.isDirectory()) {
    if (permissionMode(stats) !== PRIVATE_DIRECTORY_MODE) {
      await chmod(target, PRIVATE_DIRECTORY_MODE);
      report.changed_directory_count += 1;
    }
    for (const entry of await readdir(target)) {
      await hardenEntry(path.join(target, entry), root, privateRoot, report);
    }
    return;
  }
  if (stats.isFile() && isSensitivePrivateFile(root, target) &&
      permissionMode(stats) !== SENSITIVE_FILE_MODE) {
    await chmod(target, SENSITIVE_FILE_MODE);
    report.changed_file_count += 1;
  }
}

export async function hardenPrivateStatePermissions(
  manifest,
  { projectRoot = process.cwd() } = {}
) {
  if (!manifest || !Array.isArray(manifest.private_roots)) {
    throw new TypeError("manifest.private_roots is required");
  }
  const resolvedProjectRoot = await realpath(path.resolve(projectRoot));
  const report = {
    changed_directory_count: 0,
    changed_file_count: 0,
    internal_symlink_count: 0
  };
  for (const root of manifest.private_roots) {
    const target = path.resolve(resolvedProjectRoot, root.path);
    if (!insideProject(resolvedProjectRoot, target)) {
      throw new Error("private root must stay inside the project");
    }
    try {
      await assertDirectPrivateRoot(resolvedProjectRoot, target, "private root");
      await hardenEntry(target, root, target, report);
    } catch (error) {
      if (error?.code === "ENOENT" && !privateRootIsRequired(root)) continue;
      throw error;
    }
  }
  return report;
}
