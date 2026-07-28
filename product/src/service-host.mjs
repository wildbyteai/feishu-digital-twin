import { spawn, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  ProductError,
  activeVersionRoot,
  readInstallation,
  readJson,
  resolveInside,
  writePrivateJson
} from "./installation.mjs";
import { loadInstanceConfig } from "../../runtime/src/config-loader.mjs";
import { previousDateInTimeZone } from "../../shared/daily-memory-trigger.mjs";

export const SERVICE_ROLES = Object.freeze(["realtime", "supplement", "daily_memory"]);
const DEFAULT_RESULT_LOG_MAX_BYTES = Number("10485760");
const DEFAULT_RESULT_LOG_RETENTION_DAYS = 7;
const DEFAULT_WORKDAYS = Object.freeze([1, 2, 3, 4, 5]);
const LAUNCHCTL_SERVICE_NOT_FOUND = 113;
const ISO_WEEKDAY_BY_SHORT = Object.freeze({
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7
});

const TEMPLATE_NAMES = Object.freeze({
  realtime: "realtime.plist.template",
  supplement: "supplement.plist.template",
  daily_memory: "daily-memory.plist.template"
});

function defaultLaunchAgentsDirectory(environment = process.env) {
  if (environment.FEISHU_TWIN_LAUNCH_AGENTS_DIR) {
    return path.resolve(environment.FEISHU_TWIN_LAUNCH_AGENTS_DIR);
  }
  return path.join(environment.HOME || os.homedir(), "Library", "LaunchAgents");
}

export function resolveLaunchAgentsDirectory(value, environment = process.env) {
  return path.resolve(value || defaultLaunchAgentsDirectory(environment));
}

function launchdDomain() {
  if (typeof process.getuid !== "function") {
    throw new ProductError("LAUNCHD_UNAVAILABLE", "launchd requires a user uid");
  }
  return `gui/${process.getuid()}`;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function replaceTokens(template, values) {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`__${key}__`, xml(value));
  }
  if (/__[A-Z0-9_]+__/u.test(rendered)) {
    throw new ProductError("INCOMPLETE_SERVICE_TEMPLATE", "service template contains unresolved fields");
  }
  return rendered;
}

async function writePrivateFile(filename, content, mode = 0o600) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
  await chmod(filename, mode);
}

async function exists(filename) {
  try {
    const metadata = await lstat(filename);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function runCommand(file, args) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

function parseLaunchctl(output) {
  const values = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*(state|pid|last exit code)\s*=\s*(.*?)\s*$/u);
    if (match && !values.has(match[1])) values.set(match[1], match[2]);
  }
  const pid = Number(values.get("pid"));
  const lastExit = Number(values.get("last exit code"));
  return {
    loaded: true,
    running: values.get("state") === "running",
    pid_present: Number.isInteger(pid) && pid > 0,
    last_exit_ok: !Number.isInteger(lastExit) || lastExit === 0
  };
}

function serviceHealthy(role, status) {
  if (!status.installed || !status.loaded || status.last_exit_ok === false) return false;
  return role !== "realtime" || (status.running && status.pid_present);
}

function launchctlPrintStatus(result) {
  if (result.error || result.status === null) {
    throw new ProductError("SERVICE_STATUS_FAILED", "background service status could not be read");
  }
  if (result.status === 0) return parseLaunchctl(result.stdout);
  if (result.status === LAUNCHCTL_SERVICE_NOT_FOUND) {
    return { loaded: false, running: false, pid_present: false, last_exit_ok: null };
  }
  throw new ProductError("SERVICE_STATUS_FAILED", "background service status could not be read");
}

function plistFilename(directory, label) {
  return path.join(directory, `${label}.plist`);
}

function healthyAfterStart(role, status) {
  if (!status.loaded) return false;
  return role !== "realtime" || (status.running && status.pid_present);
}

function terminalStartFailure(role, status) {
  return role === "realtime" && status.loaded && !status.running &&
    status.last_exit_ok === false;
}

