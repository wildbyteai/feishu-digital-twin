#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createIsolatedTestEnvironment } from "../ops/isolated-test-environment.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_FILE_CONCURRENCY = 4;

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function testFiles() {
  const directory = path.join(projectRoot, "tests/runtime");
  return (await readdir(directory))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => path.join("tests/runtime", name));
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "twin-tests-"));
  try {
    const environment = await createIsolatedTestEnvironment({
      root,
      nodePath: process.execPath
    });
    const selected = process.argv.slice(2);
    const files = selected.length > 0 ? selected : await testFiles();
    const child = spawn(process.execPath, [
      "--test",
      `--test-concurrency=${TEST_FILE_CONCURRENCY}`,
      ...files
    ], {
      cwd: projectRoot,
      env: environment,
      stdio: "inherit"
    });
    const exit = await waitForExit(child);
    if (exit.signal) return 1;
    return exit.code ?? 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${JSON.stringify({
    type: "error",
    component: "isolated-tests",
    message: error instanceof Error ? error.message : String(error)
  })}\n`);
  process.exitCode = 1;
});
