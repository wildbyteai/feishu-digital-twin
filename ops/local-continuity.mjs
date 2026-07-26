import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import {
  DEFAULT_REQUIRED_IGNORED_PATHS,
  auditGitIsolation,
  auditPrivateState,
  evaluateContinuityHealth
} from "./continuity-gate.mjs";
import { readRuntimeHealthSnapshot } from "../runtime/src/runtime-health-snapshot.mjs";

const SERVICE_ROLES = Object.freeze(["realtime", "supplement", "daily_memory"]);
const PRIVATE_ROOT_ROLES = Object.freeze(["runtime", "codex"]);
const UNSAFE_PRIVATE_PATH_CODES = new Set([
  "private-root-outside-project",
  "private-root-symlink",
  "private-root-symlink-broken",
  "private-state-symlink-escape",
  "private-state-symlink-broken",
  "sensitive-file-symlink",
  "temporary-auth-artifact-present"
]);

function requireNormalizedProjectRelativePath(value, field) {
  const message = `${field} must be a normalized project-relative path`;
  if (typeof value !== "string" || value.length === 0 ||
      path.isAbsolute(value) || path.win32.isAbsolute(value) ||
      value.includes("\\") || value === "." || value === ".." ||
      value.startsWith("../") || path.posix.normalize(value) !== value) {
    throw new TypeError(message);
  }
  return value;
}

function requireAdapter(adapters, name) {
  if (typeof adapters?.[name] !== "function") throw new TypeError(`${name} adapter is required`);
  return adapters[name];
}

function sanitizedViolations(source, violations) {
  const grouped = new Map();
  for (const violation of violations) {
    const key = `${source}\0${violation.code}\0${violation.role ?? ""}`;
    const current = grouped.get(key) ?? {
      source,
      code: violation.code,
      ...(violation.role === undefined ? {} : { role: violation.role }),
      count: 0
    };
    current.count += 1;
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

function mandatoryIgnoredPaths(manifest) {
  const privateRootProbes = (manifest.private_roots ?? [])
    .map((root) => root.path.replace(/\/$/u, ""))
    .flatMap((rootPath) => [
      `${rootPath}/.continuity-ignore-probe`,
      `${rootPath}/nested/.continuity-ignore-probe`
    ]);
  return [...new Set([
    ...DEFAULT_REQUIRED_IGNORED_PATHS,
    ...(manifest.required_ignored_paths ?? []),
    ...privateRootProbes
  ])];
}

function requirePositiveInteger(value, field, maximum) {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${field} must be a positive integer no greater than ${maximum}`);
  }
}

function validateManifest(manifest) {
  if (manifest?.schema_version !== 1 || !Array.isArray(manifest.services)) {
    throw new TypeError("a version 1 continuity manifest is required");
  }
  if (!Array.isArray(manifest.private_roots)) {
    throw new TypeError("manifest.private_roots is required");
  }
  if (manifest.git_isolation_required !== undefined &&
      typeof manifest.git_isolation_required !== "boolean") {
    throw new TypeError("git_isolation_required must be a boolean");
  }
  const privateRoots = new Map();
  for (const root of manifest.private_roots) {
    if (typeof root?.role !== "string" || !root.role) {
      throw new TypeError("each private root requires a role");
    }
    requireNormalizedProjectRelativePath(root.path, `private root ${root.role}.path`);
    if (privateRoots.has(root.role)) throw new TypeError(`private root ${root.role} is duplicated`);
    privateRoots.set(root.role, root);
  }
  for (const role of PRIVATE_ROOT_ROLES) {
    if (!privateRoots.has(role)) throw new TypeError(`private root ${role} is required`);
  }
  const serviceDefinitions = new Map();
  for (const service of manifest.services) {
    if (typeof service?.role !== "string" || typeof service.label !== "string" || !service.label) {
      throw new TypeError("each service requires role and label");
    }
    if (serviceDefinitions.has(service.role)) {
      throw new TypeError(`service ${service.role} is duplicated`);
    }
    serviceDefinitions.set(service.role, service);
  }
  for (const role of SERVICE_ROLES) {
    if (!serviceDefinitions.has(role)) throw new TypeError(`manifest service ${role} is required`);
  }
  requireNormalizedProjectRelativePath(manifest.state_database, "state_database");
  for (const role of SERVICE_ROLES) {
    const service = serviceDefinitions.get(role);
    requireNormalizedProjectRelativePath(service.signal_log, `service ${role}.signal_log`);
    requireNormalizedProjectRelativePath(service.result_log, `service ${role}.result_log`);
  }
  if (manifest.required_ignored_paths !== undefined &&
      !Array.isArray(manifest.required_ignored_paths)) {
    throw new TypeError("required_ignored_paths must be an array");
  }
  for (const [index, ignoredPath] of (manifest.required_ignored_paths ?? []).entries()) {
    requireNormalizedProjectRelativePath(
      ignoredPath,
      `required_ignored_paths[${index}]`
    );
  }
  requirePositiveInteger(
    manifest.policy?.supplement_max_age_seconds,
    "policy.supplement_max_age_seconds",
    3600
  );
  requirePositiveInteger(
    manifest.policy?.daily_memory_max_age_seconds,
    "policy.daily_memory_max_age_seconds",
    259200
  );
}

function validateLocalPaths(manifest, projectRoot) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const roots = new Map(manifest.private_roots.map((root) => [
    root.role,
    resolveProjectPath(projectRoot, root.path, `private root ${root.role}`)
  ]));
  for (const [role, target] of roots) {
    if (target === resolvedProjectRoot) {
      throw new Error(`private root ${role} cannot be the project root`);
    }
  }
  const uniqueRoots = new Set(roots.values());
  if (uniqueRoots.size !== roots.size) throw new Error("private roots must use distinct paths");
  const runtimeRoot = roots.get("runtime");
  const stateDatabase = resolveProjectPath(projectRoot, manifest.state_database, "state_database");
  const withinRuntime = (target) => {
    const relative = path.relative(runtimeRoot, target);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
  };
  if (!withinRuntime(stateDatabase)) throw new Error("state_database must stay inside runtime root");
  for (const service of manifest.services) {
    for (const field of ["signal_log", "result_log"]) {
      const target = resolveProjectPath(projectRoot, service[field], `service.${field}`);
      if (!withinRuntime(target)) throw new Error(`service.${field} must stay inside runtime root`);
    }
  }
}

export function validateContinuityManifest(manifest, { projectRoot = process.cwd() } = {}) {
  validateManifest(manifest);
  validateLocalPaths(manifest, projectRoot);
  return manifest;
}

function resolveProjectPath(projectRoot, value, field) {
  requireNormalizedProjectRelativePath(value, field);
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, value);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${field} must stay inside the project`);
  }
  return target;
}

