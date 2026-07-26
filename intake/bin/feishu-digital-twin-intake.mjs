#!/usr/bin/env node

import process from "node:process";

import { loadInstanceConfig } from "../../runtime/src/config-loader.mjs";
import {
  reportIntakeFailure,
  runIntakeCommand
} from "../src/intake-command.mjs";

runIntakeCommand(process.argv.slice(2), {
  configLoader: loadInstanceConfig
}).then((code) => {
  if (Number.isInteger(code)) process.exitCode = code;
}).catch(() => {
  process.exitCode = reportIntakeFailure();
});
