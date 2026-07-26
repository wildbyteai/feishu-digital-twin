#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runProductCli } from "../product/src/cli.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

runProductCli({
  argv: process.argv.slice(2),
  packageRoot
}).then((code) => {
  process.exitCode = code;
});