function runCommand(file, args, { cwd }) {
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
    timeout: 10_000
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function launchdDomain(manifest) {
  const configured = manifest.launchd_domain ?? "gui/current";
  if (configured === "gui/current") {
    if (typeof process.getuid !== "function") throw new Error("launchd user domain is unavailable");
    return `gui/${process.getuid()}`;
  }
  return configured;
}

function parseLaunchctl(output) {
  const values = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*(state|pid|runs|last exit code)\s*=\s*(.*?)\s*$/u);
    if (match && !values.has(match[1])) values.set(match[1], match[2]);
  }
  const number = (name) => {
    const value = Number(values.get(name));
    return Number.isInteger(value) ? value : null;
  };
  return {
    loaded: true,
    state: values.get("state") ?? null,
    pid_present: (number("pid") ?? 0) > 0,
    runs: number("runs"),
    last_exit_code: number("last exit code")
  };
}

function emptySignalSummary() {
  return { latest_signal: null, ready_signal_count: 0, error_signal_count: 0 };
}

async function serviceSignalSummary(filename) {
  if (!filename) return emptySignalSummary();
  try {
    const content = await readFile(filename, "utf8");
    const summary = emptySignalSummary();
    for (const line of content.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (value?.type === "ready" || value?.type === "error") {
          summary.latest_signal = value.type;
          if (value.type === "ready") summary.ready_signal_count += 1;
          if (value.type === "error") summary.error_signal_count += 1;
        }
      } catch {
        // Non-JSON output is intentionally ignored and never copied to the report.
      }
    }
    return summary;
  } catch (error) {
    if (error?.code === "ENOENT") return emptySignalSummary();
    throw error;
  }
}

