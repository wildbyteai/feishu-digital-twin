import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const INSTALLATION_SCHEMA_VERSION = 1;

export const DISTRIBUTION_ENTRIES = Object.freeze([
  ".codex-plugin",
  "bin/feishu-digital-twin.mjs",
  "bin/feishu-digital-twin-supervisor.mjs",
  "bin/supervisor-core.mjs",
  "deploy/launchd",
  "executor",
  "intake",
  "ops/service-result-log.mjs",
  "package.json",
  "product",
  "runtime",
  "shared",
  "skills"
]);

const REQUIRED_INSTALLED_PATHS = Object.freeze([
  "package.json",
  "bin/feishu-digital-twin.mjs",
  "bin/feishu-digital-twin-supervisor.mjs",
  "bin/supervisor-core.mjs",
  "runtime/bin/feishu-digital-twin-runtime.mjs",
  "intake/bin/feishu-digital-twin-intake.mjs",
  "ops/service-result-log.mjs",
  "deploy/launchd/realtime.plist.template",
  "deploy/launchd/supplement.plist.template",
  "deploy/launchd/daily-memory.plist.template"
]);

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const INSTANCE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;

export class ProductError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ProductError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function defaultProductRoot(environment = process.env) {
  if (environment.FEISHU_TWIN_ROOT) return path.resolve(environment.FEISHU_TWIN_ROOT);
  const home = environment.HOME || os.homedir();
  return path.join(home, "Library", "Application Support", "feishu-digital-twin");
}

export function resolveProductRoot(value, environment = process.env) {
  return path.resolve(value || defaultProductRoot(environment));
}

export function requireInstanceName(value) {
  if (typeof value !== "string" || !INSTANCE_NAME.test(value)) {
    throw new ProductError(
      "INVALID_INSTANCE_NAME",
      "instance name must use 1-32 lowercase letters, numbers, or hyphens"
    );
  }
  return value;
}

export function serviceLabels(instance) {
  requireInstanceName(instance);
  return {
    realtime: `app.feishu-digital-twin.${instance}.realtime`,
    supplement: `app.feishu-digital-twin.${instance}.supplement`,
    daily_memory: `app.feishu-digital-twin.${instance}.daily-memory`
  };
}

export function resolveInside(root, relative, field = "path") {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) {
    throw new ProductError("INVALID_PRIVATE_PATH", `${field} must be relative to the installation root`);
  }
  const normalized = path.normalize(relative);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new ProductError("INVALID_PRIVATE_PATH", `${field} must stay inside the installation root`);
  }
  return path.join(root, normalized);
}

async function existingMetadata(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function ensurePrivateDirectory(directory) {
  const metadata = await existingMetadata(directory);
  if (metadata?.isSymbolicLink()) {
    throw new ProductError("PRIVATE_ROOT_SYMLINK", "private installation directories cannot be symlinks");
  }
  if (metadata && !metadata.isDirectory()) {
    throw new ProductError("PRIVATE_ROOT_NOT_DIRECTORY", "private installation path must be a directory");
  }
  if (!metadata) await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function writePrivateJson(filename, value) {
  await ensurePrivateDirectory(path.dirname(filename));
  const temporary = `${filename}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
  await chmod(filename, 0o600);
}

export async function readJson(filename, code = "INVALID_JSON") {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new ProductError(code, "required local metadata could not be read");
  }
}

export async function readDistributionManifest(sourceRoot) {
  const [manifest, pluginManifest] = await Promise.all([
    readJson(path.join(sourceRoot, "package.json"), "INVALID_PACKAGE"),
    readJson(path.join(sourceRoot, ".codex-plugin/plugin.json"), "INVALID_PACKAGE")
  ]);
  if (
    manifest?.name !== "feishu-digital-twin" ||
    !SEMVER.test(manifest?.version ?? "") ||
    !Number.isInteger(manifest?.feishuDigitalTwin?.stateFormat) ||
    manifest.feishuDigitalTwin.stateFormat < 1 ||
    pluginManifest?.name !== manifest.name ||
    pluginManifest?.version !== manifest.version
  ) {
    throw new ProductError("INVALID_PACKAGE", "source must be a versioned feishu-digital-twin package");
  }
  return manifest;
}

async function copyRegularTree(source, destination) {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) {
    throw new ProductError("PACKAGE_SYMLINK", "distribution entries cannot contain symlinks");
  }
  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: metadata.mode & 0o777 });
    for (const entry of await readdir(source)) {
      await copyRegularTree(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new ProductError("PACKAGE_SPECIAL_FILE", "distribution entries must be regular files");
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  await chmod(destination, metadata.mode & 0o777);
}

function pathsOverlap(first, second) {
  const a = path.resolve(first);
  const b = path.resolve(second);
  const aToB = path.relative(a, b);
  const bToA = path.relative(b, a);
  const contains = (relative) => relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`)
  );
  return contains(aToB) || contains(bToA);
}

