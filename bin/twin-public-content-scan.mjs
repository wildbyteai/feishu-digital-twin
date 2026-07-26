#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { scanPublicFiles } from "../ops/public-content-scan.mjs";
import { validatePublicSnapshotPolicy } from "../ops/public-snapshot.mjs";

const COMPLETE_TRACKED_SET_FLAG = "--require-complete-tracked-set";
const USAGE =
  `twin-public-content-scan PUBLIC_SNAPSHOT_POLICY [${COMPLETE_TRACKED_SET_FLAG}]`;
const BASELINE_SCAN_POLICY = Object.freeze({
  schema_version: 1,
  forbidden_literals: [["PUBLIC", "RELEASE", "PRIVATE", "CANARY"].join("_")],
  private_domains: []
});

function print(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function normalizedProjectRelativePath(value) {
  return typeof value === "string" && value.length > 0 &&
    !path.isAbsolute(value) && !path.win32.isAbsolute(value) &&
    !value.includes("\\") && value !== "." && value !== ".." &&
    !value.startsWith("../") && path.posix.normalize(value) === value;
}

function trackedSetFindings(cwd, manifest) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_")) delete environment[key];
  }
  const result = spawnSync("git", ["--no-optional-locks", "ls-files", "-z"], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 5 * 1024 * 1024,
    env: {
      ...environment,
      LC_ALL: "C",
      LANG: "C",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_LITERAL_PATHSPECS: "1"
    }
  });
  if (result.error || result.status !== 0) {
    return [{ code: "tracked-set-read-failed", path: "<repository>" }];
  }
  const tracked = result.stdout.split("\0").filter(Boolean).sort((left, right) => (
    left.localeCompare(right, "en")
  ));
  const approved = manifest.files.map((entry) => entry.path);
  const trackedSet = new Set(tracked);
  const approvedSet = new Set(approved);
  return [
    ...tracked
      .filter((relativePath) => !approvedSet.has(relativePath))
      .map((relativePath) => ({
        code: "tracked-file-not-in-public-manifest",
        path: relativePath
      })),
    ...approved
      .filter((relativePath) => !trackedSet.has(relativePath))
      .map((relativePath) => ({
        code: "public-manifest-file-not-tracked",
        path: relativePath
      }))
  ].sort((left, right) => (
    left.path.localeCompare(right.path, "en") || left.code.localeCompare(right.code, "en")
  ));
}

export async function runPublicContentScanCli(args, {
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  const requireCompleteTrackedSet = args[1] === COMPLETE_TRACKED_SET_FLAG;
  if (
    (args.length !== 1 && !(args.length === 2 && requireCompleteTrackedSet)) ||
    !normalizedProjectRelativePath(args[0])
  ) {
    print(stderr, { type: "usage", command: USAGE });
    return 64;
  }

  let manifest;
  try {
    manifest = validatePublicSnapshotPolicy(
      JSON.parse(await readFile(path.resolve(cwd, args[0]), "utf8"))
    );
  } catch {
    print(stderr, {
      type: "public_content_scan",
      status: "failed",
      code: "public-policy-invalid",
      finding_count: 0,
      findings: []
    });
    return 1;
  }

  const report = await scanPublicFiles({
    root: cwd,
    files: manifest.files,
    policy: BASELINE_SCAN_POLICY,
    stage: "public-manifest"
  });
  const findings = [
    ...report.findings,
    ...(requireCompleteTrackedSet ? trackedSetFindings(cwd, manifest) : [])
  ];
  const output = {
    type: "public_content_scan",
    status: findings.length === 0 ? "clean" : "blocked",
    scanner_version: report.scanner_version,
    file_count: report.file_count,
    bytes_scanned: report.bytes_scanned,
    finding_count: findings.length,
    findings
  };
  print(findings.length === 0 ? stdout : stderr, output);
  return findings.length === 0 ? 0 : 1;
}

const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const exitCode = await runPublicContentScanCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