function emptyResultSummary() {
  return {
    result_record_count: 0,
    result_parse_error_count: 0,
    prevented_duplicate_execution_count: 0,
    successful_execution_count: 0,
    duplicate_successful_execution_count: 0,
    successful_execution_without_hash_count: 0,
    failed_execution_count: 0,
    reply_outcome_count: 0,
    confirm_outcome_count: 0
  };
}

async function serviceResultSummary(filename) {
  if (!filename) return emptyResultSummary();
  try {
    await stat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyResultSummary();
    throw error;
  }
  const summary = emptyResultSummary();
  const successfulExecutionHashes = new Set();
  const lines = readline.createInterface({
    input: createReadStream(filename, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      summary.result_parse_error_count += 1;
      continue;
    }
    summary.result_record_count += 1;
    if (value?.outcome === "reply") summary.reply_outcome_count += 1;
    if (value?.outcome === "confirm") summary.confirm_outcome_count += 1;
    for (const execution of value?.executions ?? []) {
      if (execution?.status === "duplicate") {
        summary.prevented_duplicate_execution_count += 1;
      }
      if (execution?.status === "failed") summary.failed_execution_count += 1;
      if (execution?.status === "complete") {
        summary.successful_execution_count += 1;
        if (typeof execution.execution_hash !== "string" || !execution.execution_hash) {
          summary.successful_execution_without_hash_count += 1;
        } else if (successfulExecutionHashes.has(execution.execution_hash)) {
          summary.duplicate_successful_execution_count += 1;
        } else {
          successfulExecutionHashes.add(execution.execution_hash);
        }
      }
    }
  }
  return summary;
}

async function dailyMemoryResult(filename) {
  if (!filename) return {
    last_result_parseable: false,
    last_result_has_target_date: false,
    last_result_at: null
  };
  try {
    const [content, metadata] = await Promise.all([readFile(filename, "utf8"), stat(filename)]);
    const lines = content.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    let parsed;
    try {
      parsed = lines.length > 0 ? JSON.parse(lines.at(-1)) : null;
    } catch {
      parsed = null;
    }
    return {
      last_result_parseable: parsed !== null,
      last_result_has_target_date: typeof parsed?.target_date === "string",
      last_result_at: metadata.mtime.toISOString()
    };
  } catch (error) {
    if (error?.code === "ENOENT") return {
      last_result_parseable: false,
      last_result_has_target_date: false,
      last_result_at: null
    };
    throw error;
  }
}

function probeRuntimeDatabase(manifest, { projectRoot, now }) {
  const databasePath = resolveProjectPath(projectRoot, manifest.state_database, "state_database");
  return readRuntimeHealthSnapshot(databasePath, { now });
}

export function createLocalContinuityAdapters(manifest, {
  projectRoot = process.cwd(),
  commandRunner = runCommand,
  launchctlBin = "/bin/launchctl",
  gitBin = "/usr/bin/git"
} = {}) {
  return {
    async probeService(service) {
      if (typeof service.label !== "string" || service.label.length === 0) {
        throw new TypeError(`service ${service.role} requires a launchd label`);
      }
      const launch = commandRunner(
        launchctlBin,
        ["print", `${launchdDomain(manifest)}/${service.label}`],
        { cwd: projectRoot }
      );
      const base = launch.status === 0
        ? parseLaunchctl(launch.stdout)
        : {
            loaded: false,
            state: null,
            pid_present: false,
            runs: null,
            last_exit_code: null
          };
      const signalPath = service.signal_log
        ? resolveProjectPath(projectRoot, service.signal_log, "service.signal_log")
        : null;
      const resultPath = service.result_log
        ? resolveProjectPath(projectRoot, service.result_log, "service.result_log")
        : null;
      const [signals, results] = await Promise.all([
        serviceSignalSummary(signalPath),
        service.role === "daily_memory"
          ? Promise.all([
              dailyMemoryResult(resultPath),
              serviceResultSummary(resultPath)
            ]).then(([daily, summary]) => ({ ...daily, ...summary }))
          : serviceResultSummary(resultPath)
      ]);
      return {
        ...base,
        ...signals,
        ...results
      };
    },
    async probeRuntimeState(_manifest, context) {
      return probeRuntimeDatabase(manifest, context);
    },
    async probeGit() {
      const tracked = commandRunner(gitBin, ["ls-files", "-z"], { cwd: projectRoot });
      if (tracked.status !== 0) throw new Error("unable to enumerate tracked paths");
      const trackedPaths = tracked.stdout.split("\0").filter(Boolean);
      const required = mandatoryIgnoredPaths(manifest);
      const ignoredPaths = [];
      for (const candidate of required) {
        const ignored = commandRunner(
          gitBin,
          ["check-ignore", "-q", "--no-index", "--", candidate],
          { cwd: projectRoot }
        );
        if (ignored.status === 0) ignoredPaths.push(candidate);
        else if (ignored.status !== 1) throw new Error("unable to verify ignored paths");
      }
      return { trackedPaths, ignoredPaths };
    }
  };
}

export async function runLocalContinuityCheck(manifest, {
  projectRoot = process.cwd(),
  clock = () => new Date().toISOString(),
  adapters,
  requireGitIsolation = false
} = {}) {
  validateContinuityManifest(manifest, { projectRoot });
  if (requireGitIsolation && manifest.git_isolation_required === false) {
    throw new Error("Git isolation is required for this continuity check");
  }
  const now = clock();
  const privateState = await auditPrivateState(manifest, { projectRoot });
  if (privateState.violations.some(
    (violation) => UNSAFE_PRIVATE_PATH_CODES.has(violation.code)
  )) {
    throw new Error("private state path containment check failed");
  }
  const definitions = new Map(manifest.services.map((service) => [service.role, service]));
  for (const role of SERVICE_ROLES) {
    if (!definitions.has(role)) throw new TypeError(`manifest service ${role} is required`);
  }
  const resolvedAdapters = {
    ...createLocalContinuityAdapters(manifest, { projectRoot }),
    ...adapters
  };
  const probeService = requireAdapter(resolvedAdapters, "probeService");
  const probeRuntimeState = requireAdapter(resolvedAdapters, "probeRuntimeState");
  const gitIsolationRequired = manifest.git_isolation_required !== false;
  const probeGit = gitIsolationRequired
    ? requireAdapter(resolvedAdapters, "probeGit")
    : null;
  const serviceEntries = await Promise.all(SERVICE_ROLES.map(async (role) => [
    role,
    await probeService(definitions.get(role), { projectRoot, now })
  ]));
  const [runtime, gitProbe] = await Promise.all([
    probeRuntimeState(manifest, { projectRoot, now }),
    gitIsolationRequired
      ? probeGit(manifest, { projectRoot })
      : Promise.resolve({ trackedPaths: [], ignoredPaths: [] })
  ]);
  const serviceHealth = evaluateContinuityHealth({
    captured_at: now,
    services: Object.fromEntries(serviceEntries),
    runtime
  }, { now, policy: manifest.policy });
  const gitIsolation = gitIsolationRequired
    ? auditGitIsolation({
        trackedPaths: gitProbe.trackedPaths,
        ignoredPaths: gitProbe.ignoredPaths,
        requiredIgnoredPaths: mandatoryIgnoredPaths(manifest),
        privateRootPaths: manifest.private_roots.map((root) => root.path)
      })
    : {
        healthy: true,
        tracked_path_count: 0,
        required_ignored_path_count: 0,
        violations: []
      };
  const violations = [
    ...sanitizedViolations("service", serviceHealth.violations),
    ...sanitizedViolations("private_state", privateState.violations),
    ...sanitizedViolations("git", gitIsolation.violations)
  ];
  return {
    ...serviceHealth,
    healthy: serviceHealth.healthy && privateState.healthy && gitIsolation.healthy,
    private_state: {
      healthy: privateState.healthy,
      directory_count: privateState.directory_count,
      sensitive_file_count: privateState.sensitive_file_count,
      temporary_auth_artifact_count: privateState.temporary_auth_artifact_count,
      internal_symlink_count: privateState.internal_symlink_count
    },
    git_isolation: {
      checked: gitIsolationRequired,
      healthy: gitIsolation.healthy,
      tracked_path_count: gitIsolation.tracked_path_count,
      required_ignored_path_count: gitIsolation.required_ignored_path_count
    },
    violations
  };
}
