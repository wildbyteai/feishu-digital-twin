import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import process from "node:process";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import {
  loadPrivateScanPolicy,
  mergePrivateScanPolicyWithInstanceConfig,
  scanPublicBuffers,
  scanPublicFiles
} from "./public-content-scan.mjs";
import { loadInstanceConfig } from "../runtime/src/config-loader.mjs";

const BLOCK_SIZE = 512;
const MAX_PUBLIC_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const PACKAGE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const FORBIDDEN_PATH_SEGMENTS = new Set([
  ".git",
  ".scratch",
  ".runtime",
  ".codex-runtime",
  ".workbuddy",
  ".private",
  ".overlay",
  "private",
  "private-overlay",
  "overlay"
]);
const UNRESOLVED_PROVENANCE_ORIGINS = new Set([
  "mystery",
  "n-a",
  "none",
  "pending",
  "tbd",
  "todo",
  "unknown",
  "unspecified"
]);
const FORBIDDEN_PUBLIC_PATH_SUFFIXES = [".privacy-key"];

export class PublicSnapshotError extends Error {
  constructor(stage, code, options = {}) {
    super(code, options);
    this.name = "PublicSnapshotError";
    this.stage = stage;
    this.code = code;
    this.finding_codes = options.findingCodes ?? [];
    this.secondary_codes = options.secondaryCodes ?? [];
  }
}

function fail(stage, code, options) {
  throw new PublicSnapshotError(stage, code, options);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeReceiptTimestamp(value) {
  if (typeof value !== "string" || value.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return value;
}

function safeReceiptViolationCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(value)
    ? value
    : "redacted-violation-code";
}

function continuityReceiptEvidence(value, { healthy = value?.healthy === true } = {}) {
  const capturedAt = safeReceiptTimestamp([
    value?.current_captured_at,
    value?.captured_at,
    value?.baseline_captured_at
  ].find((candidate) => typeof candidate === "string") ?? null);
  const violationCodes = [...new Set((value?.violations ?? [])
    .map((violation) => violation?.code)
    .filter((code) => code !== undefined)
    .map(safeReceiptViolationCode))].sort();
  const projection = {
    healthy: healthy === true,
    captured_at: capturedAt,
    violation_codes: violationCodes
  };
  return {
    ...projection,
    evidence_sha256: sha256(`${canonicalJson(projection)}\n`),
    source_evidence_sha256: sha256(`${canonicalJson(value ?? null)}\n`)
  };
}

async function readJson(filename, description) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    throw new TypeError(`${description} must be valid JSON`, { cause: error });
  }
}

function isSortedUnique(values) {
  return values.every((value, index) => (
    index === 0 || values[index - 1].localeCompare(value, "en") < 0
  ));
}

