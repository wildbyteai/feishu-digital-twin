#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  compareContinuityBaseline,
  createContinuityBaseline
} from "../ops/continuity-gate.mjs";
import { runLocalContinuityCheck } from "../ops/local-continuity.mjs";
import {
  buildPublicSnapshot,
  PublicSnapshotError,
  validatePublicSnapshotPolicy,
  verifyPublicCandidate
} from "../ops/public-snapshot.mjs";

const BUILD_USAGE =
  "twin-public-snapshot build POLICY PRIVATE_POLICY OUTPUT_ROOT CONTINUITY_MANIFEST " +
  "[--instance-config ABSOLUTE_PATH]";
const POLICY_CHECK_USAGE = "twin-public-snapshot policy-check POLICY";
const VERIFY_USAGE = "twin-public-snapshot verify CANDIDATE";

function normalizedProjectRelativePath(value, field) {
  if (typeof value !== "string" || !value ||
      path.isAbsolute(value) || path.win32.isAbsolute(value) ||
      value.includes("\\") || value === "." || value === ".." ||
      value.startsWith("../") || path.posix.normalize(value) !== value) {
    throw new TypeError(`${field} must be a normalized project-relative path`);
  }
  return value;
}

function normalizedAbsolutePath(value, field) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value) ||
      path.normalize(value) !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${field} must be a normalized absolute path`);
  }
  return value;
}

function resolvedLocalPath(cwd, value, field) {
  return path.isAbsolute(value)
    ? normalizedAbsolutePath(value, field)
    : path.resolve(cwd, normalizedProjectRelativePath(value, field));
}

async function readJson(filename, description = "JSON file") {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    throw new TypeError(`${description} could not be read`, { cause: error });
  }
}

function print(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

export async function runPublicSnapshotCli(args, {
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  if (args[0] === "policy-check") {
    if (args.length !== 2) {
      print(stderr, { type: "usage", command: POLICY_CHECK_USAGE });
      return 64;
    }
    let policyPath;
    try {
      policyPath = path.resolve(cwd, normalizedProjectRelativePath(args[1], "POLICY"));
    } catch {
      print(stderr, { type: "usage", command: POLICY_CHECK_USAGE });
      return 64;
    }
    try {
      const policy = validatePublicSnapshotPolicy(
        await readJson(policyPath, "public snapshot policy")
      );
      print(stdout, {
        type: "public_snapshot_policy",
        status: "valid",
        archive_prefix: policy.archive_prefix,
        file_count: policy.files.length,
        provenance_count: Object.keys(policy.provenance).length
      });
      return 0;
    } catch {
      print(stderr, {
        type: "snapshot_failed",
        stage: "policy",
        code: "public-policy-invalid",
        finding_codes: [],
        secondary_codes: []
      });
      return 1;
    }
  }
  if (args[0] === "verify") {
    if (args.length !== 2) {
      print(stderr, { type: "usage", command: VERIFY_USAGE });
      return 64;
    }
    let candidatePath;
    try {
      candidatePath = resolvedLocalPath(cwd, args[1], "CANDIDATE");
    } catch {
      print(stderr, { type: "usage", command: VERIFY_USAGE });
      return 64;
    }
    try {
      const result = await verifyPublicCandidate({ candidatePath });
      print(stdout, { type: "public_snapshot_candidate", ...result });
      return 0;
    } catch (error) {
      if (error instanceof PublicSnapshotError) {
        print(stderr, {
          type: "snapshot_failed",
          stage: error.stage,
          code: error.code,
          finding_codes: error.finding_codes,
          secondary_codes: error.secondary_codes
        });
      } else {
        print(stderr, {
          type: "error",
          component: "public-snapshot",
          code: "unexpected-failure"
        });
      }
      return 1;
    }
  }
  const hasInstanceConfig = args.length === 7 && args[5] === "--instance-config";
  if ((args.length !== 5 && !hasInstanceConfig) || args[0] !== "build") {
    print(stderr, {
      type: "usage",
      command: BUILD_USAGE
    });
    return 64;
  }
  let policyPath;
  let privatePolicyPath;
  let outputRoot;
  let continuityManifestPath;
  let instanceConfigPath;
  try {
    policyPath = path.resolve(cwd, normalizedProjectRelativePath(args[1], "POLICY"));
    privatePolicyPath = path.resolve(cwd, normalizedProjectRelativePath(args[2], "PRIVATE_POLICY"));
    outputRoot = resolvedLocalPath(cwd, args[3], "OUTPUT_ROOT");
    continuityManifestPath = path.resolve(
      cwd,
      normalizedProjectRelativePath(args[4], "CONTINUITY_MANIFEST")
    );
    instanceConfigPath = hasInstanceConfig
      ? normalizedAbsolutePath(args[6], "INSTANCE_CONFIG")
      : undefined;
  } catch {
    print(stderr, {
      type: "usage",
      command: BUILD_USAGE
    });
    return 64;
  }
  try {
    const continuityManifest = await readJson(continuityManifestPath, "continuity manifest");
    const continuity = {
      async capture() {
        const report = await runLocalContinuityCheck(continuityManifest, {
          projectRoot: cwd,
          requireGitIsolation: true
        });
        return report.healthy
          ? { healthy: true, baseline: createContinuityBaseline(report) }
          : { healthy: false };
      },
      async compare(baseline) {
        const report = await runLocalContinuityCheck(continuityManifest, {
          projectRoot: cwd,
          requireGitIsolation: true
        });
        return compareContinuityBaseline(baseline, report);
      }
    };
    const result = await buildPublicSnapshot({
      sourceRoot: cwd,
      outputRoot,
      policyPath,
      privatePolicyPath,
      instanceConfigPath,
      continuity
    });
    print(stdout, result);
    return 0;
  } catch (error) {
    if (error instanceof PublicSnapshotError) {
      print(stderr, {
        type: "snapshot_failed",
        stage: error.stage,
        code: error.code,
        finding_codes: error.finding_codes,
        secondary_codes: error.secondary_codes
      });
    } else {
      print(stderr, {
        type: "error",
        component: "public-snapshot",
        code: "unexpected-failure"
      });
    }
    return 1;
  }
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  runPublicSnapshotCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
