#!/usr/bin/env node

import { open, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  cleanupTemporaryAuthArtifacts,
  compareContinuityBaseline,
  createContinuityBaseline,
  hardenPrivateStatePermissions
} from "../ops/continuity-gate.mjs";
import { runIsolatedContinuityExercise } from "../ops/continuity-exercise.mjs";
import {
  runLocalContinuityCheck,
  validateContinuityManifest
} from "../ops/local-continuity.mjs";

async function readJson(filename, description) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    throw new Error(`${description} could not be read`, { cause: error });
  }
}

async function writePrivateJson(filename, value) {
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function check(manifestPath) {
  const manifest = await readJson(manifestPath, "continuity manifest");
  return runLocalContinuityCheck(manifest, { projectRoot: process.cwd() });
}

async function main() {
  const [
    command,
    manifestPath = ".runtime/continuity.json",
    referencePathArgument,
    allowedRestartsArgument
  ] = process.argv.slice(2);
  if (command === "exercise") {
    const result = await runIsolatedContinuityExercise();
    print(result);
    return result.healthy ? 0 : 1;
  }
  if (command === "check") {
    const report = await check(manifestPath);
    print(report);
    return report.healthy ? 0 : 1;
  }
  if (command === "capture") {
    const report = await check(manifestPath);
    if (!report.healthy) {
      print(report);
      return 1;
    }
    const output = referencePathArgument ??
      path.join(path.dirname(manifestPath), "continuity-baseline.json");
    const baseline = createContinuityBaseline(report);
    await writePrivateJson(output, baseline);
    print({ healthy: true, captured_at: baseline.captured_at, baseline_written: true });
    return 0;
  }
  if (command === "compare") {
    const baselinePath = referencePathArgument ??
      path.join(path.dirname(manifestPath), "continuity-baseline.json");
    const [report, baseline] = await Promise.all([
      check(manifestPath),
      readJson(baselinePath, "continuity baseline")
    ]);
    const comparison = compareContinuityBaseline(baseline, report, {
      allowedRealtimeRunDelta:
        allowedRestartsArgument === undefined ? 0 : Number(allowedRestartsArgument)
    });
    print(comparison);
    return comparison.healthy ? 0 : 1;
  }
  if (command === "cleanup-auth") {
    const manifest = await readJson(manifestPath, "continuity manifest");
    validateContinuityManifest(manifest, { projectRoot: process.cwd() });
    if (manifest.authorization_complete !== true) {
      throw new Error("authorization_complete must be true before temporary auth cleanup");
    }
    const privateRoots = (manifest.private_roots ?? [])
      .filter((root) => root.role === "runtime")
      .map((root) => root.path);
    const result = await cleanupTemporaryAuthArtifacts({
      projectRoot: process.cwd(),
      privateRoots
    });
    print({ healthy: true, ...result });
    return 0;
  }
  if (command === "harden") {
    const manifest = await readJson(manifestPath, "continuity manifest");
    validateContinuityManifest(manifest, { projectRoot: process.cwd() });
    const result = await hardenPrivateStatePermissions(manifest, {
      projectRoot: process.cwd()
    });
    print({ healthy: true, ...result });
    return 0;
  }
  process.stderr.write(
    "usage: twin-continuity <check|capture|harden|cleanup-auth> [MANIFEST] [BASELINE] | compare [MANIFEST] [BASELINE] [ALLOWED_REALTIME_RESTARTS] | exercise\n"
  );
  return 64;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${JSON.stringify({
    type: "error",
    component: "continuity",
    message: error instanceof Error ? error.message : String(error)
  })}\n`);
  process.exitCode = 1;
});