function requirePositiveInteger(value, field, maximum) {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${field} must be a positive integer no greater than ${maximum}`);
  }
}

function normalizedPublicPath(value) {
  return typeof value === "string" && value.length > 0 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value) &&
    !path.posix.isAbsolute(value) && !value.includes("\\") &&
    value !== "." && value !== ".." && !value.startsWith("../") &&
    path.posix.normalize(value) === value;
}

function forbiddenPublicPath(value) {
  const lowered = value.toLowerCase();
  return value.split("/").some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment.toLowerCase())) ||
    FORBIDDEN_PUBLIC_PATH_SUFFIXES.some((suffix) => lowered.endsWith(suffix));
}

export function validatePublicSnapshotPolicy(policy) {
  if (policy?.schema_version !== 1) {
    throw new TypeError("a version 1 public snapshot policy is required");
  }
  if (typeof policy.archive_prefix !== "string" ||
      !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(policy.archive_prefix)) {
    throw new TypeError("archive_prefix must be a neutral lowercase slug");
  }
  if (!Array.isArray(policy.files) || policy.files.length === 0) {
    throw new TypeError("policy.files must be a non-empty array");
  }
  requirePositiveInteger(policy.limits?.max_files, "limits.max_files", 5000);
  requirePositiveInteger(
    policy.limits?.max_total_bytes,
    "limits.max_total_bytes",
    MAX_PUBLIC_SNAPSHOT_BYTES
  );
  if (policy.files.length > policy.limits.max_files) {
    throw new TypeError("policy.files exceeds limits.max_files");
  }
  const paths = policy.files.map((entry) => entry?.path);
  if (paths.some((value) => !normalizedPublicPath(value))) {
    throw new TypeError("every public snapshot path must be normalized and project-relative");
  }
  if (!isSortedUnique(paths)) {
    throw new TypeError("public snapshot paths must be sorted and unique");
  }
  if (paths.some(forbiddenPublicPath)) {
    throw new TypeError("public snapshot path enters a forbidden private area");
  }
  if (policy.provenance === null || typeof policy.provenance !== "object" ||
      Array.isArray(policy.provenance)) {
    throw new TypeError("policy.provenance must be an object");
  }
  const provenanceEntries = Object.entries(policy.provenance);
  if (provenanceEntries.length === 0) {
    throw new TypeError("policy.provenance must not be empty");
  }
  for (const [identifier, provenance] of provenanceEntries) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(identifier) ||
        typeof provenance?.origin !== "string" ||
        !/^[a-z0-9][a-z0-9-]{2,63}$/u.test(provenance.origin) ||
        UNRESOLVED_PROVENANCE_ORIGINS.has(provenance.origin) ||
        typeof provenance.synthetic !== "boolean") {
      throw new TypeError("every provenance requires a neutral id, origin and synthetic flag");
    }
  }
  const referencedProvenance = new Set();
  for (const entry of policy.files) {
    if (typeof entry?.provenance !== "string" || !entry.provenance) {
      throw new TypeError("every public snapshot file requires provenance");
    }
    const provenance = policy.provenance[entry.provenance];
    if (!provenance || typeof provenance.origin !== "string" || !provenance.origin ||
        typeof provenance.synthetic !== "boolean") {
      throw new TypeError("every referenced provenance requires origin and synthetic");
    }
    referencedProvenance.add(entry.provenance);
  }
  if (referencedProvenance.size !== provenanceEntries.length) {
    throw new TypeError("every provenance entry must be referenced by at least one file");
  }
  return policy;
}

function spawnGit(sourceRoot, args, {
  input,
  encoding = "utf8",
  maxBuffer = 5 * 1024 * 1024,
  literalPathspecs = true
} = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  Object.assign(env, {
    LC_ALL: "C",
    LANG: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1"
  });
  if (literalPathspecs) env.GIT_LITERAL_PATHSPECS = "1";
  const result = spawnSync("git", [
    "--no-optional-locks",
    ...(literalPathspecs ? ["--literal-pathspecs"] : []),
    "--no-lazy-fetch",
    "--no-replace-objects",
    "-c", "core.fsmonitor=false",
    ...args
  ], {
    cwd: sourceRoot,
    encoding,
    env,
    input,
    maxBuffer,
    timeout: 10_000
  });
  return result;
}

function runGit(sourceRoot, args, options) {
  const result = spawnGit(sourceRoot, args, options);
  if (result.error || result.status !== 0) fail("source-selection", "git-check-failed");
  return result.stdout ?? "";
}

function runGitBuffer(sourceRoot, args, options = {}) {
  const result = spawnGit(sourceRoot, args, { ...options, encoding: null });
  if (result.error || result.status !== 0) fail("source-selection", "git-check-failed");
  return result.stdout ?? Buffer.alloc(0);
}

function repositoryHead(sourceRoot) {
  const objectFormat = runGit(
    sourceRoot,
    ["rev-parse", "--show-object-format=storage"]
  ).trim();
  if (!new Set(["sha1", "sha256"]).has(objectFormat)) {
    fail("source-selection", "unsupported-git-object-format");
  }
  const commitOid = runGit(
    sourceRoot,
    ["rev-parse", "--verify", "-q", "HEAD^{commit}"]
  ).trim();
  const expectedLength = objectFormat === "sha256" ? 64 : 40;
  if (!new RegExp(`^[a-f0-9]{${expectedLength}}$`, "u").test(commitOid)) {
    fail("source-selection", "unsupported-git-object-format");
  }
  return { objectFormat, commitOid, expectedOidLength: expectedLength };
}

function repositoryStageEntry(sourceRoot, relativePath) {
  const output = runGit(sourceRoot, ["ls-files", "--stage", "-z", "--", relativePath]);
  const records = output.split("\0").filter(Boolean);
  if (records.length !== 1) fail("source-selection", "source-not-tracked");
  const match = records[0].match(/^(\d{6}) ([a-f0-9]+) (\d)\t([\s\S]+)$/u);
  if (!match || match[3] !== "0" || match[4] !== relativePath) {
    fail("source-selection", "unsupported-git-entry");
  }
  if (!new Set(["100644", "100755"]).has(match[1])) {
    fail("source-selection", match[1] === "120000" ? "source-symlink" : "unsupported-git-entry");
  }
  return { mode: match[1], objectId: match[2] };
}

function headStageEntry(sourceRoot, commitOid, relativePath) {
  const output = runGit(sourceRoot, ["ls-tree", "-z", commitOid, "--", relativePath]);
  const records = output.split("\0").filter(Boolean);
  if (records.length !== 1) fail("source-selection", "source-file-dirty");
  const match = records[0].match(/^(\d{6}) blob ([a-f0-9]+)\t([\s\S]+)$/u);
  if (!match || match[3] !== relativePath) fail("source-selection", "source-file-dirty");
  return { mode: match[1], objectId: match[2] };
}

function assertSafeIndexFlags(sourceRoot, relativePath) {
  const output = runGit(sourceRoot, ["ls-files", "-v", "-z", "--", relativePath]);
  const records = output.split("\0").filter(Boolean);
  if (records.length !== 1 || records[0] !== `H ${relativePath}`) {
    fail("source-selection", "source-index-flags");
  }
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function assertSafeSourceParentChain(root, target) {
  const relativeParent = path.relative(root, path.dirname(target));
  if (relativeParent === ".." || relativeParent.startsWith(`..${path.sep}`)) {
    fail("source-selection", "source-parent-symlink");
  }
  let current = root;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      fail("source-selection", "source-file-missing");
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail("source-selection", "source-parent-symlink");
    }
  }
}

async function assertRepositoryNotBusy(sourceRoot) {
  const gitLock = runGit(sourceRoot, ["rev-parse", "--git-path", "index.lock"]).trim();
  const lockPath = path.isAbsolute(gitLock) ? gitLock : path.resolve(sourceRoot, gitLock);
  try {
    await lstat(lockPath);
    fail("source-selection", "source-repository-busy");
  } catch (error) {
    if (error instanceof PublicSnapshotError) throw error;
    if (error?.code !== "ENOENT") fail("source-selection", "git-check-failed");
  }
}

async function inspectSourceSelection(sourceRoot, policy, { captureContents = true } = {}) {
  const resolvedRoot = await realpath(sourceRoot);
  const gitRoot = await realpath(runGit(sourceRoot, ["rev-parse", "--show-toplevel"]).trim());
  if (gitRoot !== resolvedRoot) fail("source-selection", "source-root-not-git-root");
  await assertRepositoryNotBusy(sourceRoot);
  const head = repositoryHead(sourceRoot);
  const records = [];
  const contents = new Map();
  let totalBytes = 0;
  for (const entry of policy.files) {
    const target = path.join(resolvedRoot, ...entry.path.split("/"));
    await assertSafeSourceParentChain(resolvedRoot, target);
    let metadata;
    let resolvedTarget;
    try {
      metadata = await lstat(target);
      resolvedTarget = await realpath(target);
    } catch {
      fail("source-selection", "source-file-missing");
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || !contained(resolvedRoot, resolvedTarget)) {
      fail("source-selection", "source-not-regular-file");
    }
    if (resolvedTarget !== target) fail("source-selection", "source-parent-symlink");
    if (metadata.size > policy.limits.max_total_bytes - totalBytes) {
      fail("source-selection", "source-size-limit-exceeded");
    }
    const indexEntry = repositoryStageEntry(sourceRoot, entry.path);
    if (!new RegExp(`^[a-f0-9]{${head.expectedOidLength}}$`, "u").test(indexEntry.objectId)) {
      fail("source-selection", "unsupported-git-entry");
    }
    assertSafeIndexFlags(sourceRoot, entry.path);
    const headEntry = headStageEntry(sourceRoot, head.commitOid, entry.path);
    if (canonicalJson(indexEntry) !== canonicalJson(headEntry)) {
      fail("source-selection", "source-file-dirty");
    }
    const content = await readFile(target);
    await assertSafeSourceParentChain(resolvedRoot, target);
    if (await realpath(target) !== target) fail("source-selection", "source-parent-symlink");
    const worktreeObject = runGit(
      sourceRoot,
      ["hash-object", "--no-filters", "--stdin"],
      { input: content }
    ).trim();
    if (worktreeObject !== indexEntry.objectId) fail("source-selection", "source-file-dirty");
    const canonicalBlob = runGitBuffer(
      sourceRoot,
      ["cat-file", "blob", indexEntry.objectId],
      { maxBuffer: Math.max(5 * 1024 * 1024, content.length + 1024 * 1024) }
    );
    if (!canonicalBlob.equals(content)) fail("source-selection", "source-file-dirty");
    const expectedMode = indexEntry.mode === "100755" ? 0o755 : 0o644;
    if ((metadata.mode & 0o7777) !== expectedMode) fail("source-selection", "source-unsafe-mode");
    if (content.subarray(0, 80).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1")) {
      fail("source-selection", "git-lfs-pointer");
    }
    totalBytes += content.length;
    if (totalBytes > policy.limits.max_total_bytes) {
      fail("source-selection", "source-size-limit-exceeded");
    }
    const provenance = policy.provenance[entry.provenance];
    records.push({
      path: entry.path,
      mode: indexEntry.mode === "100755" ? "0755" : "0644",
      bytes: content.length,
      sha256: sha256(content),
      provenance: entry.provenance,
      synthetic: provenance.synthetic
    });
    if (captureContents) contents.set(entry.path, content);
  }
  await assertRepositoryNotBusy(sourceRoot);
  return {
    commit_oid: head.commitOid,
    object_format: head.objectFormat,
    records,
    contents
  };
}

async function assertSourceSelectionUnchanged(sourceRoot, policy, expected) {
  const current = await inspectSourceSelection(sourceRoot, policy, { captureContents: false });
  if (current.commit_oid !== expected.commit_oid ||
      current.object_format !== expected.object_format ||
      canonicalJson(current.records) !== canonicalJson(expected.records)) {
    fail("source-selection", "source-selection-drift");
  }
}

function scanSummary(report) {
  return {
    scanner_version: report.scanner_version,
    stage: report.stage,
    file_count: report.file_count,
    finding_count: report.finding_count
  };
}

function assertCleanScan(report) {
  if (report.finding_count > 0) {
    fail(report.stage, "privacy-scan-failed", {
      findingCodes: [...new Set(report.findings.map((finding) => finding.code))].sort()
    });
  }
}

async function assertNoSymlinkDirectoryChain(root, target) {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        fail("initialization", "output-root-parent-symlink");
      }
    } catch (error) {
      if (error instanceof PublicSnapshotError) throw error;
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
}

async function ensureOutputRoot(outputRoot, sourceRoot) {
  const sourceLexical = path.resolve(sourceRoot);
  const outputLexical = path.resolve(outputRoot);
  const outputInsideSource = contained(sourceLexical, outputLexical);
  if (outputInsideSource) {
    const relativeOutput = path.relative(sourceLexical, outputLexical).split(path.sep).join("/");
    if (!relativeOutput.startsWith(".runtime/")) {
      fail("initialization", "output-root-not-private");
    }
    await assertNoSymlinkDirectoryChain(sourceLexical, outputLexical);
    const ignored = spawnGit(sourceRoot, [
      "check-ignore", "-q", "--no-index", "--", relativeOutput
    ], { literalPathspecs: false });
    if (ignored.error || ignored.status !== 0) fail("initialization", "output-root-not-private");
    await mkdir(outputLexical, { recursive: true, mode: 0o700 });
    await assertNoSymlinkDirectoryChain(sourceLexical, outputLexical);
  } else {
    try {
      await lstat(outputLexical);
    } catch {
      fail("initialization", "external-output-root-must-exist");
    }
  }
  outputRoot = outputLexical;
  const metadata = await lstat(outputRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("initialization", "output-root-not-directory");
  }
  if ((metadata.mode & 0o077) !== 0) fail("initialization", "output-root-permissions");
  const [resolvedOutput, resolvedSource] = await Promise.all([realpath(outputRoot), realpath(sourceRoot)]);
  if (resolvedOutput === resolvedSource || contained(resolvedOutput, resolvedSource)) {
    fail("initialization", "output-root-contains-source");
  }
  const resolvedOutputInsideSource = contained(resolvedSource, resolvedOutput);
  if (resolvedOutputInsideSource) {
    const relativeOutput = path.relative(resolvedSource, resolvedOutput).split(path.sep).join("/");
    if (!relativeOutput.startsWith(".runtime/")) {
      fail("initialization", "output-root-not-private");
    }
    await assertNoSymlinkDirectoryChain(resolvedSource, resolvedOutput);
    const ignored = spawnGit(sourceRoot, [
      "check-ignore", "-q", "--no-index", "--", relativeOutput
    ], { literalPathspecs: false });
    if (ignored.error || ignored.status !== 0) fail("initialization", "output-root-not-private");
  } else if (outputInsideSource) {
    fail("initialization", "output-root-parent-symlink");
  }
  return resolvedOutput;
}

async function ensureOutputSubdirectory(outputRoot, name, stage) {
  const target = path.join(outputRoot, name);
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    fail(stage, "output-subdirectory-unsafe");
  }
  const resolvedTarget = await realpath(target);
  if (!contained(outputRoot, resolvedTarget) || path.dirname(resolvedTarget) !== outputRoot) {
    fail(stage, "output-subdirectory-unsafe");
  }
  return resolvedTarget;
}

async function writeExclusive(filename, content, mode = 0o600) {
  const handle = await open(filename, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

async function rewriteExisting(filename, content, mode = 0o600) {
  const handle = await open(filename, "r+");
  try {
    await handle.truncate(0);
    await handle.writeFile(content);
    await handle.sync();
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail("promotion", "candidate-non-regular-entry");
    if (entry.isDirectory()) {
      await syncDirectoryTree(path.join(directory, entry.name));
    }
  }
  await syncDirectory(directory);
}

function writeTarString(header, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) fail("archive-create", "archive-path-too-long");
  encoded.copy(header, offset);
}

function tarOctal(value, length) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) fail("archive-create", "archive-number-overflow");
  return `${encoded}\0`;
}

function splitTarPath(relativePath) {
  if (Buffer.byteLength(relativePath) <= 100) return { name: relativePath, prefix: "" };
  const separators = [...relativePath.matchAll(/\//gu)].map((match) => match.index).reverse();
  for (const index of separators) {
    const prefix = relativePath.slice(0, index);
    const name = relativePath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  fail("archive-create", "archive-path-too-long");
}

function tarHeader(record) {
  const header = Buffer.alloc(BLOCK_SIZE);
  const { name, prefix } = splitTarPath(record.path);
  writeTarString(header, 0, 100, name);
  writeTarString(header, 100, 8, tarOctal(Number.parseInt(record.mode, 8), 8));
  writeTarString(header, 108, 8, tarOctal(0, 8));
  writeTarString(header, 116, 8, tarOctal(0, 8));
  writeTarString(header, 124, 12, tarOctal(record.bytes, 12));
  writeTarString(header, 136, 12, tarOctal(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");
  writeTarString(header, 345, 155, prefix);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

async function writePublicTarArchive({
  treeRoot,
  records,
  archivePath,
  pathPrefix = ""
}) {
  const handle = await open(archivePath, "wx", 0o644);
  try {
    for (const record of records) {
      const content = await readFile(path.join(treeRoot, ...record.path.split("/")));
      await handle.write(tarHeader({
        ...record,
        path: pathPrefix ? `${pathPrefix}/${record.path}` : record.path
      }));
      await handle.write(content);
      const padding = (BLOCK_SIZE - (content.length % BLOCK_SIZE)) % BLOCK_SIZE;
      if (padding > 0) await handle.write(Buffer.alloc(padding));
    }
    await handle.write(Buffer.alloc(BLOCK_SIZE * 2));
    await handle.sync();
    await handle.chmod(0o644);
  } finally {
    await handle.close();
  }
}

async function syncArtifactFile(filename) {
  const handle = await open(filename, "r+");
  try {
    await handle.sync();
    await handle.chmod(0o644);
  } finally {
    await handle.close();
  }
}

async function gzipTarArchive({ tarPath, archivePath, stage }) {
  try {
    await pipeline(
      createReadStream(tarPath),
      createGzip({ level: 9, mtime: 0 }),
      createWriteStream(archivePath, { flags: "wx", mode: 0o644 })
    );
    await syncArtifactFile(archivePath);
  } catch (error) {
    await rm(archivePath, { force: true }).catch(() => {});
    if (error instanceof PublicSnapshotError) throw error;
    fail(stage, "npm-archive-create-failed", { cause: error });
  }
}

function maximumTarBytes(limits) {
  return limits.max_total_bytes +
    limits.max_files * BLOCK_SIZE * 2 +
    BLOCK_SIZE * 2;
}

async function gunzipTarArchive({ archivePath, tarPath, limits, stage }) {
  const compressedSize = (await stat(archivePath)).size;
  if (compressedSize > maximumTarBytes(limits)) {
    fail(stage, "npm-archive-size-limit-exceeded");
  }
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > maximumTarBytes(limits)) {
        callback(new PublicSnapshotError(stage, "npm-unpacked-size-limit-exceeded"));
        return;
      }
      callback(null, chunk);
    }
  });
  try {
    await pipeline(
      createReadStream(archivePath),
      createGunzip(),
      limiter,
      createWriteStream(tarPath, { flags: "wx", mode: 0o644 })
    );
    await syncArtifactFile(tarPath);
  } catch (error) {
    await rm(tarPath, { force: true }).catch(() => {});
    if (error instanceof PublicSnapshotError) throw error;
    fail(stage, "npm-archive-invalid", { cause: error });
  }
}

function tarText(header, offset, length) {
  const end = header.indexOf(0, offset);
  return header.subarray(offset, end >= offset && end < offset + length ? end : offset + length)
    .toString("utf8");
}

function tarNumber(header, offset, length) {
  const value = tarText(header, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) fail("archive-unpacked", "archive-invalid-number");
  return Number.parseInt(value, 8);
}

function verifyTarChecksum(header) {
  const expected = tarNumber(header, 148, 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((total, byte) => total + byte, 0);
  if (actual !== expected) fail("archive-unpacked", "archive-checksum-mismatch");
}

async function readFileRange(handle, position, length, archiveSize) {
  if (position < 0 || length < 0 || position + length > archiveSize) {
    fail("archive-unpacked", "archive-truncated");
  }
  const buffer = Buffer.alloc(length);
  let readBytes = 0;
  while (readBytes < length) {
    const result = await handle.read(buffer, readBytes, length - readBytes, position + readBytes);
    if (result.bytesRead === 0) fail("archive-unpacked", "archive-truncated");
    readBytes += result.bytesRead;
  }
  return buffer;
}

async function digestFile(filename) {
  const handle = await open(filename, "r");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      bytes += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function extractCanonicalTarArchive({ archivePath, targetRoot, limits }) {
  const archiveSize = (await stat(archivePath)).size;
  const maximumArchiveBytes = limits.max_total_bytes +
    limits.max_files * BLOCK_SIZE * 2 +
    BLOCK_SIZE * 2;
  if (archiveSize > maximumArchiveBytes) {
    fail("archive-unpacked", "archive-size-limit-exceeded");
  }
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const archive = await open(archivePath, "r");
  const records = [];
  const seen = new Set();
  let extractedBytes = 0;
  let offset = 0;
  let zeroBlocks = 0;
  try {
    while (offset < archiveSize) {
      const header = await readFileRange(archive, offset, BLOCK_SIZE, archiveSize);
      offset += BLOCK_SIZE;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks === 2) break;
        continue;
      }
      if (zeroBlocks > 0) fail("archive-unpacked", "archive-data-after-end-marker");
      verifyTarChecksum(header);
      const name = tarText(header, 0, 100);
      const prefix = tarText(header, 345, 155);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (!normalizedPublicPath(relativePath) || forbiddenPublicPath(relativePath)) {
        fail("archive-unpacked", "archive-unsafe-path");
      }
      if (seen.has(relativePath)) fail("archive-unpacked", "archive-duplicate-path");
      if (records.length >= limits.max_files) {
        fail("archive-unpacked", "archive-file-limit-exceeded");
      }
      seen.add(relativePath);
      const type = header[156];
      if (type !== 0 && type !== "0".charCodeAt(0)) {
        fail("archive-unpacked", "archive-non-regular-entry");
      }
      if (tarText(header, 157, 100)) fail("archive-unpacked", "archive-link-entry");
      const size = tarNumber(header, 124, 12);
      if (!Number.isSafeInteger(size) || size < 0) fail("archive-unpacked", "archive-invalid-number");
      if (extractedBytes + size > limits.max_total_bytes) {
        fail("archive-unpacked", "archive-extracted-size-limit-exceeded");
      }
      const modeValue = tarNumber(header, 100, 8) & 0o7777;
      if (!new Set([0o644, 0o755]).has(modeValue)) {
        fail("archive-unpacked", "archive-unsafe-mode");
      }
      const canonicalMode = modeValue === 0o755 ? "0755" : "0644";
      if (!header.equals(tarHeader({
        path: relativePath,
        mode: canonicalMode,
        bytes: size
      }))) {
        fail("archive-unpacked", "archive-noncanonical-header");
      }
      const padding = (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
      if (offset + size + padding > archiveSize) fail("archive-unpacked", "archive-truncated");
      const target = path.join(targetRoot, ...relativePath.split("/"));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const targetHandle = await open(target, "wx", modeValue);
      const digest = createHash("sha256");
      let written = false;
      try {
        let remaining = size;
        let sourcePosition = offset;
        while (remaining > 0) {
          const chunkLength = Math.min(remaining, 64 * 1024);
          const chunk = await readFileRange(archive, sourcePosition, chunkLength, archiveSize);
          await targetHandle.write(chunk);
          digest.update(chunk);
          sourcePosition += chunkLength;
          remaining -= chunkLength;
        }
        await targetHandle.sync();
        await targetHandle.chmod(modeValue);
        written = true;
      } finally {
        await targetHandle.close();
        if (!written) {
          try {
            await unlink(target);
          } catch {
            // The owned verification tree is removed with the attempt on failure.
          }
        }
      }
      offset += size;
      if (padding > 0) {
        const paddingBytes = await readFileRange(archive, offset, padding, archiveSize);
        if (paddingBytes.some((byte) => byte !== 0)) {
          fail("archive-unpacked", "archive-invalid-padding");
        }
        offset += padding;
      }
      extractedBytes += size;
      records.push({
        path: relativePath,
        mode: modeValue === 0o755 ? "0755" : "0644",
        bytes: size,
        sha256: digest.digest("hex")
      });
    }
    if (zeroBlocks < 2) fail("archive-unpacked", "archive-missing-end-marker");
    while (offset < archiveSize) {
      const chunkLength = Math.min(archiveSize - offset, 64 * 1024);
      const trailing = await readFileRange(archive, offset, chunkLength, archiveSize);
      if (trailing.some((byte) => byte !== 0)) {
        fail("archive-unpacked", "archive-data-after-end-marker");
      }
      offset += chunkLength;
    }
    return records;
  } finally {
    await archive.close();
  }
}

async function extractPublicTarArchive(options) {
  try {
    return await extractCanonicalTarArchive(options);
  } catch (error) {
    const stage = options.stage ?? "archive-unpacked";
    if (
      error instanceof PublicSnapshotError &&
      error.stage === "archive-unpacked" &&
      stage !== "archive-unpacked"
    ) {
      throw new PublicSnapshotError(stage, error.code, {
        cause: error,
        findingCodes: error.finding_codes,
        secondaryCodes: error.secondary_codes
      });
    }
    throw error;
  }
}

async function enumerateTree(root) {
  const records = [];
  async function visit(current, prefix) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        fail("staging-tree", "staging-non-regular-entry");
      }
      if (entry.isDirectory()) await visit(target, relativePath);
      else {
        const [metadata, content] = await Promise.all([stat(target), readFile(target)]);
        const modeValue = metadata.mode & 0o7777;
        if (!new Set([0o644, 0o755]).has(modeValue)) {
          fail("staging-tree", "staging-unsafe-mode");
        }
        records.push({
          path: relativePath,
          mode: modeValue === 0o755 ? "0755" : "0644",
          bytes: content.length,
          sha256: sha256(content)
        });
      }
    }
  }
  await visit(root, "");
  return records.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function spdxFileId(relativePath) {
  return `SPDXRef-File-${sha256(relativePath).slice(0, 24)}`;
}

async function createSpdxSbom({ treeRoot, sourceRecords, release, treeSha256 }) {
  const sha1Values = [];
  for (const record of sourceRecords) {
    const content = await readFile(path.join(treeRoot, ...record.path.split("/")));
    if (content.length !== record.bytes || sha256(content) !== record.sha256) {
      fail("sbom-create", "sbom-source-drift");
    }
    sha1Values.push(createHash("sha1").update(content).digest("hex"));
  }
  sha1Values.sort((left, right) => left.localeCompare(right, "en"));
  const packageVerificationCode = createHash("sha1")
    .update(sha1Values.join(""))
    .digest("hex");
  const packageId = "SPDXRef-Package";
  const fileRelationships = sourceRecords.map((record) => ({
    spdxElementId: packageId,
    relationshipType: "CONTAINS",
    relatedSpdxElement: spdxFileId(record.path)
  }));
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${release.name}-${release.version}`,
    documentNamespace: `https://sbom.example.invalid/${release.name}/${release.version}/${treeSha256}`,
    creationInfo: {
      created: "1970-01-01T00:00:00Z",
      creators: [`Tool: ${release.name}-public-snapshot-${release.version}`],
      comment: "The fixed creation time keeps identical source trees reproducible."
    },
    documentDescribes: [packageId],
    packages: [{
      name: release.name,
      SPDXID: packageId,
      versionInfo: release.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: true,
      packageVerificationCode: {
        packageVerificationCodeValue: packageVerificationCode
      },
      licenseConcluded: release.license,
      licenseDeclared: release.license,
      copyrightText: "Copyright 2026 Feishu Digital Twin contributors",
      primaryPackagePurpose: "APPLICATION"
    }],
    files: sourceRecords.map((record) => ({
      fileName: `./${record.path}`,
      SPDXID: spdxFileId(record.path),
      checksums: [{ algorithm: "SHA256", checksumValue: record.sha256 }],
      licenseConcluded: release.license,
      licenseInfoInFiles: [release.license],
      copyrightText: "Copyright 2026 Feishu Digital Twin contributors"
    })),
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: packageId
      },
      ...fileRelationships
    ]
  };
}