async function waitForHealthyStart(root, role, {
  launchAgentsDirectory,
  launchctlBin,
  timeoutMs = 3000,
  pollIntervalMs = 100
}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const after = await serviceStatus(root, { launchAgentsDirectory, launchctlBin });
    const status = after.services[role];
    if (healthyAfterStart(role, status)) return true;
    if (terminalStartFailure(role, status) || Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (true);
}

async function waitForUnloaded(root, role, {
  launchAgentsDirectory,
  launchctlBin,
  timeoutMs = 3000,
  pollIntervalMs = 100
}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const after = await serviceStatus(root, { launchAgentsDirectory, launchctlBin });
    if (!after.services[role].loaded) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (true);
}

export async function serviceStatus(root, {
  launchAgentsDirectory,
  launchctlBin = "/bin/launchctl"
} = {}) {
  const installation = await readInstallation(root);
  const directory = resolveLaunchAgentsDirectory(launchAgentsDirectory);
  const domain = launchdDomain();
  const services = {};
  for (const role of SERVICE_ROLES) {
    const label = installation.services[role];
    const installed = await exists(plistFilename(directory, label));
    const result = runCommand(launchctlBin, ["print", `${domain}/${label}`]);
    const status = {
      installed,
      ...launchctlPrintStatus(result)
    };
    services[role] = {
      ...status,
      healthy: serviceHealthy(role, status)
    };
  }
  return {
    installed: SERVICE_ROLES.every((role) => services[role].installed),
    loaded: SERVICE_ROLES.every((role) => services[role].loaded),
    healthy: SERVICE_ROLES.every((role) => services[role].healthy),
    services
  };
}

function templateValues(root) {
  return {
    INSTALL_ROOT: root,
    HOME: process.env.HOME || os.homedir(),
    NODE_BIN: process.execPath
  };
}

export async function installServices(root, {
  launchAgentsDirectory,
  launchctlBin = "/bin/launchctl",
  roles = SERVICE_ROLES,
  start = true
} = {}) {
  const installation = await readInstallation(root);
  const versionRoot = activeVersionRoot(root, installation);
  const directory = resolveLaunchAgentsDirectory(launchAgentsDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const values = templateValues(root);
  for (const role of roles) {
    const template = await readFile(
      path.join(versionRoot, "deploy/launchd", TEMPLATE_NAMES[role]),
      "utf8"
    );
    const rendered = replaceTokens(template, {
      ...values,
      SERVICE_LABEL: installation.services[role]
    });
    await writePrivateFile(plistFilename(directory, installation.services[role]), rendered);
  }
  if (start) {
    await startServices(root, { launchAgentsDirectory: directory, launchctlBin, roles });
  }
  return { status: "installed", started: start };
}

export async function startServices(root, {
  launchAgentsDirectory,
  launchctlBin = "/bin/launchctl",
  roles = SERVICE_ROLES,
  verifyHealth = true,
  healthTimeoutMs = 3000,
  healthPollIntervalMs = 100
} = {}) {
  const installation = await readInstallation(root);
  const directory = resolveLaunchAgentsDirectory(launchAgentsDirectory);
  const before = await serviceStatus(root, { launchAgentsDirectory: directory, launchctlBin });
  const started = [];
  for (const role of roles) {
    if (!before.services[role].installed) {
      throw new ProductError("SERVICE_NOT_INSTALLED", "install background services before starting them");
    }
    if (before.services[role].loaded) continue;
    const result = runCommand(launchctlBin, [
      "bootstrap",
      launchdDomain(),
      plistFilename(directory, installation.services[role])
    ]);
    if (result.status !== 0) {
      for (const startedRole of started.reverse()) {
        runCommand(launchctlBin, [
          "bootout",
          `${launchdDomain()}/${installation.services[startedRole]}`
        ]);
      }
      throw new ProductError("SERVICE_START_FAILED", "a background service could not be started");
    }
    started.push(role);
    if (verifyHealth && !await waitForHealthyStart(root, role, {
      launchAgentsDirectory: directory,
      launchctlBin,
      timeoutMs: healthTimeoutMs,
      pollIntervalMs: healthPollIntervalMs
    })) {
      for (const startedRole of started.reverse()) {
        runCommand(launchctlBin, [
          "bootout",
          `${launchdDomain()}/${installation.services[startedRole]}`
        ]);
      }
      throw new ProductError("SERVICE_START_FAILED", "a background service did not stay healthy");
    }
  }
  return { status: "started" };
}

export async function stopServices(root, {
  launchAgentsDirectory,
  launchctlBin = "/bin/launchctl",
  roles = SERVICE_ROLES,
  unloadTimeoutMs = 3000,
  unloadPollIntervalMs = 100
} = {}) {
  const installation = await readInstallation(root);
  const directory = resolveLaunchAgentsDirectory(launchAgentsDirectory);
  const before = await serviceStatus(root, { launchAgentsDirectory: directory, launchctlBin });
  for (const role of roles) {
    if (!before.services[role].loaded) continue;
    const result = runCommand(launchctlBin, [
      "bootout",
      `${launchdDomain()}/${installation.services[role]}`
    ]);
    if (result.status !== 0) {
      throw new ProductError("SERVICE_STOP_FAILED", "a background service could not be stopped");
    }
    if (!await waitForUnloaded(root, role, {
      launchAgentsDirectory: directory,
      launchctlBin,
      timeoutMs: unloadTimeoutMs,
      pollIntervalMs: unloadPollIntervalMs
    })) {
      throw new ProductError("SERVICE_STOP_FAILED", "a background service did not finish stopping");
    }
  }
  return { status: "stopped" };
}

export async function restartServices(root, options = {}) {
  await stopServices(root, options);
  await startServices(root, options);
  return { status: "restarted" };
}

export async function uninstallServices(root, {
  launchAgentsDirectory,
  launchctlBin = "/bin/launchctl",
  roles = SERVICE_ROLES
} = {}) {
  const installation = await readInstallation(root, { required: false });
  if (!installation) return { status: "uninstalled" };
  const directory = resolveLaunchAgentsDirectory(launchAgentsDirectory);
  await stopServices(root, { launchAgentsDirectory: directory, launchctlBin, roles });
  for (const role of roles) {
    await rm(plistFilename(directory, installation.services[role]), { force: true });
  }
  return { status: "uninstalled" };
}

function waitForExit(child) {
  return new Promise((resolve) => {
    let failedToStart = false;
    child.once("error", () => { failedToStart = true; });
    child.once("close", (code, signal) => resolve({ code, signal, failedToStart }));
  });
}

function exitCode(result) {
  if (result.failedToStart) return 1;
  if (Number.isInteger(result.code)) return result.code;
  return result.signal ? 1 : 0;
}

async function waitForPipeline(children) {
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  try {
    return await Promise.all(children.map(waitForExit));
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

async function runLoggedProcess(versionRoot, command, args, logPath, logPolicy) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
  const logger = spawn(process.execPath, [
    path.join(versionRoot, "ops/service-result-log.mjs"),
    logPath,
    String(logPolicy.maxBytes),
    String(logPolicy.maxAgeSeconds)
  ], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdout.pipe(logger.stdin);
  const [childExit, loggerExit] = await waitForPipeline([child, logger]);
  return exitCode(childExit) || exitCode(loggerExit);
}

async function runRealtime(versionRoot, configPath, statePath, logPath, logPolicy) {
  const supervisor = spawn(process.execPath, [
    path.join(versionRoot, "bin/feishu-digital-twin-supervisor.mjs"),
    configPath,
    statePath
  ], { stdio: ["ignore", "pipe", "inherit"] });
  const logger = spawn(process.execPath, [
    path.join(versionRoot, "ops/service-result-log.mjs"),
    logPath,
    String(logPolicy.maxBytes),
    String(logPolicy.maxAgeSeconds)
  ], { stdio: ["pipe", "inherit", "inherit"] });
  supervisor.stdout.pipe(logger.stdin);
  const [supervisorExit, loggerExit] = await waitForPipeline([supervisor, logger]);
  return exitCode(supervisorExit) || exitCode(loggerExit);
}

async function runSupplement(versionRoot, configPath, statePath, logPath, logPolicy) {
  const intake = spawn(process.execPath, [
    path.join(versionRoot, "intake/bin/feishu-digital-twin-intake.mjs"),
    "supplement-once",
    configPath,
    statePath
  ], { stdio: ["ignore", "pipe", "inherit"] });
  const runtime = spawn(process.execPath, [
    path.join(versionRoot, "runtime/bin/feishu-digital-twin-runtime.mjs"),
    "serve",
    configPath,
    statePath
  ], { stdio: ["pipe", "pipe", "inherit"] });
  const logger = spawn(process.execPath, [
    path.join(versionRoot, "ops/service-result-log.mjs"),
    logPath,
    String(logPolicy.maxBytes),
    String(logPolicy.maxAgeSeconds)
  ], { stdio: ["pipe", "inherit", "inherit"] });
  intake.stdout.pipe(runtime.stdin);
  runtime.stdout.pipe(logger.stdin);
  const exits = await waitForPipeline([intake, runtime, logger]);
  return exits.map(exitCode).find((code) => code !== 0) ?? 0;
}

function localScheduleParts(now, timeZone) {
  let values;
  try {
    values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(now).map(({ type, value }) => [type, value]));
  } catch {
    throw new ProductError("INVALID_SERVICE_SCHEDULE", "principal timezone is invalid");
  }
  return {
    weekday: ISO_WEEKDAY_BY_SHORT[values.weekday],
    local_date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

async function loadServiceConfig(configPath) {
  try {
    return await loadInstanceConfig(configPath);
  } catch {
    throw new ProductError("SERVICE_CONFIG_INVALID", "the active instance configuration is invalid");
  }
}

function resultLogPolicy(config) {
  return {
    maxBytes: config.privacy?.result_log_max_bytes ?? DEFAULT_RESULT_LOG_MAX_BYTES,
    maxAgeSeconds: (
      config.privacy?.result_log_retention_days ?? DEFAULT_RESULT_LOG_RETENTION_DAYS
    ) * 24 * 60 * 60
  };
}

async function supplementIsDue(root, config, now = new Date()) {
  const timezone = config.principal.timezone;
  const { schedule } = config;
  const { weekday, hour } = localScheduleParts(now, timezone);
  const workday = (schedule.workdays ?? DEFAULT_WORKDAYS).includes(weekday);
  const working = workday && hour >= schedule.workday_start_hour &&
    hour < schedule.workday_end_hour;
  const intervalSeconds = working
    ? schedule.work_interval_seconds
    : schedule.quiet_interval_seconds;
  const markerPath = path.join(root, "private/supplement-schedule.json");
  const marker = await readJson(markerPath, "INVALID_SERVICE_SCHEDULE") ?? {};
  const last = Date.parse(marker.supplement_last_started_at ?? "");
  if (Number.isFinite(last) && now.getTime() - last < Math.max(1, intervalSeconds - 5) * 1000) {
    return false;
  }
  await writePrivateJson(markerPath, { supplement_last_started_at: now.toISOString() });
  return true;
}

function dailyMemoryDue(config, marker, now, activeVersion) {
  if (!config.daily_memory) return null;
  const timezone = config.principal.timezone;
  const { local_date: localDate, hour, minute } = localScheduleParts(now, timezone);
  const scheduledMinutes = config.schedule.daily_memory_hour * 60 +
    config.schedule.daily_memory_minute;
  if (hour * 60 + minute < scheduledMinutes) return null;
  const targetDate = previousDateInTimeZone(now, timezone);
  if (marker.last_success_local_date === localDate) {
    if (
      marker.last_success_target_date !== targetDate ||
      marker.last_evidence_version === activeVersion
    ) return null;
    return { localDate, targetDate, evidenceOnly: true };
  }
  return {
    localDate,
    targetDate,
    evidenceOnly: false
  };
}

async function logDailyMemoryEvidence({
  versionRoot,
  logPath,
  logPolicy,
  targetDate
}) {
  const logger = spawn(process.execPath, [
    path.join(versionRoot, "ops/service-result-log.mjs"),
    logPath,
    String(logPolicy.maxBytes),
    String(logPolicy.maxAgeSeconds)
  ], { stdio: ["pipe", "inherit", "inherit"] });
  logger.stdin.end(`${JSON.stringify({
    outcome: "ignore",
    executions: [],
    confirmations: [],
    target_date: targetDate
  })}\n`);
  return exitCode(await waitForExit(logger));
}

async function runDailyMemoryProcess({
  versionRoot,
  configPath,
  statePath,
  logPath,
  logPolicy,
  targetDate
}) {
  return runLoggedProcess(
    versionRoot,
    process.execPath,
    [
      path.join(versionRoot, "runtime/bin/feishu-digital-twin-runtime.mjs"),
      "daily-memory",
      configPath,
      statePath,
      targetDate
    ],
    logPath,
    logPolicy
  );
}

export async function runServiceRole(root, role, {
  now = new Date(),
  dailyMemoryRunner = runDailyMemoryProcess,
  dailyMemoryEvidenceLogger = logDailyMemoryEvidence,
  supplementRunner = runSupplement
} = {}) {
  if (!SERVICE_ROLES.includes(role)) {
    throw new ProductError("INVALID_SERVICE_ROLE", "service run requires a supported role");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new ProductError("INVALID_SERVICE_CLOCK", "service clock must be a valid date");
  }
  const installation = await readInstallation(root);
  const versionRoot = activeVersionRoot(root, installation);
  const configPath = resolveInside(root, installation.config_path, "config_path");
  const statePath = resolveInside(root, installation.state_database, "state_database");
  const logs = path.join(root, "private/logs");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  await chmod(logs, 0o700);
  const config = await loadServiceConfig(configPath);
  const logPolicy = resultLogPolicy(config);
  if (role === "realtime") {
    return runRealtime(
      versionRoot,
      configPath,
      statePath,
      path.join(logs, "realtime.stdout.log"),
      logPolicy
    );
  }
  if (role === "supplement") {
    if (!await supplementIsDue(root, config, now)) return 0;
    return supplementRunner(
      versionRoot,
      configPath,
      statePath,
      path.join(logs, "supplement.stdout.log"),
      logPolicy
    );
  }
  const markerPath = path.join(root, "private/daily-memory-schedule.json");
  const marker = await readJson(markerPath, "INVALID_SERVICE_SCHEDULE") ?? {};
  const due = dailyMemoryDue(config, marker, now, installation.active_version);
  if (!due) return 0;
  if (due.evidenceOnly) {
    const code = await dailyMemoryEvidenceLogger({
      versionRoot,
      logPath: path.join(logs, "daily-memory.stdout.log"),
      logPolicy,
      targetDate: due.targetDate
    });
    if (code === 0) {
      await writePrivateJson(markerPath, {
        last_success_at: marker.last_success_at,
        last_success_local_date: marker.last_success_local_date,
        last_success_target_date: marker.last_success_target_date,
        last_evidence_version: installation.active_version
      });
    }
    return code;
  }
  const code = await dailyMemoryRunner({
    versionRoot,
    configPath,
    statePath,
    logPath: path.join(logs, "daily-memory.stdout.log"),
    logPolicy,
    targetDate: due.targetDate
  });
  if (code === 0) {
    await writePrivateJson(markerPath, {
      last_success_at: now.toISOString(),
      last_success_local_date: due.localDate,
      last_success_target_date: due.targetDate,
      last_evidence_version: installation.active_version
    });
  }
  return code;
}