export async function validateInstalledVersion(versionRoot) {
  for (const required of REQUIRED_INSTALLED_PATHS) {
    const metadata = await existingMetadata(path.join(versionRoot, required));
    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      throw new ProductError("INCOMPLETE_VERSION", "installed version is missing required product files");
    }
  }
  return readDistributionManifest(versionRoot);
}

export async function installVersion({ sourceRoot, installationRoot }) {
  const source = path.resolve(sourceRoot);
  const targetRoot = path.resolve(installationRoot);
  if (pathsOverlap(source, targetRoot)) {
    throw new ProductError("OVERLAPPING_INSTALLATION", "source and installation roots must be separate");
  }
  const manifest = await readDistributionManifest(source);
  const versionsRoot = path.join(targetRoot, "versions");
  await ensurePrivateDirectory(targetRoot);
  await ensurePrivateDirectory(versionsRoot);
  const destination = path.join(versionsRoot, manifest.version);
  const existing = await existingMetadata(destination);
  if (existing) {
    const installedManifest = await validateInstalledVersion(destination);
    return {
      version: manifest.version,
      state_format: installedManifest.feishuDigitalTwin.stateFormat,
      installed: false
    };
  }
  const staging = path.join(versionsRoot, `.staging-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const entry of DISTRIBUTION_ENTRIES) {
      await copyRegularTree(path.join(source, entry), path.join(staging, entry));
    }
    await validateInstalledVersion(staging);
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    version: manifest.version,
    state_format: manifest.feishuDigitalTwin.stateFormat,
    installed: true
  };
}

export async function readInstallation(root, { required = true } = {}) {
  const rootMetadata = await existingMetadata(root);
  if (rootMetadata?.isSymbolicLink()) {
    throw new ProductError("PRIVATE_ROOT_SYMLINK", "private installation directories cannot be symlinks");
  }
  if (rootMetadata && !rootMetadata.isDirectory()) {
    throw new ProductError("PRIVATE_ROOT_NOT_DIRECTORY", "private installation path must be a directory");
  }
  const installation = await readJson(path.join(root, "installation.json"), "INVALID_INSTALLATION");
  if (!installation) {
    if (!required) return null;
    throw new ProductError("NOT_INITIALIZED", "run init before using this command");
  }
  if (
    installation.schema_version !== INSTALLATION_SCHEMA_VERSION ||
    !SEMVER.test(installation.active_version ?? "") ||
    !INSTANCE_NAME.test(installation.instance ?? "") ||
    !Number.isInteger(installation.state_format) ||
    installation.state_format < 1 ||
    typeof installation.config_path !== "string" ||
    typeof installation.state_database !== "string"
  ) {
    throw new ProductError("INVALID_INSTALLATION", "local installation metadata is invalid");
  }
  const expectedLabels = serviceLabels(installation.instance);
  if (!Object.entries(expectedLabels).every(([role, label]) => (
    installation.services?.[role] === label
  ))) {
    throw new ProductError("INVALID_INSTALLATION", "local service identities are invalid");
  }
  resolveInside(root, installation.config_path, "config_path");
  resolveInside(root, installation.state_database, "state_database");
  await validateInstalledVersion(path.join(root, "versions", installation.active_version));
  return installation;
}

export function activeVersionRoot(root, installation) {
  return path.join(root, "versions", installation.active_version);
}

export async function writeLauncher(root) {
  const filename = path.join(root, "launcher.mjs");
  const source = `#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const installation = JSON.parse(await readFile(path.join(root, "installation.json"), "utf8"));
const versionRoot = path.join(root, "versions", installation.active_version);
const entry = path.join(versionRoot, "bin", "feishu-digital-twin.mjs");
const boundedPrivacyValue = (value, fallback) => (
  Number.isSafeInteger(value) && value > 0 && value <= fallback ? value : fallback
);
let signalLogMaxBytes = Number("1048576");
let signalLogRetentionSeconds = Number("604800");
try {
  const config = JSON.parse(await readFile(
    path.join(root, installation.config_path || "private/config.json"),
    "utf8"
  ));
  signalLogMaxBytes = boundedPrivacyValue(
    config.privacy?.signal_log_max_bytes,
    signalLogMaxBytes
  );
  const signalLogRetentionDays = boundedPrivacyValue(
    config.privacy?.signal_log_retention_days,
    7
  );
  signalLogRetentionSeconds = signalLogRetentionDays * 24 * 60 * 60;
} catch {
  // Keep the built-in privacy ceiling when configuration is unavailable.
}
const forwarded = process.argv.slice(2);
const serviceLogs = {
  realtime: "realtime.stderr.log",
  supplement: "supplement.stderr.log",
  daily_memory: "daily-memory.stderr.log"
};
const serviceRole = forwarded[0] === "service" && forwarded[1] === "run" &&
  Object.hasOwn(serviceLogs, forwarded[2]) ? forwarded[2] : null;
const child = spawn(
  process.execPath,
  [entry, "--root", root, ...forwarded],
  { stdio: serviceRole ? ["inherit", "inherit", "pipe"] : "inherit" }
);
const logger = serviceRole ? spawn(process.execPath, [
  path.join(versionRoot, "ops", "service-result-log.mjs"),
  path.join(root, "private", "logs", serviceLogs[serviceRole]),
  String(signalLogMaxBytes),
  String(signalLogRetentionSeconds),
  "signal",
  serviceRole
], {
  stdio: ["pipe", "inherit", "inherit"]
}) : null;
const wait = (processHandle) => new Promise((resolve) => {
  let failedToStart = false;
  processHandle.once("error", () => { failedToStart = true; });
  processHandle.once("close", (code, signal) => resolve({ code, signal, failedToStart }));
});
const childExitPromise = wait(child);
const loggerExitPromise = logger
  ? wait(logger)
  : Promise.resolve({ code: 0, signal: null, failedToStart: false });
if (logger) {
  logger.stdin.on("error", () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  child.stderr.pipe(logger.stdin);
  void loggerExitPromise.then(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    if (logger && logger.exitCode === null && logger.signalCode === null) logger.kill(signal);
  });
}
const [childExit, loggerExit] = await Promise.all([childExitPromise, loggerExitPromise]);
const exitCode = (result) => {
  if (result.failedToStart || result.signal) return 1;
  return Number.isInteger(result.code) ? result.code : 1;
};
process.exitCode = exitCode(childExit) || exitCode(loggerExit);
`;
  const temporary = `${filename}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o700);
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
  await chmod(filename, 0o700);
}

export async function removeInstalledRuntime(root, { purge = false } = {}) {
  if (purge) {
    await rm(root, { recursive: true, force: true });
    return;
  }
  await Promise.all([
    rm(path.join(root, "versions"), { recursive: true, force: true }),
    rm(path.join(root, "launcher.mjs"), { force: true }),
    rm(path.join(root, "installation.json"), { force: true })
  ]);
}