function createLocalProvenance({
  release,
  treeSha256,
  publicPolicySha256,
  artifactRecords
}) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: artifactRecords
      .map(({ path: artifactPath, record }) => ({
        name: artifactPath,
        digest: { sha256: record.sha256 }
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "en")),
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "urn:feishu-digital-twin:buildtype:public-snapshot:v1",
        externalParameters: {
          archive_prefix: release.name,
          version: release.version,
          source_tree_sha256: treeSha256,
          public_policy_sha256: publicPolicySha256
        },
        internalParameters: {},
        resolvedDependencies: [{
          uri: "urn:feishu-digital-twin:source-tree",
          digest: { sha256: treeSha256 }
        }]
      },
      runDetails: {
        builder: {
          id: "urn:feishu-digital-twin:builder:local-public-snapshot:v1"
        }
      }
    }
  };
}

async function assertCandidateLayout(attemptPath) {
  const expected = new Map([
    ["SHA256SUMS", { type: "file", mode: 0o644 }],
    ["codex-plugin.tar", { type: "file", mode: 0o644 }],
    ["npm-package.tgz", { type: "file", mode: 0o644 }],
    ["provenance.intoto.jsonl", { type: "file", mode: 0o644 }],
    ["sbom.spdx.json", { type: "file", mode: 0o644 }],
    ["snapshot-manifest.json", { type: "file", mode: 0o644 }],
    ["source.tar", { type: "file", mode: 0o644 }],
    ["tree", { type: "directory", mode: 0o700 }]
  ]);
  const entries = await readdir(attemptPath, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort((left, right) => (
    left.localeCompare(right, "en")
  ));
  const expectedNames = [...expected.keys()].sort((left, right) => left.localeCompare(right, "en"));
  if (canonicalJson(names) !== canonicalJson(expectedNames)) {
    fail("candidate-metadata", "candidate-layout-drift");
  }
  for (const entry of entries) {
    const rule = expected.get(entry.name);
    const target = path.join(attemptPath, entry.name);
    const metadata = await lstat(target);
    const matchesType = rule.type === "directory"
      ? entry.isDirectory() && metadata.isDirectory()
      : entry.isFile() && metadata.isFile();
    if (!matchesType || entry.isSymbolicLink() || metadata.isSymbolicLink()) {
      fail("candidate-metadata", "candidate-non-regular-entry");
    }
    if ((metadata.mode & 0o7777) !== rule.mode) {
      fail("candidate-metadata", "candidate-unsafe-mode");
    }
  }
}

function assertMatchingRecords(expected, actual, stage) {
  const normalizedExpected = expected.map(({ path: filePath, mode, bytes, sha256: digest }) => ({
    path: filePath,
    mode,
    bytes,
    sha256: digest
  }));
  if (canonicalJson(normalizedExpected) !== canonicalJson(actual)) {
    fail(stage, `${stage}-content-drift`);
  }
}

function assertPrefixedRecords(expected, actual, prefix, stage) {
  const normalized = actual.map((record) => {
    const expectedPrefix = `${prefix}/`;
    if (!record.path.startsWith(expectedPrefix)) {
      fail(stage, `${stage}-content-drift`);
    }
    return {
      ...record,
      path: record.path.slice(expectedPrefix.length)
    };
  });
  assertMatchingRecords(expected, normalized, stage);
}

async function releaseMetadata(treeRoot, sourceRecords, archivePrefix) {
  let packageManifest;
  let pluginManifest;
  try {
    [packageManifest, pluginManifest] = await Promise.all([
      readJson(path.join(treeRoot, "package.json"), "candidate package manifest"),
      readJson(
        path.join(treeRoot, ".codex-plugin/plugin.json"),
        "candidate Codex plugin manifest"
      )
    ]);
  } catch (error) {
    fail("release-metadata", "release-manifest-invalid", { cause: error });
  }
  if (
    typeof packageManifest?.name !== "string" ||
    packageManifest.name !== archivePrefix ||
    pluginManifest?.name !== packageManifest.name ||
    !PACKAGE_VERSION.test(packageManifest?.version ?? "") ||
    pluginManifest?.version !== packageManifest.version ||
    packageManifest?.license !== "Apache-2.0"
  ) {
    fail("release-metadata", "release-version-mismatch");
  }
  if (
    !Array.isArray(packageManifest.files) ||
    packageManifest.files.length === 0 ||
    packageManifest.files.some((entry) => (
      !normalizedPublicPath(entry) || forbiddenPublicPath(entry)
    )) ||
    !isSortedUnique(packageManifest.files)
  ) {
    fail("release-metadata", "npm-files-invalid");
  }
  const selected = new Set();
  for (const declaredPath of packageManifest.files) {
    const matches = sourceRecords.filter((record) => (
      record.path === declaredPath || record.path.startsWith(`${declaredPath}/`)
    ));
    if (matches.length === 0) fail("release-metadata", "npm-files-invalid");
    for (const record of matches) selected.add(record.path);
  }
  if (!selected.has("package.json")) fail("release-metadata", "npm-files-invalid");
  return {
    name: packageManifest.name,
    version: packageManifest.version,
    license: packageManifest.license,
    npmRecords: sourceRecords.filter((record) => selected.has(record.path))
  };
}

async function copySelection(treeRoot, records, contents) {
  await mkdir(treeRoot, { recursive: true, mode: 0o700 });
  for (const record of records) {
    const target = path.join(treeRoot, ...record.path.split("/"));
    const content = contents.get(record.path);
    if (!Buffer.isBuffer(content) || content.length !== record.bytes || sha256(content) !== record.sha256) {
      fail("staging-tree", "source-capture-drift");
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeExclusive(target, content, Number.parseInt(record.mode, 8));
  }
}

async function assertCandidateReadback({
  attemptPath,
  manifestContent,
  checksumContent,
  artifacts,
  treeRoot,
  sourceRecords
}) {
  await assertCandidateLayout(attemptPath);
  const [manifestReadback, checksumReadback, artifactReadbacks, treeReadback] = await Promise.all([
    readFile(path.join(attemptPath, "snapshot-manifest.json")),
    readFile(path.join(attemptPath, "SHA256SUMS")),
    Promise.all(artifacts.map(async (artifact) => ({
      path: artifact.path,
      record: await digestFile(path.join(attemptPath, artifact.path))
    }))),
    enumerateTree(treeRoot)
  ]);
  const artifactDrift = artifactReadbacks.some((readback) => {
    const expected = artifacts.find((artifact) => artifact.path === readback.path)?.record;
    return canonicalJson(readback.record) !== canonicalJson(expected);
  });
  if (!manifestReadback.equals(manifestContent) || !checksumReadback.equals(checksumContent) ||
      artifactDrift) {
    fail("candidate-metadata", "candidate-metadata-content-drift");
  }
  assertMatchingRecords(sourceRecords, treeReadback, "candidate-metadata");
  await assertCandidateLayout(attemptPath);
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validateCandidateManifest(manifest) {
  if (manifest?.schema_version !== 1 ||
      typeof manifest?.version !== "string" || !PACKAGE_VERSION.test(manifest.version) ||
      typeof manifest?.archive_prefix !== "string" ||
      !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(manifest.archive_prefix) ||
      !validSha256(manifest?.policy_sha256) || !validSha256(manifest?.tree_sha256) ||
      !Array.isArray(manifest?.files) || manifest.files.length === 0) {
    fail("candidate-verify", "candidate-manifest-invalid");
  }
  try {
    validatePublicSnapshotPolicy({
      schema_version: 1,
      archive_prefix: manifest.archive_prefix,
      files: manifest.files.map((record) => ({
        path: record?.path,
        provenance: record?.provenance
      })),
      provenance: manifest.provenance,
      limits: {
        max_files: Math.max(1, manifest.files.length),
        max_total_bytes: MAX_PUBLIC_SNAPSHOT_BYTES
      }
    });
  } catch (error) {
    fail("candidate-verify", "candidate-manifest-invalid", { cause: error });
  }
  for (const record of manifest.files) {
    const provenance = manifest.provenance[record.provenance];
    if (!new Set(["0644", "0755"]).has(record?.mode) ||
        !Number.isInteger(record?.bytes) || record.bytes < 0 ||
        !validSha256(record?.sha256) ||
        record?.synthetic !== provenance.synthetic) {
      fail("candidate-verify", "candidate-manifest-invalid");
    }
  }
  return manifest;
}

function candidateArtifactRecord(manifest, key, expectedPath) {
  const artifact = manifest?.artifacts?.[key];
  if (artifact?.path !== expectedPath || artifact?.version !== manifest.version ||
      artifact?.source_tree_sha256 !== manifest.tree_sha256 ||
      !Number.isInteger(artifact?.bytes) || artifact.bytes < 0 ||
      !validSha256(artifact?.sha256)) {
    fail("candidate-verify", "candidate-manifest-invalid");
  }
  return { path: expectedPath, record: { bytes: artifact.bytes, sha256: artifact.sha256 } };
}

function assertCandidateSupplyChainMetadata({ manifest, sbomContent, provenanceContent }) {
  let sbom;
  let provenance;
  try {
    sbom = JSON.parse(sbomContent.toString("utf8"));
    const lines = provenanceContent.toString("utf8").trim().split(/\r?\n/u);
    if (lines.length !== 1) throw new TypeError("one provenance statement is required");
    provenance = JSON.parse(lines[0]);
  } catch (error) {
    fail("candidate-verify", "candidate-supply-chain-metadata-invalid", { cause: error });
  }
  const packageEntry = Array.isArray(sbom?.packages) && sbom.packages.length === 1
    ? sbom.packages[0]
    : null;
  const sbomFiles = Array.isArray(sbom?.files) ? sbom.files : [];
  if (sbom?.spdxVersion !== "SPDX-2.3" || sbom?.dataLicense !== "CC0-1.0" ||
      packageEntry?.name !== manifest.archive_prefix ||
      packageEntry?.versionInfo !== manifest.version ||
      packageEntry?.licenseDeclared !== "Apache-2.0" ||
      sbomFiles.length !== manifest.files.length) {
    fail("candidate-verify", "candidate-supply-chain-metadata-invalid");
  }
  const sbomFileDigests = new Map(sbomFiles.map((entry) => [
    entry?.fileName,
    Array.isArray(entry?.checksums)
      ? entry.checksums.find((checksum) => checksum?.algorithm === "SHA256")?.checksumValue
      : null
  ]));
  for (const record of manifest.files) {
    if (sbomFileDigests.get(`./${record.path}`) !== record.sha256) {
      fail("candidate-verify", "candidate-supply-chain-metadata-invalid");
    }
  }
  const expectedSubjects = ["source", "codex_plugin", "npm", "sbom"]
    .map((key) => manifest.artifacts[key])
    .map((artifact) => ({ name: artifact.path, digest: { sha256: artifact.sha256 } }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (provenance?._type !== "https://in-toto.io/Statement/v1" ||
      provenance?.predicateType !== "https://slsa.dev/provenance/v1" ||
      provenance?.predicate?.buildDefinition?.externalParameters?.version !== manifest.version ||
      provenance?.predicate?.buildDefinition?.externalParameters?.source_tree_sha256 !==
        manifest.tree_sha256 ||
      provenance?.predicate?.buildDefinition?.externalParameters?.public_policy_sha256 !==
        manifest.policy_sha256 ||
      canonicalJson(provenance?.subject) !== canonicalJson(expectedSubjects) ||
      manifest.artifacts.provenance.signature_status !== "unsigned-local-record") {
    fail("candidate-verify", "candidate-supply-chain-metadata-invalid");
  }
}

export async function verifyPublicCandidate({ candidatePath }) {
  let resolvedCandidate;
  try {
    const metadata = await lstat(candidatePath);
    resolvedCandidate = await realpath(candidatePath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail("candidate-verify", "candidate-path-unsafe");
    }
    await assertCandidateLayout(resolvedCandidate);
  } catch (error) {
    if (error instanceof PublicSnapshotError) throw error;
    fail("candidate-verify", "candidate-path-unsafe", { cause: error });
  }

  let manifest;
  let manifestContent;
  let checksumContent;
  let sbomContent;
  let provenanceContent;
  try {
    [manifestContent, checksumContent, sbomContent, provenanceContent] = await Promise.all([
      readFile(path.join(resolvedCandidate, "snapshot-manifest.json")),
      readFile(path.join(resolvedCandidate, "SHA256SUMS")),
      readFile(path.join(resolvedCandidate, "sbom.spdx.json")),
      readFile(path.join(resolvedCandidate, "provenance.intoto.jsonl"))
    ]);
    manifest = validateCandidateManifest(JSON.parse(manifestContent.toString("utf8")));
  } catch (error) {
    if (error instanceof PublicSnapshotError) throw error;
    fail("candidate-verify", "candidate-manifest-invalid", { cause: error });
  }

  const treeRoot = path.join(resolvedCandidate, "tree");
  const treeRecords = await enumerateTree(treeRoot);
  assertMatchingRecords(manifest.files, treeRecords, "candidate-verify");
  const treeSha256 = sha256(`${canonicalJson(manifest.files)}\n`);
  if (treeSha256 !== manifest.tree_sha256) {
    fail("candidate-verify", "candidate-tree-digest-mismatch");
  }

  const sourceArtifact = candidateArtifactRecord(manifest, "source", "source.tar");
  const pluginArtifact = candidateArtifactRecord(
    manifest,
    "codex_plugin",
    "codex-plugin.tar"
  );
  const npmArtifact = candidateArtifactRecord(manifest, "npm", "npm-package.tgz");
  const sbomArtifact = candidateArtifactRecord(manifest, "sbom", "sbom.spdx.json");
  const provenanceArtifact = candidateArtifactRecord(
    manifest,
    "provenance",
    "provenance.intoto.jsonl"
  );
  const artifactRecords = [
    sourceArtifact,
    pluginArtifact,
    npmArtifact,
    sbomArtifact,
    provenanceArtifact
  ];
  const readbacks = await Promise.all(artifactRecords.map(async (artifact) => ({
    path: artifact.path,
    record: await digestFile(path.join(resolvedCandidate, artifact.path))
  })));
  for (const readback of readbacks) {
    const expected = artifactRecords.find((artifact) => artifact.path === readback.path)?.record;
    if (canonicalJson(readback.record) !== canonicalJson(expected)) {
      fail("candidate-verify", "candidate-checksum-mismatch");
    }
  }
  const manifestSha256 = sha256(manifestContent);
  const expectedChecksumLines = [
    ...manifest.files.map((record) => `${record.sha256}  tree/${record.path}`),
    `${sourceArtifact.record.sha256}  source.tar`,
    `${pluginArtifact.record.sha256}  codex-plugin.tar`,
    `${npmArtifact.record.sha256}  npm-package.tgz`,
    `${sbomArtifact.record.sha256}  sbom.spdx.json`,
    `${provenanceArtifact.record.sha256}  provenance.intoto.jsonl`,
    `${manifestSha256}  snapshot-manifest.json`
  ];
  const expectedChecksumContent = Buffer.from(`${expectedChecksumLines.join("\n")}\n`, "utf8");
  if (!checksumContent.equals(expectedChecksumContent)) {
    fail("candidate-verify", "candidate-checksum-mismatch");
  }
  assertCandidateSupplyChainMetadata({ manifest, sbomContent, provenanceContent });

  return {
    status: "verified",
    candidate_id: `sha256-${manifest.tree_sha256}`,
    version: manifest.version,
    file_count: manifest.files.length,
    tree_sha256: manifest.tree_sha256,
    archive_sha256: sourceArtifact.record.sha256,
    plugin_sha256: pluginArtifact.record.sha256,
    npm_sha256: npmArtifact.record.sha256,
    sbom_sha256: sbomArtifact.record.sha256,
    provenance_sha256: provenanceArtifact.record.sha256
  };
}

async function removeOwnedAttempt({ outputRoot, attemptPath, markerPath, runId }) {
  await assertOwnedAttempt({ outputRoot, attemptPath, markerPath, runId });
  await rm(attemptPath, { recursive: true, force: false });
  await unlink(markerPath);
}

async function assertOwnedPromotedCandidate({
  outputRoot,
  candidatePath,
  markerPath,
  runId,
  candidateId
}) {
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  const resolvedOutput = await realpath(outputRoot);
  const resolvedCandidates = await realpath(path.join(resolvedOutput, "candidates"));
  const resolvedCandidate = await realpath(candidatePath);
  if (marker.run_id !== runId || marker.status !== "attested" ||
      marker.candidate_id !== candidateId ||
      path.dirname(resolvedCandidate) !== resolvedCandidates ||
      path.basename(resolvedCandidate) !== candidateId) {
    fail("cleanup", "candidate-ownership-check-failed");
  }
}

async function removeOwnedPromotedCandidate(options) {
  await assertOwnedPromotedCandidate(options);
  await rm(options.candidatePath, { recursive: true, force: false });
  await unlink(options.markerPath);
}

async function quarantinePromotedCandidate(options) {
  await assertOwnedPromotedCandidate(options);
  const directory = await ensureOutputSubdirectory(options.outputRoot, "quarantine", "cleanup");
  const target = path.join(directory, `failed-${options.runId}`);
  await rename(options.candidatePath, target);
  await unlink(options.markerPath);
}

async function assertOwnedAttempt({ outputRoot, attemptPath, markerPath, runId }) {
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  const resolvedOutput = await realpath(outputRoot);
  const resolvedAttempt = await realpath(attemptPath);
  if (marker.run_id !== runId || !contained(resolvedOutput, resolvedAttempt) ||
      path.basename(resolvedAttempt) !== `.attempt-${runId}`) {
    fail("cleanup", "attempt-ownership-check-failed");
  }
}

async function writeFailureReceipt(outputRoot, runId, error, cleanupStatus, evidence = {}) {
  const directory = await ensureOutputSubdirectory(outputRoot, "failures", "failure-receipt");
  const codes = [
    error.code,
    ...(error.finding_codes ?? []),
    ...(error.secondary_codes ?? [])
  ].filter(Boolean);
  await writeExclusive(path.join(directory, `${runId}.json`), `${JSON.stringify({
    schema_version: 1,
    status: "failed",
    stage: error.stage ?? "unknown",
    codes: [...new Set(codes)].sort(),
    cleanup_status: cleanupStatus,
    quarantined: cleanupStatus === "quarantined",
    ...(evidence.publicPolicySha256 ? {
      public_policy_sha256: evidence.publicPolicySha256
    } : {}),
    ...(evidence.privatePolicySha256 ? {
      private_policy_sha256: evidence.privatePolicySha256
    } : {}),
    ...(evidence.manifestSha256 ? {
      manifest_sha256: evidence.manifestSha256
    } : {}),
    ...(evidence.continuityBeforeEvidence ? {
      continuity: {
        before: evidence.continuityBeforeEvidence,
        ...(evidence.continuityAfterEvidence ? { after: evidence.continuityAfterEvidence } : {})
      }
    } : {})
  })}\n`, 0o600);
}

function candidateReceiptContent({
  runId,
  candidateId,
  treeSha256,
  publicPolicySha256,
  privatePolicySha256,
  manifestSha256,
  continuityBeforeEvidence,
  continuityAfterEvidence
}) {
  return `${JSON.stringify({
    schema_version: 1,
    run_id: runId,
    status: "attested",
    candidate_id: candidateId,
    tree_sha256: treeSha256,
    public_policy_sha256: publicPolicySha256,
    private_policy_sha256: privatePolicySha256,
    manifest_sha256: manifestSha256,
    continuity: {
      before: continuityBeforeEvidence,
      after: continuityAfterEvidence
    }
  })}\n`;
}

async function quarantineAttempt({ outputRoot, attemptPath, markerPath, runId }) {
  await assertOwnedAttempt({ outputRoot, attemptPath, markerPath, runId });
  const directory = await ensureOutputSubdirectory(outputRoot, "quarantine", "cleanup");
  const target = path.join(directory, `failed-${runId}`);
  await rename(attemptPath, target);
  await unlink(markerPath);
  return true;
}

function normalizeError(error, stage) {
  if (error instanceof PublicSnapshotError) return error;
  return new PublicSnapshotError(stage, "snapshot-build-failed", { cause: error });
}

function requireContinuity(continuity) {
  if (typeof continuity?.capture !== "function" || typeof continuity?.compare !== "function") {
    throw new TypeError("continuity capture and compare adapters are required");
  }
  return continuity;
}

async function mergeInstancePrivatePolicy({
  sourceRoot,
  privatePolicy,
  instanceConfigPath
}) {
  if (instanceConfigPath === undefined) return privatePolicy;
  if (typeof instanceConfigPath !== "string" || !path.isAbsolute(instanceConfigPath)) {
    throw new TypeError("instance config path must be absolute");
  }
  const metadata = await lstat(instanceConfigPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
      (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600)) {
    throw new TypeError("instance config must be a regular 0600 file");
  }
  const [resolvedSource, resolvedConfig] = await Promise.all([
    realpath(sourceRoot),
    realpath(instanceConfigPath)
  ]);
  if (contained(resolvedSource, resolvedConfig)) {
    throw new TypeError("instance config must be outside the source tree");
  }
  const config = await loadInstanceConfig(resolvedConfig);
  return mergePrivateScanPolicyWithInstanceConfig(privatePolicy, config);
}

export async function buildPublicSnapshot({
  sourceRoot,
  outputRoot,
  policyPath,
  privatePolicyPath,
  instanceConfigPath,
  continuity,
  testHooks = {}
}) {
  requireContinuity(continuity);
  const runId = randomUUID();
  let stage = "initialization";
  let resolvedOutput = null;
  let attemptPath = null;
  let markerPath = null;
  let promotedCandidatePath = null;
  let promotedCandidateId = null;
  let continuityBaseline = null;
  let continuityBeforeEvidence = null;
  let continuityAfterEvidence = null;
  let publicPolicySha256 = null;
  let privatePolicySha256 = null;
  let manifestSha256 = null;
  const runContinuityAfter = async () => {
    let comparison;
    try {
      comparison = await continuity.compare(continuityBaseline);
    } catch (error) {
      fail("continuity-after", "continuity-after-check-failed", { cause: error });
    }
    continuityAfterEvidence = continuityReceiptEvidence(comparison);
    if (comparison?.healthy !== true) fail("continuity-after", "continuity-after-failed");
  };
  try {
    let policy;
    let privatePolicy;
    try {
      policy = validatePublicSnapshotPolicy(await readJson(policyPath, "public snapshot policy"));
    } catch (error) {
      fail("policy", "public-policy-invalid", { cause: error });
    }
    try {
      privatePolicy = await loadPrivateScanPolicy(privatePolicyPath);
    } catch (error) {
      fail("policy", "private-policy-invalid", { cause: error });
    }
    try {
      privatePolicy = await mergeInstancePrivatePolicy({
        sourceRoot,
        privatePolicy,
        instanceConfigPath
      });
    } catch (error) {
      fail("policy", "instance-config-invalid", { cause: error });
    }
    publicPolicySha256 = sha256(`${canonicalJson(policy)}\n`);
    privatePolicySha256 = sha256(`${canonicalJson(privatePolicy)}\n`);
    stage = "continuity-before";
    const before = await continuity.capture();
    if (before?.healthy !== true) fail(stage, "continuity-before-failed");
    continuityBaseline = before.baseline ?? before;
    continuityBeforeEvidence = continuityReceiptEvidence(continuityBaseline, { healthy: true });

    stage = "source-selection";
    const sourceSelection = await inspectSourceSelection(sourceRoot, policy);
    const sourceRecords = sourceSelection.records;
    const sourceScan = await scanPublicBuffers({
      files: sourceRecords.map((record) => ({
        path: record.path,
        content: sourceSelection.contents.get(record.path)
      })),
      policy: privatePolicy,
      stage
    });
    assertCleanScan(sourceScan);
    await testHooks.afterSourceScan?.({ sourceRecords });
    await assertSourceSelectionUnchanged(sourceRoot, policy, sourceSelection);

    resolvedOutput = await ensureOutputRoot(outputRoot, sourceRoot);
    attemptPath = path.join(resolvedOutput, `.attempt-${runId}`);
    markerPath = path.join(resolvedOutput, `.attempt-${runId}.owner.json`);
    await mkdir(attemptPath, { mode: 0o700 });
    await writeExclusive(markerPath, `${JSON.stringify({ schema_version: 1, run_id: runId })}\n`, 0o600);
    const treeRoot = path.join(attemptPath, "tree");
    await copySelection(treeRoot, sourceRecords, sourceSelection.contents);
    sourceSelection.contents.clear();
    await testHooks.afterStagingCopy?.({ treeRoot, sourceRecords });

    stage = "staging-tree";
    const stagingScan = await scanPublicFiles({
      root: treeRoot,
      files: sourceRecords,
      policy: privatePolicy,
      stage
    });
    assertCleanScan(stagingScan);
    assertMatchingRecords(sourceRecords, await enumerateTree(treeRoot), stage);

    stage = "archive-create";
    const archivePath = path.join(attemptPath, "source.tar");
    await writePublicTarArchive({ treeRoot, records: sourceRecords, archivePath });
    await testHooks.afterArchiveWritten?.({
      archivePath,
      sourceRecords,
      async replaceArchive({ treeRoot: replacementRoot, records }) {
        await unlink(archivePath);
        await writePublicTarArchive({
          treeRoot: replacementRoot,
          records,
          archivePath
        });
      }
    });
    const archiveRecord = await digestFile(archivePath);

    stage = "archive-unpacked";
    const unpackedRoot = path.join(attemptPath, ".verify-unpacked");
    const unpackedRecords = await extractPublicTarArchive({
      archivePath,
      targetRoot: unpackedRoot,
      limits: policy.limits
    });
    const archiveScan = await scanPublicFiles({
      root: unpackedRoot,
      files: unpackedRecords,
      policy: privatePolicy,
      stage
    });
    assertCleanScan(archiveScan);
    assertMatchingRecords(sourceRecords, unpackedRecords, stage);
    await rm(unpackedRoot, { recursive: true, force: false });

    const treeSha256 = sha256(`${canonicalJson(sourceRecords)}\n`);
    stage = "release-metadata";
    const release = await releaseMetadata(treeRoot, sourceRecords, policy.archive_prefix);
    await testHooks.beforeReleaseArtifacts?.({
      treeRoot,
      sourceRecords,
      version: release.version,
      treeSha256
    });

    stage = "plugin-create";
    const pluginPath = path.join(attemptPath, "codex-plugin.tar");
    await writePublicTarArchive({
      treeRoot,
      records: sourceRecords,
      archivePath: pluginPath,
      pathPrefix: release.name
    });
    await testHooks.afterPluginArtifactWritten?.({
      artifactPath: pluginPath,
      sourceRecords,
      async replacePluginArtifact({ treeRoot: replacementRoot, records }) {
        await unlink(pluginPath);
        await writePublicTarArchive({
          treeRoot: replacementRoot,
          records,
          archivePath: pluginPath,
          pathPrefix: release.name
        });
      }
    });
    const pluginRecord = await digestFile(pluginPath);

    stage = "plugin-unpacked";
    const pluginUnpackedRoot = path.join(attemptPath, ".verify-plugin-unpacked");
    const pluginRecords = await extractPublicTarArchive({
      archivePath: pluginPath,
      targetRoot: pluginUnpackedRoot,
      limits: policy.limits,
      stage
    });
    const pluginScan = await scanPublicFiles({
      root: pluginUnpackedRoot,
      files: pluginRecords,
      policy: privatePolicy,
      stage
    });
    assertCleanScan(pluginScan);
    assertPrefixedRecords(sourceRecords, pluginRecords, release.name, stage);
    await rm(pluginUnpackedRoot, { recursive: true, force: false });

    stage = "npm-create";
    const npmTarPath = path.join(attemptPath, ".npm-package.tar");
    const npmPath = path.join(attemptPath, "npm-package.tgz");
    await writePublicTarArchive({
      treeRoot,
      records: release.npmRecords,
      archivePath: npmTarPath,
      pathPrefix: "package"
    });
    await gzipTarArchive({ tarPath: npmTarPath, archivePath: npmPath, stage });
    await unlink(npmTarPath);
    await testHooks.afterNpmArtifactWritten?.({
      artifactPath: npmPath,
      sourceRecords: release.npmRecords,
      async replaceNpmArtifact({ treeRoot: replacementRoot, records }) {
        const replacementTar = path.join(
          attemptPath,
          `.npm-replacement-${randomUUID()}.tar`
        );
        try {
          await writePublicTarArchive({
            treeRoot: replacementRoot,
            records,
            archivePath: replacementTar,
            pathPrefix: "package"
          });
          await unlink(npmPath);
          await gzipTarArchive({
            tarPath: replacementTar,
            archivePath: npmPath,
            stage: "npm-create"
          });
        } finally {
          await rm(replacementTar, { force: true });
        }
      }
    });
    const npmRecord = await digestFile(npmPath);

    stage = "npm-unpacked";
    const npmVerifyTar = path.join(attemptPath, ".verify-npm-package.tar");
    const npmUnpackedRoot = path.join(attemptPath, ".verify-npm-unpacked");
    await gunzipTarArchive({
      archivePath: npmPath,
      tarPath: npmVerifyTar,
      limits: policy.limits,
      stage
    });
    const npmRecords = await extractPublicTarArchive({
      archivePath: npmVerifyTar,
      targetRoot: npmUnpackedRoot,
      limits: policy.limits,
      stage
    });
    const npmScan = await scanPublicFiles({
      root: npmUnpackedRoot,
      files: npmRecords,
      policy: privatePolicy,
      stage
    });
    assertCleanScan(npmScan);
    assertPrefixedRecords(release.npmRecords, npmRecords, "package", stage);
    await rm(npmUnpackedRoot, { recursive: true, force: false });
    await unlink(npmVerifyTar);

    stage = "sbom-create";
    const sbomPath = path.join(attemptPath, "sbom.spdx.json");
    const sbom = await createSpdxSbom({
      treeRoot,
      sourceRecords,
      release,
      treeSha256
    });
    await writeExclusive(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, 0o644);
    const sbomRecord = await digestFile(sbomPath);

    const subjectArtifactRecords = [
      { path: "source.tar", record: archiveRecord },
      { path: "codex-plugin.tar", record: pluginRecord },
      { path: "npm-package.tgz", record: npmRecord },
      { path: "sbom.spdx.json", record: sbomRecord }
    ];

    stage = "provenance-create";
    const provenancePath = path.join(attemptPath, "provenance.intoto.jsonl");
    const provenance = createLocalProvenance({
      release,
      treeSha256,
      publicPolicySha256,
      artifactRecords: subjectArtifactRecords
    });
    await writeExclusive(provenancePath, `${canonicalJson(provenance)}\n`, 0o644);
    const provenanceRecord = await digestFile(provenancePath);

    const artifactRecords = [
      ...subjectArtifactRecords,
      { path: "provenance.intoto.jsonl", record: provenanceRecord }
    ];
    const metadataSummary = {
      scanner_version: 1,
      stage: "candidate-metadata",
      file_count: 4,
      finding_count: 0
    };
    const sourceArtifact = {
      format: "ustar",
      path: "source.tar",
      root: ".",
      version: release.version,
      source_tree_sha256: treeSha256,
      file_count: sourceRecords.length,
      ...archiveRecord
    };
    const pluginArtifact = {
      format: "ustar",
      path: "codex-plugin.tar",
      root: release.name,
      version: release.version,
      source_tree_sha256: treeSha256,
      file_count: sourceRecords.length,
      ...pluginRecord
    };
    const npmArtifact = {
      format: "npm-tgz",
      path: "npm-package.tgz",
      root: "package",
      version: release.version,
      source_tree_sha256: treeSha256,
      file_count: release.npmRecords.length,
      ...npmRecord
    };
    const sbomArtifact = {
      format: "spdx-json-2.3",
      path: "sbom.spdx.json",
      root: ".",
      version: release.version,
      source_tree_sha256: treeSha256,
      file_count: sourceRecords.length,
      ...sbomRecord
    };
    const provenanceArtifact = {
      format: "in-toto-jsonl-slsa-v1",
      path: "provenance.intoto.jsonl",
      root: ".",
      version: release.version,
      source_tree_sha256: treeSha256,
      file_count: 1,
      signature_status: "unsigned-local-record",
      ...provenanceRecord
    };
    const manifest = {
      schema_version: 1,
      version: release.version,
      archive_prefix: policy.archive_prefix,
      policy_sha256: publicPolicySha256,
      tree_sha256: treeSha256,
      files: sourceRecords,
      provenance: policy.provenance,
      summary: {
        file_count: sourceRecords.length,
        total_bytes: sourceRecords.reduce((total, record) => total + record.bytes, 0),
        synthetic_file_count: sourceRecords.filter((record) => record.synthetic).length
      },
      archive: sourceArtifact,
      artifacts: {
        source: sourceArtifact,
        codex_plugin: pluginArtifact,
        npm: npmArtifact,
        sbom: sbomArtifact,
        provenance: provenanceArtifact
      },
      scans: [
        scanSummary(sourceScan),
        scanSummary(stagingScan),
        scanSummary(archiveScan),
        scanSummary(pluginScan),
        scanSummary(npmScan),
        metadataSummary
      ]
    };
    const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    manifestSha256 = sha256(manifestContent);
    const manifestPath = path.join(attemptPath, "snapshot-manifest.json");
    await writeExclusive(
      manifestPath,
      manifestContent,
      0o644
    );
    const checksumLines = [
      ...sourceRecords.map((record) => `${record.sha256}  tree/${record.path}`),
      `${archiveRecord.sha256}  source.tar`,
      `${pluginRecord.sha256}  codex-plugin.tar`,
      `${npmRecord.sha256}  npm-package.tgz`,
      `${sbomRecord.sha256}  sbom.spdx.json`,
      `${provenanceRecord.sha256}  provenance.intoto.jsonl`,
      `${manifestSha256}  snapshot-manifest.json`
    ];
    const checksumContent = Buffer.from(`${checksumLines.join("\n")}\n`, "utf8");
    const checksumPath = path.join(attemptPath, "SHA256SUMS");
    await writeExclusive(
      checksumPath,
      checksumContent,
      0o644
    );
    await testHooks.afterMetadataWritten?.({ manifestPath, checksumPath });
    stage = "candidate-metadata";
    await assertCandidateLayout(attemptPath);
    const metadataScan = await scanPublicFiles({
      root: attemptPath,
      files: [
        "SHA256SUMS",
        "provenance.intoto.jsonl",
        "sbom.spdx.json",
        "snapshot-manifest.json"
      ],
      policy: privatePolicy,
      stage
    });
    assertCleanScan(metadataScan);
    await assertCandidateReadback({
      attemptPath,
      manifestContent,
      checksumContent,
      artifacts: artifactRecords,
      treeRoot,
      sourceRecords
    });

    stage = "continuity-after";
    await runContinuityAfter();
    await assertSourceSelectionUnchanged(sourceRoot, policy, sourceSelection);
    stage = "candidate-metadata";
    await assertCandidateReadback({
      attemptPath,
      manifestContent,
      checksumContent,
      artifacts: artifactRecords,
      treeRoot,
      sourceRecords
    });

    const candidateId = `sha256-${treeSha256}`;
    const candidatesRoot = await ensureOutputSubdirectory(
      resolvedOutput,
      "candidates",
      "promotion"
    );
    const candidatePath = path.join(candidatesRoot, candidateId);
    try {
      await lstat(candidatePath);
      fail("promotion", "candidate-already-exists");
    } catch (error) {
      if (error instanceof PublicSnapshotError) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
    stage = "promotion";
    const receiptsRoot = await ensureOutputSubdirectory(
      resolvedOutput,
      "receipts",
      "promotion"
    );

    stage = "promotion";
    await syncDirectoryTree(attemptPath);
    await syncDirectory(resolvedOutput);
    stage = "continuity-after";
    await runContinuityAfter();
    await assertSourceSelectionUnchanged(sourceRoot, policy, sourceSelection);
    stage = "candidate-metadata";
    await assertCandidateReadback({
      attemptPath,
      manifestContent,
      checksumContent,
      artifacts: artifactRecords,
      treeRoot,
      sourceRecords
    });

    stage = "promotion";
    const receiptFields = {
      runId,
      candidateId,
      treeSha256,
      publicPolicySha256,
      privatePolicySha256,
      manifestSha256,
      continuityBeforeEvidence,
      continuityAfterEvidence
    };
    await rewriteExisting(markerPath, candidateReceiptContent(receiptFields), 0o600);
    const receiptPath = path.join(receiptsRoot, `${runId}.json`);
    await rename(markerPath, receiptPath);
    markerPath = receiptPath;
    await syncDirectory(receiptsRoot);
    await syncDirectory(resolvedOutput);
    await testHooks.beforeCandidatePromoted?.({ candidatePath, candidateId });

    await rename(attemptPath, candidatePath);
    attemptPath = null;
    promotedCandidatePath = candidatePath;
    promotedCandidateId = candidateId;
    await syncDirectory(candidatesRoot);
    await syncDirectory(resolvedOutput);
    markerPath = null;
    promotedCandidatePath = null;
    promotedCandidateId = null;
    return {
      status: "candidate",
      candidate_id: candidateId,
      file_count: sourceRecords.length,
      version: release.version,
      tree_sha256: treeSha256,
      archive_sha256: archiveRecord.sha256,
      plugin_sha256: pluginRecord.sha256,
      npm_sha256: npmRecord.sha256,
      sbom_sha256: sbomRecord.sha256,
      provenance_sha256: provenanceRecord.sha256
    };
  } catch (caught) {
    let error = normalizeError(caught, stage);
    const hasOwnedCleanupTarget = Boolean(
      resolvedOutput && markerPath && (attemptPath || promotedCandidatePath)
    );
    let cleanupStatus = hasOwnedCleanupTarget ? "failed" : "not-required";
    if (promotedCandidatePath && promotedCandidateId && markerPath && resolvedOutput) {
      const cleanupOptions = {
        outputRoot: resolvedOutput,
        candidatePath: promotedCandidatePath,
        markerPath,
        runId,
        candidateId: promotedCandidateId
      };
      try {
        await removeOwnedPromotedCandidate(cleanupOptions);
        cleanupStatus = "removed";
      } catch {
        try {
          await quarantinePromotedCandidate(cleanupOptions);
          cleanupStatus = "quarantined";
        } catch {
          error = new PublicSnapshotError(error.stage, error.code, {
            cause: error,
            findingCodes: error.finding_codes,
            secondaryCodes: [...new Set([
              ...(error.secondary_codes ?? []),
              "cleanup-failed"
            ])]
          });
        }
      }
    } else if (attemptPath && markerPath && resolvedOutput) {
      try {
        await removeOwnedAttempt({
          outputRoot: resolvedOutput,
          attemptPath,
          markerPath,
          runId
        });
        cleanupStatus = "removed";
      } catch {
        try {
          await quarantineAttempt({
            outputRoot: resolvedOutput,
            attemptPath,
            markerPath,
            runId
          });
          cleanupStatus = "quarantined";
        } catch {
          error = new PublicSnapshotError(error.stage, error.code, {
            cause: error,
            findingCodes: error.finding_codes,
            secondaryCodes: [...new Set([
              ...(error.secondary_codes ?? []),
              "cleanup-failed"
            ])]
          });
        }
      }
    }
    if (continuityBaseline) {
      try {
        await runContinuityAfter();
      } catch (continuityError) {
        const normalizedContinuityError = normalizeError(continuityError, "continuity-after");
        const secondaryCodes = [...new Set([
          ...(error.secondary_codes ?? []),
          ...(normalizedContinuityError.code === error.code
            ? []
            : [normalizedContinuityError.code])
        ])];
        error = new PublicSnapshotError(error.stage, error.code, {
          cause: error,
          findingCodes: error.finding_codes,
          secondaryCodes
        });
      }
    }
    if (resolvedOutput) {
      try {
        await writeFailureReceipt(resolvedOutput, runId, error, cleanupStatus, {
          publicPolicySha256,
          privatePolicySha256,
          manifestSha256,
          continuityBeforeEvidence,
          continuityAfterEvidence
        });
      } catch {
        // Failure reporting must not replace the original failure code.
      }
    }
    throw error;
  }
}
