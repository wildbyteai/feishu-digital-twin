import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runServiceRole } from "../../product/src/service-host.mjs";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const cliPath = path.join(projectRoot, "bin/feishu-digital-twin.mjs");
const fakeCodexFixture = path.join(projectRoot, "tests/fixtures/bin/codex");
const CURRENT_VERSION = "0.1.4";
let syntheticInstanceSequence = 0;

function runCli(executable, args, { env = {}, expected = 0 } = {}) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 20_000
  });
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return result;
}

function run(args, options = {}) {
  return runCli(cliPath, args, options);
}

function json(result) {
  return JSON.parse(result.stdout.trim());
}

function snapshotDirectory(directory) {
  return Object.fromEntries(readdirSync(directory).sort().map((name) => {
    const filename = path.join(directory, name);
    const metadata = statSync(filename);
    return [name, {
      mode: metadata.mode & 0o777,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
      sha256: metadata.isFile()
        ? createHash("sha256").update(readFileSync(filename)).digest("hex")
        : null
    }];
  }));
}

function initRoot(instance = `fixture-${process.pid}-${++syntheticInstanceSequence}`) {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-product-")), "install");
  const result = run(["--root", root, "init", "--instance", instance]);
  return { root, result: json(result) };
}

function fakeLarkCli(directory, {
  baseFailAfter = null,
  baseGroupData = [],
  baseGroupFields = ["启用", "群ID", "个性化规则"],
  baseRuntimeData = [[true, "继承", ""]],
  baseRuntimeFields = ["数字分身启用", "允许域", "个性化规则"],
  botStatus = "available",
  driveListExitCode = 0,
  exitCode = 0,
  includeOk = true,
  malformed = false,
  profiles = ["fixture-profile"],
  tokenStatus = "valid",
  userStatus = "available",
  verified = true,
  wikiSpaces = [{
    space_id: "fixture_private_space_id",
    name: "fixture_private_knowledge_name"
  }]
} = {}) {
  const filename = path.join(directory, "lark-cli");
  const log = path.join(directory, "lark-cli.log");
  const baseCounter = path.join(directory, "lark-base-counter");
  const response = malformed ? "not-json" : JSON.stringify({
    ...(includeOk ? { ok: exitCode === 0 } : {}),
    verified,
    identities: {
      user: {
        available: userStatus === "available",
        openId: "ou_fixture_discovered_principal",
        status: userStatus,
        tokenStatus,
        userName: "示例发现用户",
        verified
      },
      bot: { available: botStatus === "available", status: botStatus, verified }
    }
  });
  writeFileSync(filename, [
    "#!/bin/sh",
    `printf '%s\\n' \"$*\" >> '${log}'`,
    "if [ \"$1\" = \"profile\" ] && [ \"$2\" = \"list\" ]; then",
    `  printf '%s\\n' '${JSON.stringify(profiles)}'`,
    "  exit 0",
    "fi",
    "if [ \"$3\" = \"base\" ] && [ \"$4\" = \"+record-list\" ]; then",
    `  base_count=$(grep -c 'base +record-list' '${log}')`,
    `  printf '%s\\n' "$base_count" > '${baseCounter}'`,
    ...(baseFailAfter === null ? [] : [
      `  if [ "$base_count" -gt ${baseFailAfter} ]; then exit 1; fi`
    ]),
    "  table_id=''",
    "  previous=''",
    "  for argument in \"$@\"; do",
    "    if [ \"$previous\" = \"--table-id\" ]; then table_id=$argument; break; fi",
    "    previous=$argument",
    "  done",
    "  case \"$table_id\" in",
    `    *group*|*群*) printf '%s\\n' '${JSON.stringify({
      ok: true,
      data: { fields: baseGroupFields, data: baseGroupData }
    })}' ;;`,
    `    *) printf '%s\\n' '${JSON.stringify({
      ok: true,
      data: { fields: baseRuntimeFields, data: baseRuntimeData }
    })}' ;;`,
    "  esac",
    "  exit 0",
    "fi",
    "if [ \"$3\" = \"wiki\" ] && [ \"$4\" = \"+space-list\" ]; then",
    `  printf '%s\\n' '${JSON.stringify({ ok: true, data: { items: wikiSpaces } })}'`,
    "  exit 0",
    "fi",
    "if [ \"$3\" = \"drive\" ] && [ \"$4\" = \"files\" ] && [ \"$5\" = \"list\" ]; then",
    ...(driveListExitCode === 0 ? [
      `  printf '%s\\n' '${JSON.stringify({ ok: true, data: { files: [], has_more: false } })}'`,
      "  exit 0"
    ] : [
      `  printf '%s\\n' '${JSON.stringify({
        ok: false,
        error: { type: "api", message: "invalid folder token" }
      })}' >&2`,
      `  exit ${driveListExitCode}`
    ]),
    "fi",
    `printf '%s\\n' '${response}'`,
    `exit ${exitCode}`,
    ""
  ].join("\n"), { mode: 0o700 });
  chmodSync(filename, 0o700);
  return { baseCounter, filename, log };
}

function fakeLaunchctl(directory) {
  const filename = path.join(directory, "launchctl");
  const log = path.join(directory, "launchctl.log");
  writeFileSync(filename, [
    "#!/bin/sh",
    `printf '%s\\n' \"$*\" >> '${log}'`,
    "if [ \"$1\" = \"print\" ]; then exit 113; fi",
    "exit 0",
    ""
  ].join("\n"), { mode: 0o700 });
  chmodSync(filename, 0o700);
  return { filename, log };
}

function fakeLoadedLaunchctl(directory) {
  const filename = path.join(directory, "launchctl");
  writeFileSync(filename, [
    "#!/bin/sh",
    "if [ \"$1\" = \"print\" ]; then",
    "  printf '%s\\n' 'state = running' 'pid = 123' 'last exit code = 0'",
    "fi",
    "exit 0",
    ""
  ].join("\n"), { mode: 0o700 });
  chmodSync(filename, 0o700);
  return filename;
}

function fakeStatefulLaunchctl(directory, {
  initiallyLoaded = [],
  failFirstStart = null,
  delayedBootout = [],
  disappearAfterRecoveryStart = null
} = {}) {
  const filename = path.join(directory, "launchctl");
  const log = path.join(directory, "launchctl.log");
  const stateDirectory = path.join(directory, "state");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  for (const label of initiallyLoaded) {
    writeFileSync(path.join(stateDirectory, label), "healthy\n", { mode: 0o600 });
  }
  writeFileSync(filename, [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const log = " + JSON.stringify(log) + ";",
    "const stateDirectory = " + JSON.stringify(stateDirectory) + ";",
    "const failFirstStart = " + JSON.stringify(failFirstStart) + ";",
    "const disappearAfterRecoveryStart = " + JSON.stringify(disappearAfterRecoveryStart) + ";",
    "const delayedBootout = new Set(" + JSON.stringify(delayedBootout) + ");",
    'const [command, first = "", second = ""] = process.argv.slice(2);',
    'fs.appendFileSync(log, process.argv.slice(2).join(" ") + "\\n");',
    'const target = command === "bootstrap" ? second : first;',
    'const label = path.basename(target, command === "bootstrap" ? ".plist" : undefined);',
    "const state = path.join(stateDirectory, label);",
    'if (command === "print") {',
    "  if (!fs.existsSync(state)) process.exit(113);",
    '  const value = fs.readFileSync(state, "utf8").trim();',
    '  if (value === "pending-removal") {',
    '    process.stdout.write("state = running\\npid = 123\\nlast exit code = 0\\n");',
    "    fs.rmSync(state, { force: true });",
    '  } else if (value === "vanish-after-probe") {',
    '    process.stdout.write("state = running\\npid = 123\\nlast exit code = 0\\n");',
    "    fs.rmSync(state, { force: true });",
    '  } else if (value === "failed") {',
    '    process.stdout.write("state = exited\\nlast exit code = 0\\n");',
    "  } else {",
    '    process.stdout.write("state = running\\npid = 123\\nlast exit code = 0\\n");',
    "  }",
    '} else if (command === "bootout") {',
    '  if (delayedBootout.has(label)) {',
    '    fs.writeFileSync(state, "pending-removal\\n");',
    "  } else {",
    "    fs.rmSync(state, { force: true });",
    "  }",
    '} else if (command === "bootstrap") {',
    '  const started = state + ".started";',
    '  const starts = fs.existsSync(started)',
    '    ? fs.readFileSync(started, "utf8").trim().split("\\n").filter(Boolean).length',
    '    : 0;',
    '  const value = label === failFirstStart && starts === 0',
    '    ? "failed"',
    '    : label === disappearAfterRecoveryStart && starts === 1',
    '      ? "vanish-after-probe"',
    '      : "healthy";',
    '  fs.writeFileSync(state, value + "\\n");',
    '  fs.appendFileSync(started, "started\\n");',
    "}",
    ""
  ].join("\n"), { mode: 0o700 });
  chmodSync(filename, 0o700);
  return { filename, log };
}

function installLarkSkill(codexEnvironmentRoot) {
  const skillDirectory = path.join(
    codexEnvironmentRoot,
    "home/.agents/skills/lark-shared"
  );
  mkdirSync(skillDirectory, { recursive: true, mode: 0o700 });
  for (const directory of [
    codexEnvironmentRoot,
    path.join(codexEnvironmentRoot, "home"),
    path.join(codexEnvironmentRoot, "home/.agents"),
    path.join(codexEnvironmentRoot, "home/.agents/skills"),
    skillDirectory
  ]) chmodSync(directory, 0o700);
  writeFileSync(path.join(skillDirectory, "SKILL.md"), [
    "---",
    "name: lark-shared",
    "description: synthetic fixture",
    "---",
    ""
  ].join("\n"), { mode: 0o600 });
}

function codexFixture({ lark: larkOptions = {} } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-product-tools-"));
  chmodSync(directory, 0o700);
  const larkFixture = fakeLarkCli(directory, larkOptions);
  const codexBin = path.join(directory, "codex");
  cpSync(fakeCodexFixture, codexBin);
  chmodSync(codexBin, 0o700);
  const codexEnvironmentRoot = path.join(directory, "codex-runtime");
  mkdirSync(path.join(codexEnvironmentRoot, "codex-home"), { recursive: true, mode: 0o700 });
  chmodSync(codexEnvironmentRoot, 0o700);
  chmodSync(path.join(codexEnvironmentRoot, "codex-home"), 0o700);
  writeFileSync(path.join(codexEnvironmentRoot, "codex-home/config.toml"), [
    'model = "fixture-model"',
    'model_provider = "fixture-provider"',
    ""
  ].join("\n"), { mode: 0o600 });
  installLarkSkill(codexEnvironmentRoot);
  return {
    directory,
    larkBaseCounter: larkFixture.baseCounter,
    larkCli: larkFixture.filename,
    larkLog: larkFixture.log,
    codexBin,
    codexEnvironmentRoot
  };
}

function writeCandidate(root, tools, overrides = {}) {
  const candidate = path.join(path.dirname(root), `candidate-${Date.now()}-${Math.random()}.json`);
  const config = {
    schema_version: 2,
    profile: "fixture-profile",
    lark_cli_bin: tools.larkCli,
    message_scope: "all_visible",
    codex_bin: "/opt/feishu-digital-twin/bin/codex",
    codex_environment_root: "/opt/feishu-digital-twin/codex-environment",
    production_data_approved: false,
    control: { mode: "local", enabled: false },
    principal: {
      name: "示例负责人",
      open_id: "principal_fixture",
      timezone: "America/Los_Angeles",
      address_names: ["示例负责人"]
    },
    schedule: {
      workdays: [1, 2, 3, 4, 5],
      workday_start_hour: 8,
      workday_end_hour: 17,
      work_interval_seconds: 45,
      quiet_interval_seconds: 420,
      daily_memory_hour: 1,
      daily_memory_minute: 25
    },
    allowed_lark_domains: ["im", "task"],
    ...overrides
  };
  writeFileSync(candidate, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(candidate, 0o600);
  return candidate;
}

function configureRoot(root, tools, {
  approved = true,
  approveMessageScope = true,
  expected = 0,
  overrides = {}
} = {}) {
  const candidate = writeCandidate(root, tools, overrides);
  const args = [
    "--root", root,
    "configure",
    "--config", candidate,
    "--codex-bin", tools.codexBin,
    "--codex-environment-root", tools.codexEnvironmentRoot
  ];
  if (approved) args.push("--approve-production-data");
  if (approveMessageScope) args.push("--approve-message-scope");
  return { candidate, result: run(args, { expected }) };
}

function forceDoctorFailure(cliSource) {
  const content = readFileSync(cliSource, "utf8");
  const healthyExpression = 'ready_for_service: healthy && process.platform === "darwin"';
  assert.equal(content.includes(healthyExpression), true);
  writeFileSync(cliSource, content.replace(healthyExpression, "ready_for_service: false"));
}

function versionedSource(version, {
  doctorReady = true,
  pluginVersion = version,
  stateFormat = 1
} = {}) {
  const source = path.join(
    mkdtempSync(path.join(tmpdir(), "twin-upgrade-source-")),
    "package"
  );
  const entries = [
    ".codex-plugin",
    "bin",
    "deploy",
    "executor",
    "intake",
    "ops",
    "product",
    "runtime",
    "shared",
    "skills"
  ];
  mkdirSync(source, { recursive: true });
  for (const entry of entries) {
    cpSync(path.join(projectRoot, entry), path.join(source, entry), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  manifest.version = version;
  manifest.feishuDigitalTwin.stateFormat = stateFormat;
  writeFileSync(path.join(source, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const pluginManifestPath = path.join(source, ".codex-plugin/plugin.json");
  const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, "utf8"));
  pluginManifest.version = pluginVersion;
  writeFileSync(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`);
  if (!doctorReady) forceDoctorFailure(path.join(source, "product/src/cli.mjs"));
  return source;
}

test("公开 CLI 帮助只暴露产品级命令", () => {
  const result = run(["--help"]);
  assert.match(result.stdout, /init/u);
  assert.match(result.stdout, /setup/u);
  assert.match(result.stdout, /profiles/u);
  assert.match(result.stdout, /configure/u);
  assert.match(result.stdout, /config update/u);
  assert.match(result.stdout, /doctor/u);
  assert.match(result.stdout, /status/u);
  assert.match(result.stdout, /freeze/u);
  assert.match(result.stdout, /resume/u);
  assert.match(result.stdout, /control <enable\|freeze\|upgrade\|rollback\|uninstall>/u);
  assert.match(result.stdout, /service <install\|start\|stop\|restart\|status\|uninstall>/u);
  assert.match(result.stdout, /upgrade \[--source PACKAGE_ROOT\] \[--restart\]/u);
  assert.match(result.stdout, /rollback \[--restart\]/u);
  assert.match(result.stdout, /uninstall/u);
  assert.match(result.stdout, /--lark-cli PATH/u);
  assert.match(result.stdout, /--codex-environment-root PATH/u);
  assert.match(result.stdout, /--profile NAME/u);
  assert.match(result.stdout, /--principal-aliases LIST/u);
  assert.match(result.stdout, /--message-scope SCOPE/u);
  assert.match(result.stdout, /--capabilities LIST/u);
  assert.match(result.stdout, /--domains LIST/u);
  assert.match(result.stdout, /--console-base-token TOKEN/u);
  assert.match(result.stdout, /--console-runtime-table NAME/u);
  assert.match(result.stdout, /--console-group-rules-table NAME/u);
  assert.match(result.stdout, /--knowledge-space-name NAME/u);
  assert.match(result.stdout, /--knowledge-space-id SPACE_ID/u);
  assert.match(result.stdout, /--knowledge-direction TEXT/u);
  assert.match(result.stdout, /--daily-memory-folder-token TOKEN/u);
  assert.match(result.stdout, /--daily-memory-folder-name NAME/u);
  assert.match(result.stdout, /--approve-message-scope/u);
  assert.doesNotMatch(
    result.stdout,
    /legacy\.private\.service|Private Example Person|private-provider\.example/u
  );
  assert.match(run(["-h"]).stdout, /feishu-digital-twin/u);
  assert.equal(run(["--version"]).stdout.trim(), CURRENT_VERSION);
});

test("profiles 通过官方 lark-cli 只读枚举可选 profile", () => {
  const tools = codexFixture({ lark: { profiles: ["team-a", "team-b"] } });
  const result = json(run([
    "--lark-cli", tools.larkCli,
    "profiles"
  ]));
  assert.deepEqual(result, {
    count: 2,
    profiles: ["team-a", "team-b"]
  });
  assert.equal(readFileSync(tools.larkLog, "utf8").trim(), "profile list");
});

test("init 安装到稳定版本目录并以冻结状态启动", () => {
  const { root, result } = initRoot("team-a");
  assert.equal(result.status, "initialized");
  assert.equal(result.active_version, CURRENT_VERSION);
  assert.equal(result.frozen, true);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(root, "private")).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(root, "installation.json")).mode & 0o777, 0o600);
  assert.ok(existsSync(path.join(root, `versions/${CURRENT_VERSION}/bin/feishu-digital-twin.mjs`)));
  assert.ok(existsSync(path.join(root, "launcher.mjs")));

  const status = json(run(["--root", root, "status"]));
  assert.equal(status.initialized, true);
  assert.equal(status.active_version, CURRENT_VERSION);
  assert.equal(status.frozen, true);
  assert.deepEqual(Object.keys(status.services), ["realtime", "supplement", "daily_memory"]);
  assert.equal(JSON.stringify(status).includes(root), false);

  const blocked = run(["--root", root, "resume"], { expected: 1 });
  assert.equal(JSON.parse(blocked.stderr).code, "DOCTOR_FAILED");
  assert.equal(json(run(["--root", root, "status"])).frozen, true);

  configureRoot(root, codexFixture());
  const missingServices = run(["--root", root, "resume"], { expected: 1 });
  assert.equal(JSON.parse(missingServices.stderr).code, "SERVICE_NOT_READY");
  assert.equal(json(run(["--root", root, "status"])).frozen, true);

  const launchAgents = path.join(root, "fake-launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-resume-launchctl-"))
  );
  json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "service", "install"
  ]));
  assert.equal(json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "resume"
  ])).frozen, false);
  assert.equal(json(run(["--root", root, "freeze"])).frozen, true);
});

test("init 接受已有空目录，但拒绝未初始化的非空目录且不改动预存数据", () => {
  const emptyRoot = path.join(mkdtempSync(path.join(tmpdir(), "twin-empty-root-")), "install");
  mkdirSync(emptyRoot, { mode: 0o755 });
  const initialized = json(run([
    "--root", emptyRoot,
    "init",
    "--instance", "empty-root"
  ]));
  assert.equal(initialized.status, "initialized");
  assert.equal(statSync(emptyRoot).mode & 0o777, 0o700);

  const occupiedRoot = path.join(
    mkdtempSync(path.join(tmpdir(), "twin-occupied-root-")),
    "install"
  );
  mkdirSync(path.join(occupiedRoot, "private"), { recursive: true, mode: 0o700 });
  const configPath = path.join(occupiedRoot, "private/config.json");
  const statePath = path.join(occupiedRoot, "private/state.sqlite");
  writeFileSync(configPath, "preexisting-config\n", { mode: 0o600 });
  writeFileSync(statePath, "preexisting-state\n", { mode: 0o600 });

  const blocked = run([
    "--root", occupiedRoot,
    "init",
    "--instance", "occupied-root"
  ], { expected: 1 });
  assert.equal(JSON.parse(blocked.stderr).code, "NONEMPTY_PRODUCT_ROOT");
  assert.equal(readFileSync(configPath, "utf8"), "preexisting-config\n");
  assert.equal(readFileSync(statePath, "utf8"), "preexisting-state\n");
  assert.equal(existsSync(path.join(occupiedRoot, "installation.json")), false);
  assert.equal(existsSync(path.join(occupiedRoot, "versions")), false);
  assert.equal(existsSync(path.join(occupiedRoot, "launcher.mjs")), false);
});

test("init 拒绝符号链接产品根目录且不写入链接目标", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-symlink-root-"));
  const target = path.join(directory, "target");
  const root = path.join(directory, "install");
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, root);

  const blocked = run([
    "--root", root,
    "init",
    "--instance", "symlink-root"
  ], { expected: 1 });
  assert.equal(JSON.parse(blocked.stderr).code, "PRIVATE_ROOT_SYMLINK");
  assert.deepEqual(readdirSync(target), []);
});

test("安装元数据中的状态路径不能逃逸私有安装目录", () => {
  const { root } = initRoot("invalid-state-path");
  const installationPath = path.join(root, "installation.json");
  const installation = JSON.parse(readFileSync(installationPath, "utf8"));
  installation.state_database = "../outside.sqlite";
  writeFileSync(installationPath, `${JSON.stringify(installation, null, 2)}\n`, { mode: 0o600 });

  const blocked = run(["--root", root, "status"], { expected: 1 });
  assert.equal(JSON.parse(blocked.stderr).code, "INVALID_PRIVATE_PATH");
});

test("control 任务型入口薄映射 enable、freeze、upgrade、rollback 和 uninstall", () => {
  const { root } = initRoot("control-alias");
  configureRoot(root, codexFixture());

  const enable = run(["--root", root, "control", "enable"], { expected: 1 });
  assert.equal(JSON.parse(enable.stderr).code, "SERVICE_NOT_READY");
  assert.equal(json(run(["--root", root, "control", "freeze"])).frozen, true);

  const upgraded = json(run([
    "--root", root,
    "control", "upgrade",
    "--source", versionedSource("0.2.0")
  ]));
  assert.equal(upgraded.active_version, "0.2.0");
  assert.equal(json(run(["--root", root, "control", "rollback"])).active_version, CURRENT_VERSION);

  const launchctl = fakeLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-control-uninstall-launchctl-"))
  );
  const removed = json(run([
    "--root", root,
    "--launch-agents-dir", path.join(root, "fake-launch-agents"),
    "--launchctl-bin", launchctl.filename,
    "control", "uninstall"
  ]));
  assert.equal(removed.status, "uninstalled");
  assert.equal(existsSync(path.join(root, "installation.json")), false);
});

test("configure 通过真实 ConfigLoader、飞书身份和合成推理后才写入私有配置", () => {
  const { root } = initRoot();
  const tools = codexFixture();
  const configured = json(configureRoot(root, tools).result);
  assert.equal(configured.status, "configured");
  assert.equal(configured.production_data_approved, true);

  const configPath = path.join(root, "private/config.json");
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(config.codex_bin, realpathSync(tools.codexBin));
  assert.equal(config.codex_environment_root, realpathSync(tools.codexEnvironmentRoot));
  assert.equal(Object.hasOwn(config, "provider_ref"), false);
  assert.equal(existsSync(path.join(root, "private/providers")), false);
  const installation = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  assert.equal(Object.hasOwn(installation, "timezone"), false);
  assert.equal(Object.hasOwn(installation, "schedule"), false);
  assert.equal(readFileSync(tools.larkLog, "utf8").trim(), [
    "--profile",
    "fixture-profile",
    "auth",
    "status",
    "--json",
    "--verify"
  ].join(" "));

  const result = json(run(["--root", root, "doctor"]));
  assert.equal(result.healthy, true);
  assert.equal(result.ready_for_service, true);
  assert.equal(result.checks.services.status, "warning");
  assert.equal(result.checks.config.status, "pass");
  assert.equal(result.checks.lark_auth.status, "pass");
  assert.equal(result.checks.lark_user.status, "pass");
  assert.equal(result.checks.lark_bot.status, "pass");
  assert.equal(result.checks.lark_resources.status, "pass");
  assert.equal(result.checks.codex_runtime.status, "pass");
  assert.equal(result.checks.production_data.status, "pass");
  assert.equal(result.checks.inference.status, "pass");
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(JSON.stringify(result).includes(tools.larkCli), false);
  assert.equal(JSON.stringify(result).includes(tools.codexBin), false);
  assert.equal(JSON.stringify(result).includes(tools.codexEnvironmentRoot), false);
});

test("status 用脱敏摘要区分 degraded、safe-but-disabled 和 ready", () => {
  const absentRoot = path.join(mkdtempSync(path.join(tmpdir(), "twin-status-absent-")), "install");
  const absent = json(run(["--root", absentRoot, "status"]));
  assert.equal(absent.readiness, "degraded");
  assert.equal(absent.configured, false);
  assert.equal(absent.production_enabled, false);
  assert.equal(absent.message_scope, null);
  assert.equal(absent.doctor.healthy, false);
  assert.equal(absent.service.healthy, false);

  const { root } = initRoot("readiness");
  const tools = codexFixture();
  configureRoot(root, tools, {
    overrides: { control: { mode: "local", enabled: true } }
  });
  const configured = json(run(["--root", root, "status"]));
  assert.equal(configured.readiness, "degraded");
  assert.equal(configured.configured, true);
  assert.equal(configured.production_enabled, true);
  assert.equal(configured.message_scope, "all_visible");
  assert.equal(configured.doctor.healthy, true);
  assert.equal(configured.service.healthy, false);

  const launchAgents = path.join(root, "fake-launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-status-launchctl-"))
  );
  json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "service", "install"
  ]));
  const disabled = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "status"
  ]));
  assert.equal(disabled.readiness, "safe-but-disabled");
  assert.equal(disabled.frozen, true);
  assert.equal(disabled.service.installed, true);
  assert.equal(disabled.service.healthy, true);

  json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "resume"
  ]));
  const ready = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "status"
  ]));
  assert.equal(ready.readiness, "ready");
  assert.equal(ready.frozen, false);
  const serialized = JSON.stringify(ready);
  for (const secret of [
    root,
    tools.larkCli,
    tools.codexBin,
    tools.codexEnvironmentRoot,
    "principal_fixture",
    "fixture-profile"
  ]) assert.equal(serialized.includes(secret), false);
});

test("launcher status 在实例状态目录不可写时保持只读且不创建 SQLite 侧文件", {
  skip: process.platform === "win32"
}, () => {
  const { root } = initRoot("status-readonly");
  const tools = codexFixture();
  configureRoot(root, tools, {
    overrides: { control: { mode: "local", enabled: true } }
  });
  const installation = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  const privateDirectory = path.join(root, "private");
  const databasePath = path.join(root, installation.state_database);
  const launcher = path.join(root, "launcher.mjs");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-status-readonly-launchctl-"))
  );
  chmodSync(databasePath, 0o400);
  const before = snapshotDirectory(privateDirectory);
  chmodSync(privateDirectory, 0o500);
  try {
    const result = runCli(launcher, [
      "--launch-agents-dir", path.join(root, "fake-launch-agents"),
      "--launchctl-bin", launchctl.filename,
      "status"
    ]);

    assert.doesNotMatch(result.stderr, /LOCAL_COMMAND_FAILED/u);
    assert.equal(json(result).frozen, true);
    assert.deepEqual(snapshotDirectory(privateDirectory), before);
  } finally {
    chmodSync(privateDirectory, 0o700);
    chmodSync(databasePath, 0o600);
  }
});

test("launcher status 从只读 WAL 状态读取最新冻结值且不修改侧文件", {
  skip: process.platform === "win32"
}, () => {
  const { root } = initRoot("status-readonly-wal");
  const tools = codexFixture();
  configureRoot(root, tools, {
    overrides: { control: { mode: "local", enabled: true } }
  });
  const installation = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  const privateDirectory = path.join(root, "private");
  const databasePath = path.join(root, installation.state_database);
  const launcher = path.join(root, "launcher.mjs");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-status-readonly-wal-launchctl-"))
  );
  const writer = new DatabaseSync(databasePath);
  try {
    writer.prepare(`
      UPDATE runtime_control
      SET frozen = 0, reason = 'TEST_LATEST_WAL', updated_at = '2026-07-25T08:00:00.000Z'
      WHERE singleton = 1
    `).run();
    const before = snapshotDirectory(privateDirectory);
    assert.equal(Object.hasOwn(before, `${path.basename(databasePath)}-wal`), true);
    assert.equal(Object.hasOwn(before, `${path.basename(databasePath)}-shm`), true);
    chmodSync(privateDirectory, 0o500);

    const result = runCli(launcher, [
      "--launch-agents-dir", path.join(root, "fake-launch-agents"),
      "--launchctl-bin", launchctl.filename,
      "status"
    ]);

    assert.equal(json(result).frozen, false);
    assert.deepEqual(snapshotDirectory(privateDirectory), before);
  } finally {
    chmodSync(privateDirectory, 0o700);
    writer.close();
  }
});

test("launcher status 在快照期间出现新 WAL 时重试并返回最新冻结值", async () => {
  const { root } = initRoot("status-readonly-wal-race");
  const tools = codexFixture();
  configureRoot(root, tools, {
    overrides: { control: { mode: "local", enabled: true } }
  });
  const installation = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  const databasePath = path.join(root, installation.state_database);
  const launcher = path.join(root, "launcher.mjs");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-status-readonly-race-launchctl-"))
  );
  const initial = new DatabaseSync(databasePath);
  initial.prepare(`
    UPDATE runtime_control
    SET frozen = 0, reason = 'TEST_BEFORE_SNAPSHOT', updated_at = '2026-07-25T08:00:00.000Z'
    WHERE singleton = 1
  `).run();
  initial.exec(`
    CREATE TABLE status_snapshot_padding (payload BLOB NOT NULL);
    INSERT INTO status_snapshot_padding VALUES (zeroblob(16777216));
  `);
  initial.close();
  const snapshotPrefix = "feishu-digital-twin-state-";
  const snapshotTempRoot = mkdtempSync(path.join(tmpdir(), "twin-state-snapshot-race-"));
  chmodSync(snapshotTempRoot, 0o700);
  const existingSnapshots = new Set(
    readdirSync(snapshotTempRoot).filter((name) => name.startsWith(snapshotPrefix))
  );
  const updater = spawn(process.execPath, ["--input-type=module", "-e", `
    import { readdirSync } from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    const [temporaryRoot, statePath, prefix, existingJson] = process.argv.slice(1);
    const existing = new Set(JSON.parse(existingJson));
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    process.stdout.write("ready\\n");
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const created = readdirSync(temporaryRoot).some((name) => (
        name.startsWith(prefix) && !existing.has(name)
      ));
      if (created) {
        const database = new DatabaseSync(statePath);
        database.prepare(\`
          UPDATE runtime_control
          SET frozen = 1, reason = 'TEST_DURING_SNAPSHOT',
              updated_at = '2026-07-25T08:00:01.000Z'
          WHERE singleton = 1
        \`).run();
        database.close();
        process.stdout.write("updated\\n");
        process.exit(0);
      }
      Atomics.wait(waitArray, 0, 0, 1);
    }
    process.exit(2);
  `, snapshotTempRoot, databasePath, snapshotPrefix, JSON.stringify([...existingSnapshots])], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let updaterStdout = "";
  let updaterStderr = "";
  updater.stdout.setEncoding("utf8");
  updater.stderr.setEncoding("utf8");
  const updaterReady = new Promise((resolve) => {
    updater.stdout.on("data", (chunk) => {
      updaterStdout += chunk;
      if (updaterStdout.includes("ready\n")) resolve();
    });
  });
  updater.stderr.on("data", (chunk) => { updaterStderr += chunk; });
  await updaterReady;
  const child = spawn(process.execPath, [launcher,
    "--launch-agents-dir", path.join(root, "fake-launch-agents"),
    "--launchctl-bin", launchctl.filename,
    "status"
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      TMPDIR: snapshotTempRoot,
      TMP: snapshotTempRoot,
      TEMP: snapshotTempRoot
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [[exitCode], [updaterExitCode]] = await Promise.all([
    once(child, "close"),
    once(updater, "close")
  ]);

  assert.equal(exitCode, 0, stderr || stdout);
  assert.equal(updaterExitCode, 0, updaterStderr || updaterStdout);
  assert.match(updaterStdout, /updated/u);
  assert.equal(JSON.parse(stdout).frozen, true);
});

test("launcher status 对缺失的运行状态失败关闭并返回 degraded", () => {
  const { root } = initRoot("status-missing-runtime-state");
  const tools = codexFixture();
  configureRoot(root, tools, {
    overrides: { control: { mode: "local", enabled: true } }
  });
  const launchAgents = path.join(root, "fake-launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-status-missing-state-launchctl-"))
  );
  json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "service", "install"
  ]));
  json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "resume"
  ]));
  const installation = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  const database = new DatabaseSync(path.join(root, installation.state_database));
  database.exec("DROP TABLE runtime_control");
  database.close();

  const result = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "status"
  ]));

  assert.equal(result.readiness, "degraded");
  assert.equal(result.frozen, true);
  assert.deepEqual(
    result.doctor.failed_checks.find(({ name }) => name === "runtime_state"),
    { name: "runtime_state", code: "STATE_UNAVAILABLE" }
  );
});

test("status 对旧版 v1 配置推断本机或 Base 控制模式", () => {
  for (const mode of ["local", "base"]) {
    const { root } = initRoot("legacy-" + mode + "-status");
    const tools = codexFixture();
    configureRoot(root, tools, {
      overrides: {
        schema_version: 1,
        control: undefined,
        production_enabled: mode === "local",
        ...(mode === "base" ? {
          allowed_lark_domains: ["im", "base"],
          console: {
            base_token: "fixture_private_base_token",
            runtime_table: "fixture_private_runtime_table",
            group_rules_table: "fixture_private_group_rules_table"
          },
          authority_rules: ["旧版 Base 空规则时可使用本机规则。"]
        } : {})
      }
    });

    const result = json(run(["--root", root, "status"]));
    assert.equal(result.control_mode, mode);
    assert.equal(result.control_healthy, true);
    assert.equal(result.production_enabled, true);
  }
});

test("configure 固定实际验证的 lark-cli 普通可执行文件供后台和 Doctor 共用", () => {
  const { root } = initRoot("pinned-lark-cli");
  const tools = codexFixture();
  const searchDirectory = mkdtempSync(path.join(tmpdir(), "twin-lark-search-"));
  const searchedLark = path.join(searchDirectory, "lark-cli");
  symlinkSync(tools.larkCli, searchedLark);
  const candidate = writeCandidate(root, tools, { lark_cli_bin: "lark-cli" });
  const searchPath = `${searchDirectory}${path.delimiter}${process.env.PATH ?? ""}`;

  const configured = json(run([
    "--root", root,
    "configure",
    "--config", candidate,
    "--codex-bin", tools.codexBin,
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data",
    "--approve-message-scope"
  ], { env: { PATH: searchPath } }));
  assert.equal(configured.status, "configured");

  const privateConfig = JSON.parse(readFileSync(
    path.join(root, "private/config.json"),
    "utf8"
  ));
  assert.equal(privateConfig.lark_cli_bin, realpathSync(tools.larkCli));
  assert.equal(path.isAbsolute(privateConfig.lark_cli_bin), true);
  assert.equal(statSync(privateConfig.lark_cli_bin).isFile(), true);

  const badDirectory = mkdtempSync(path.join(tmpdir(), "twin-bad-lark-"));
  const badLark = fakeLarkCli(badDirectory, { botStatus: "unavailable" });
  const doctor = json(run(["--root", root, "doctor"], {
    env: { PATH: `${badDirectory}${path.delimiter}${process.env.PATH ?? ""}` }
  }));
  assert.equal(doctor.healthy, true);
  assert.equal(existsSync(badLark.log), false);
});

test("configure 接受官方 auth status 当前无 ok 字段的已验证身份信封", () => {
  const { root } = initRoot("official-auth-envelope");
  const tools = codexFixture({ lark: { includeOk: false } });
  const configured = configureRoot(root, tools);

  assert.equal(configured.result.status, 0);
  assert.equal(json(configured.result).status, "configured");
});

test("Codex 或飞书 Doctor 失败时 configure 不落盘且不会覆盖有效配置", () => {
  for (const failure of ["codex", "lark"]) {
    const { root } = initRoot(`failure-${failure}`);
    const tools = codexFixture({
      lark: failure === "lark" ? { botStatus: "unavailable" } : {}
    });
    if (failure === "codex") {
      writeFileSync(tools.codexBin, "#!/bin/sh\nexit 9\n", { mode: 0o700 });
      chmodSync(tools.codexBin, 0o700);
    }
    const candidate = writeCandidate(root, tools);
    const result = run([
      "--root", root,
      "configure",
      "--config", candidate,
      "--codex-bin", tools.codexBin,
      "--codex-environment-root", tools.codexEnvironmentRoot,
      "--approve-production-data",
      "--approve-message-scope"
    ], { expected: 1 });
    const error = JSON.parse(result.stderr.trim());
    assert.equal(
      error.code,
      failure === "codex" ? "CODEX_DOCTOR_FAILED" : "LARK_AUTH_NOT_READY"
    );
    assert.equal(existsSync(path.join(root, "private/config.json")), false);
    assert.equal(existsSync(path.join(root, "private/providers")), false);
  }

  const { root } = initRoot("already-configured");
  const tools = codexFixture();
  configureRoot(root, tools);
  const before = readFileSync(path.join(root, "private/config.json"), "utf8");
  const second = configureRoot(root, codexFixture(), {
    expected: 1,
    overrides: { profile: "other-profile" }
  });
  assert.equal(second.result.status, 1);
  assert.equal(JSON.parse(second.result.stderr).code, "ALREADY_CONFIGURED");
  assert.equal(readFileSync(path.join(root, "private/config.json"), "utf8"), before);
});

test("configure 和 setup 拒绝源码树内的候选配置", () => {
  const unsafeCandidate = path.join(projectRoot, "config.example.json");
  for (const command of ["configure", "setup"]) {
    const root = path.join(
      mkdtempSync(path.join(tmpdir(), `twin-unsafe-${command}-`)),
      "install"
    );
    if (command === "configure") {
      json(run(["--root", root, "init", "--instance", `unsafe-${command}`]));
    }
    const tools = codexFixture();
    const args = [
      "--root", root,
      command,
      "--config", unsafeCandidate,
      "--codex-bin", tools.codexBin,
      "--codex-environment-root", tools.codexEnvironmentRoot,
      "--approve-production-data",
      "--approve-message-scope"
    ];
    const result = run(args, { expected: 1 });
    assert.equal(JSON.parse(result.stderr).code, "UNSAFE_CONFIG_LOCATION");
    assert.equal(existsSync(path.join(root, "private/config.json")), false);
  }
});

test("config update 同样拒绝源码树内的候选配置", () => {
  const { root } = initRoot("unsafe-config-update");
  configureRoot(root, codexFixture());
  const configPath = path.join(root, "private/config.json");
  const before = readFileSync(configPath, "utf8");

  const result = run([
    "--root", root,
    "config", "update",
    "--config", path.join(projectRoot, "config.example.json")
  ], { expected: 1 });

  assert.equal(JSON.parse(result.stderr).code, "UNSAFE_CONFIG_LOCATION");
  assert.equal(readFileSync(configPath, "utf8"), before);
});

test("setup 拒绝未初始化的非空目录且不删除预存配置或状态", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-setup-occupied-")), "install");
  mkdirSync(path.join(root, "private"), { recursive: true, mode: 0o700 });
  const configPath = path.join(root, "private/config.json");
  const statePath = path.join(root, "private/state.sqlite");
  writeFileSync(configPath, "preexisting-config\n", { mode: 0o600 });
  writeFileSync(statePath, "preexisting-state\n", { mode: 0o600 });
  const tools = codexFixture();
  const candidate = writeCandidate(root, tools);

  const blocked = run([
    "--root", root,
    "setup",
    "--config", candidate,
    "--codex-bin", tools.codexBin,
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data",
    "--approve-message-scope"
  ], { expected: 1 });
  assert.equal(JSON.parse(blocked.stderr).code, "NONEMPTY_PRODUCT_ROOT");
  assert.equal(readFileSync(configPath, "utf8"), "preexisting-config\n");
  assert.equal(readFileSync(statePath, "utf8"), "preexisting-state\n");
  assert.equal(existsSync(path.join(root, "installation.json")), false);
  assert.equal(existsSync(path.join(root, "versions")), false);
  assert.equal(existsSync(path.join(root, "launcher.mjs")), false);
  assert.equal(existsSync(candidate), true);
});

test("setup 要求部署者显式配置 message_scope", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-scope-confirm-")), "install");
  const tools = codexFixture();
  const candidate = writeCandidate(root, tools);
  const source = JSON.parse(readFileSync(candidate, "utf8"));
  delete source.message_scope;
  writeFileSync(candidate, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });

  const result = run([
    "--root", root,
    "setup",
    "--config", candidate,
    "--codex-bin", tools.codexBin,
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data",
    "--approve-message-scope"
  ], { expected: 1 });
  assert.equal(JSON.parse(result.stderr).code, "INVALID_INSTANCE_CONFIG");
  assert.equal(existsSync(path.join(root, "installation.json")), false);
  assert.equal(existsSync(candidate), true);
});

test("configure 和 config update 同样拒绝缺失 message_scope", () => {
  const { root } = initRoot("scope-required");
  const tools = codexFixture();
  const initialCandidate = writeCandidate(root, tools);
  const initial = JSON.parse(readFileSync(initialCandidate, "utf8"));
  delete initial.message_scope;
  writeFileSync(initialCandidate, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });

  const configureResult = run([
    "--root", root,
    "configure",
    "--config", initialCandidate,
    "--codex-bin", tools.codexBin,
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data",
    "--approve-message-scope"
  ], { expected: 1 });
  assert.equal(JSON.parse(configureResult.stderr).code, "INVALID_INSTANCE_CONFIG");
  assert.equal(existsSync(path.join(root, "private/config.json")), false);

  configureRoot(root, tools, { overrides: { message_scope: "bot_only" } });
  const configPath = path.join(root, "private/config.json");
  const before = readFileSync(configPath, "utf8");
  const update = JSON.parse(before);
  delete update.message_scope;
  const updatePath = path.join(path.dirname(root), "scope-required-update.json");
  writeFileSync(updatePath, `${JSON.stringify(update, null, 2)}\n`, { mode: 0o600 });
  const updateResult = run([
    "--root", root,
    "config", "update",
    "--config", updatePath
  ], { expected: 1 });
  assert.equal(JSON.parse(updateResult.stderr).code, "INVALID_INSTANCE_CONFIG");
  assert.equal(readFileSync(configPath, "utf8"), before);
});

test("非 bot_only 的初始消息范围必须独立确认", () => {
  for (const messageScope of ["internal_visible", "all_visible"]) {
    const { root } = initRoot(`scope-initial-${messageScope.replace("_", "-")}`);
    const tools = codexFixture();
    const blocked = configureRoot(root, tools, {
      approveMessageScope: false,
      expected: 1,
      overrides: { message_scope: messageScope }
    });
    assert.equal(JSON.parse(blocked.result.stderr).code, "MESSAGE_SCOPE_APPROVAL_REQUIRED");
    assert.equal(existsSync(path.join(root, "private/config.json")), false);
  }

  const { root } = initRoot("scope-initial-bot-only");
  const configured = json(configureRoot(root, codexFixture(), {
    approveMessageScope: false,
    overrides: { message_scope: "bot_only" }
  }).result);
  assert.equal(configured.status, "configured");
});

test("setup 在扩大消息范围前要求独立确认且不写入新安装", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-setup-scope-")), "install");
  const tools = codexFixture();
  const candidate = writeCandidate(root, tools, { message_scope: "internal_visible" });
  const blocked = run([
    "--root", root,
    "setup",
    "--config", candidate,
    "--codex-bin", tools.codexBin,
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], { expected: 1 });
  assert.equal(JSON.parse(blocked.stderr).code, "MESSAGE_SCOPE_APPROVAL_REQUIRED");
  assert.equal(existsSync(root), false);
  assert.equal(existsSync(candidate), true);
});

test("setup 扩大已有实例消息范围时先要求独立确认且不改变本地状态", () => {
  const { root } = initRoot("setup-scope-existing");
  const tools = codexFixture();
  configureRoot(root, tools, {
    approveMessageScope: false,
    overrides: { message_scope: "bot_only" }
  });
  const configPath = path.join(root, "private/config.json");
  const before = readFileSync(configPath, "utf8");
  const candidate = JSON.parse(before);
  candidate.message_scope = "internal_visible";
  const candidatePath = path.join(path.dirname(root), "setup-scope-existing.json");
  writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });

  const blocked = run([
    "--root", root,
    "setup",
    "--config", candidatePath,
    "--codex-bin", tools.codexBin,
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], { expected: 1 });
  assert.equal(JSON.parse(blocked.stderr).code, "MESSAGE_SCOPE_APPROVAL_REQUIRED");
  assert.equal(readFileSync(configPath, "utf8"), before);
  assert.equal(json(run(["--root", root, "status"])).frozen, true);
});

test("setup 幂等收口初始化、配置、Doctor 和健康后台服务", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-setup-")), "install");
  const tools = codexFixture();
  const candidate = writeCandidate(root, tools, {
    control: { mode: "local", enabled: true }
  });
  const launchAgents = path.join(path.dirname(root), "launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-setup-launchctl-"))
  );
  const args = [
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "setup",
    "--config", candidate,
    "--codex-bin", tools.codexBin,
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data",
    "--approve-message-scope"
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = json(run(args));
    assert.equal(result.status, "setup-complete");
    assert.equal(result.readiness, "ready");
    assert.equal(result.configured, true);
    assert.equal(result.production_enabled, true);
    assert.equal(result.message_scope, "all_visible");
    assert.equal(result.frozen, false);
    assert.equal(result.doctor.healthy, true);
    assert.equal(result.service.healthy, true);
  }

  const final = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "status"
  ]));
  assert.equal(final.readiness, "ready");
  assert.equal(existsSync(candidate), true);
  assert.equal(statSync(path.join(root, "private/config.json")).mode & 0o777, 0o600);
});

test("setup 无需预写 JSON 即可发现官方双身份并生成最小私有配置", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-guided-setup-")), "install");
  const tools = codexFixture({ lark: { includeOk: false } });
  const launchAgents = path.join(path.dirname(root), "launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-guided-setup-launchctl-"))
  );
  const result = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "setup",
    "--profile", "fixture-profile",
    "--timezone", "Asia/Shanghai",
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], {
    env: { PATH: `${tools.directory}${path.delimiter}${process.env.PATH ?? ""}` }
  }));

  assert.equal(result.status, "setup-complete");
  assert.equal(result.readiness, "ready");
  assert.equal(result.message_scope, "bot_only");
  const privateConfig = JSON.parse(readFileSync(
    path.join(root, "private/config.json"),
    "utf8"
  ));
  assert.equal(privateConfig.profile, "fixture-profile");
  assert.equal(privateConfig.lark_cli_bin, realpathSync(tools.larkCli));
  assert.equal(privateConfig.codex_bin, realpathSync(tools.codexBin));
  assert.equal(privateConfig.codex_environment_root, realpathSync(tools.codexEnvironmentRoot));
  assert.equal(privateConfig.principal.name, "示例发现用户");
  assert.equal(privateConfig.principal.open_id, "ou_fixture_discovered_principal");
  assert.equal(privateConfig.principal.timezone, "Asia/Shanghai");
  assert.deepEqual(privateConfig.allowed_lark_domains, ["im"]);
  assert.equal(privateConfig.production_data_approved, true);
  assert.deepEqual(privateConfig.control, { mode: "local", enabled: true });
  assert.equal(privateConfig.privacy.state_retention_days, 7);
  assert.equal(privateConfig.privacy.result_log_retention_days, 3);
  const serializedResult = JSON.stringify(result);
  assert.equal(serializedResult.includes("示例发现用户"), false);
  assert.equal(serializedResult.includes("ou_fixture_discovered_principal"), false);
});

test("setup 可用脚本化选项引用已有控制 Base 和每日记忆目录", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-guided-resources-")), "install");
  const tools = codexFixture({ lark: { includeOk: false } });
  const launchAgents = path.join(path.dirname(root), "launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-guided-resources-launchctl-"))
  );
  const privateValues = {
    baseToken: ["fixture", "private", "base", "token"].join("_"),
    runtimeTable: ["fixture", "private", "runtime", "table"].join("_"),
    groupRulesTable: ["fixture", "private", "group", "rules", "table"].join("_"),
    folderToken: ["fixture", "private", "folder", "token"].join("_"),
    folderName: ["fixture", "private", "folder", "name"].join("_"),
    alias: ["fixture", "private", "principal", "alias"].join("_")
  };
  const result = run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "setup",
    "--profile", "fixture-profile",
    "--timezone", "Asia/Shanghai",
    "--console-base-token", privateValues.baseToken,
    "--console-runtime-table", privateValues.runtimeTable,
    "--console-group-rules-table", privateValues.groupRulesTable,
    "--daily-memory-folder-token", privateValues.folderToken,
    "--daily-memory-folder-name", privateValues.folderName,
    "--principal-aliases", `老板,${privateValues.alias}`,
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], {
    env: { PATH: `${tools.directory}${path.delimiter}${process.env.PATH ?? ""}` }
  });

  assert.equal(json(result).status, "setup-complete");
  const privateConfigPath = path.join(root, "private/config.json");
  const privateConfig = JSON.parse(readFileSync(privateConfigPath, "utf8"));
  const expectedBaseReference = privateValues.baseToken;
  const expectedFolderReference = privateValues.folderToken;
  assert.deepEqual(privateConfig.control, { mode: "base" });
  assert.deepEqual(privateConfig.allowed_lark_domains, [
    "im",
    "base",
    "task",
    "calendar",
    "drive",
    "docs"
  ]);
  assert.deepEqual(privateConfig.console, {
    base_token: expectedBaseReference,
    runtime_table: privateValues.runtimeTable,
    group_rules_table: privateValues.groupRulesTable
  });
  assert.deepEqual(privateConfig.daily_memory, {
    folder_token: expectedFolderReference,
    folder_name: privateValues.folderName,
    excluded_chat_ids: [],
    excluded_topics: []
  });
  assert.deepEqual(privateConfig.principal.address_names, [
    "示例发现用户",
    "老板",
    privateValues.alias
  ]);
  assert.equal(Object.hasOwn(privateConfig, "authority_rules"), false);
  assert.deepEqual(privateConfig.schedule, {
    workdays: [1, 2, 3, 4, 5],
    workday_start_hour: 9,
    workday_end_hour: 18,
    work_interval_seconds: 30,
    quiet_interval_seconds: 300,
    daily_memory_hour: 0,
    daily_memory_minute: 10
  });
  assert.equal(privateConfig.privacy.state_retention_days, 7);
  assert.equal(privateConfig.privacy.result_log_retention_days, 3);
  assert.equal(statSync(privateConfigPath).mode & 0o777, 0o600);
  for (const value of Object.values(privateValues)) {
    assert.equal(result.stdout.includes(value), false);
    assert.equal(result.stderr.includes(value), false);
  }
  const larkCalls = readFileSync(tools.larkLog, "utf8");
  assert.match(larkCalls, /\bbase \+record-list\b/u);
  assert.match(larkCalls, /\bdrive files list\b/u);
  assert.doesNotMatch(
    larkCalls,
    /\+(?:record-(?:create|update|delete)|create|update|delete|import|move)\b/u
  );
});

test("setup 在本机控制模式把已有知识空间写成 AI 自然语言规则", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-guided-knowledge-")), "install");
  const tools = codexFixture({ lark: { includeOk: false } });
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-guided-knowledge-launchctl-"))
  );
  const privateValues = {
    name: ["fixture", "private", "knowledge", "name"].join("_"),
    spaceId: ["fixture", "private", "space", "id"].join("_"),
    direction: ["fixture", "private", "business", "direction"].join("_")
  };
  const result = run([
    "--root", root,
    "--launch-agents-dir", path.join(path.dirname(root), "launch-agents"),
    "--launchctl-bin", launchctl.filename,
    "setup",
    "--profile", "fixture-profile",
    "--timezone", "Asia/Shanghai",
    "--knowledge-space-name", privateValues.name,
    "--knowledge-space-id", privateValues.spaceId,
    "--knowledge-direction", privateValues.direction,
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], {
    env: { PATH: `${tools.directory}${path.delimiter}${process.env.PATH ?? ""}` }
  });

  assert.equal(json(result).status, "setup-complete");
  const privateConfig = JSON.parse(readFileSync(
    path.join(root, "private/config.json"),
    "utf8"
  ));
  assert.deepEqual(privateConfig.control, { mode: "local", enabled: true });
  assert.equal(Object.hasOwn(privateConfig, "console"), false);
  assert.deepEqual(privateConfig.authority_rules, [
    `企业知识库：${privateValues.name}；space_id=${privateValues.spaceId}；适用于${privateValues.direction}`
  ]);
  assert.deepEqual(privateConfig.allowed_lark_domains, [
    "im",
    "drive",
    "wiki",
    "docs",
    "base",
    "sheets",
    "markdown"
  ]);
  for (const value of Object.values(privateValues)) {
    assert.equal(result.stdout.includes(value), false);
    assert.equal(result.stderr.includes(value), false);
  }
  const larkCalls = readFileSync(tools.larkLog, "utf8");
  assert.match(larkCalls, /\bwiki \+space-list\b/u);
  assert.doesNotMatch(larkCalls, /\b(?:base|drive|docs)\b/u);
});

test("setup 用官方 CLI 只读验真已有 Base、Wiki 和 Drive 引用并对无效引用失败关闭", () => {
  const fixtures = [{
    name: "base",
    lark: { baseFailAfter: 0 },
    resourceArgs: [
      "--console-base-token", "fixture_private_base_token",
      "--console-runtime-table", "fixture_private_runtime_table",
      "--console-group-rules-table", "fixture_private_group_rules_table"
    ]
  }, {
    name: "wiki",
    lark: { wikiSpaces: [] },
    resourceArgs: [
      "--knowledge-space-name", "fixture_private_knowledge_name",
      "--knowledge-space-id", "fixture_private_space_id",
      "--knowledge-direction", "fixture_private_direction"
    ]
  }, {
    name: "drive",
    lark: { driveListExitCode: 1 },
    resourceArgs: [
      "--daily-memory-folder-token", "fixture_private_folder_token",
      "--daily-memory-folder-name", "fixture_private_folder_name"
    ]
  }];

  for (const fixture of fixtures) {
    const root = path.join(
      mkdtempSync(path.join(tmpdir(), "twin-invalid-" + fixture.name + "-resource-")),
      "install"
    );
    const tools = codexFixture({ lark: fixture.lark });
    const launchctl = fakeStatefulLaunchctl(
      mkdtempSync(path.join(tmpdir(), "twin-invalid-" + fixture.name + "-launchctl-"))
    );
    const result = run([
      "--root", root,
      "--launch-agents-dir", path.join(path.dirname(root), "launch-agents"),
      "--launchctl-bin", launchctl.filename,
      "setup",
      "--profile", "fixture-profile",
      "--timezone", "Asia/Shanghai",
      ...fixture.resourceArgs,
      "--codex-environment-root", tools.codexEnvironmentRoot,
      "--approve-production-data"
    ], {
      env: { PATH: tools.directory + path.delimiter + (process.env.PATH ?? "") },
      expected: 1
    });

    assert.equal(JSON.parse(result.stderr).code, "DOCTOR_FAILED");
    assert.equal(existsSync(root), false);
    for (const value of fixture.resourceArgs.filter((_, index) => index % 2 === 1)) {
      assert.equal(result.stdout.includes(value), false);
      assert.equal(result.stderr.includes(value), false);
    }
    assert.doesNotMatch(
      readFileSync(tools.larkLog, "utf8"),
      /\+(?:record-(?:create|update|delete)|create|update|delete|import|move)\b/u
    );
  }
});

test("setup 对高级配置中资源所需官方域缺失时失败关闭", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-resource-domain-gap-")), "install");
  const tools = codexFixture();
  const candidate = writeCandidate(root, tools, {
    message_scope: "bot_only",
    control: { mode: "local", enabled: true },
    allowed_lark_domains: ["im"],
    authority_rules: [
      "企业知识库：fixture_private_knowledge_name；space_id=fixture_private_space_id；适用于产品"
    ]
  });
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-resource-domain-gap-launchctl-"))
  );
  const result = run([
    "--root", root,
    "--launch-agents-dir", path.join(path.dirname(root), "launch-agents"),
    "--launchctl-bin", launchctl.filename,
    "setup",
    "--config", candidate,
    "--codex-bin", tools.codexBin,
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], { expected: 1 });

  assert.equal(JSON.parse(result.stderr).code, "DOCTOR_FAILED");
  assert.equal(existsSync(root), false);
});

test("setup 能从不同顺序和常见分隔符的自然语言规则验真知识空间", () => {
  const rules = [
    "space_id=fixture_private_space_id；知识空间：fixture_private_knowledge_name；适用于产品",
    "空间名称 = “fixture_private_knowledge_name”，适用于产品，space_id : \"fixture_private_space_id\"",
    "适用于产品；企业知识库='fixture_private_knowledge_name'; space_id='fixture_private_space_id'"
  ];

  for (const [index, rule] of rules.entries()) {
    const root = path.join(
      mkdtempSync(path.join(tmpdir(), `twin-knowledge-rule-${index}-`)),
      "install"
    );
    const tools = codexFixture({ lark: { wikiSpaces: [] } });
    const candidate = writeCandidate(root, tools, {
      message_scope: "bot_only",
      control: { mode: "local", enabled: true },
      allowed_lark_domains: [
        "im",
        "drive",
        "wiki",
        "docs",
        "base",
        "sheets",
        "markdown"
      ],
      authority_rules: [rule]
    });
    const launchctl = fakeStatefulLaunchctl(
      mkdtempSync(path.join(tmpdir(), `twin-knowledge-rule-${index}-launchctl-`))
    );
    const result = run([
      "--root", root,
      "--launch-agents-dir", path.join(path.dirname(root), "launch-agents"),
      "--launchctl-bin", launchctl.filename,
      "setup",
      "--config", candidate,
      "--codex-bin", tools.codexBin,
      "--codex-environment-root", tools.codexEnvironmentRoot,
      "--approve-production-data"
    ], { expected: 1 });

    assert.equal(JSON.parse(result.stderr).code, "DOCTOR_FAILED");
    assert.equal(existsSync(root), false);
    assert.match(readFileSync(tools.larkLog, "utf8"), /\bwiki \+space-list\b/u);
  }
});

test("知识规则不会把 workspace_id 误认为 space_id", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-workspace-id-rule-")), "install");
  const tools = codexFixture({ lark: { wikiSpaces: [] } });
  const candidate = writeCandidate(root, tools, {
    message_scope: "bot_only",
    control: { mode: "local", enabled: true },
    allowed_lark_domains: [
      "im",
      "drive",
      "wiki",
      "docs",
      "base",
      "sheets",
      "markdown"
    ],
    authority_rules: [
      "知识空间：fixture_private_knowledge_name；workspace_id=fixture_private_space_id"
    ]
  });
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-workspace-id-rule-launchctl-"))
  );
  const result = json(run([
    "--root", root,
    "--launch-agents-dir", path.join(path.dirname(root), "launch-agents"),
    "--launchctl-bin", launchctl.filename,
    "setup",
    "--config", candidate,
    "--codex-bin", tools.codexBin,
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ]));

  assert.equal(result.status, "setup-complete");
  assert.doesNotMatch(readFileSync(tools.larkLog, "utf8"), /\bwiki \+space-list\b/u);
});

test("setup 对控制 Base 缺少必要字段时失败并回滚", () => {
  const cases = [{
    name: "runtime",
    lark: { baseRuntimeFields: ["数字分身启用", "个性化规则"] }
  }, {
    name: "group-rules",
    lark: { baseGroupFields: ["启用", "群ID"] }
  }];

  for (const fixture of cases) {
    const root = path.join(
      mkdtempSync(path.join(tmpdir(), `twin-base-fields-${fixture.name}-`)),
      "install"
    );
    const tools = codexFixture({ lark: fixture.lark });
    const launchctl = fakeStatefulLaunchctl(
      mkdtempSync(path.join(tmpdir(), `twin-base-fields-${fixture.name}-launchctl-`))
    );
    const result = run([
      "--root", root,
      "--launch-agents-dir", path.join(path.dirname(root), "launch-agents"),
      "--launchctl-bin", launchctl.filename,
      "setup",
      "--profile", "fixture-profile",
      "--timezone", "Asia/Shanghai",
      "--console-base-token", "fixture_private_base_token",
      "--console-runtime-table", "fixture_private_runtime_table",
      "--console-group-rules-table", "fixture_private_group_rules_table",
      "--codex-environment-root", tools.codexEnvironmentRoot,
      "--approve-production-data"
    ], {
      env: { PATH: `${tools.directory}${path.delimiter}${process.env.PATH ?? ""}` },
      expected: 1
    });

    assert.equal(JSON.parse(result.stderr).code, "DOCTOR_FAILED");
    assert.equal(existsSync(root), false);
  }
});

test("setup 对已有资源参数缺项、多规则源和 --config 混用失败关闭", () => {
  const privateValue = ["fixture", "private", "resource", "value"].join("_");
  const cases = [{
    args: ["--console-base-token", privateValue],
    code: "INCOMPLETE_GUIDED_RESOURCE_GROUP",
    expected: {
      resource_group: "console",
      missing_options: ["--console-runtime-table", "--console-group-rules-table"]
    }
  }, {
    args: ["--knowledge-space-name", privateValue, "--knowledge-space-id", "fixture-space"],
    code: "INCOMPLETE_GUIDED_RESOURCE_GROUP",
    expected: {
      resource_group: "enterprise_knowledge",
      missing_options: ["--knowledge-direction"]
    }
  }, {
    args: ["--daily-memory-folder-token", privateValue],
    code: "INCOMPLETE_GUIDED_RESOURCE_GROUP",
    expected: {
      resource_group: "daily_memory",
      missing_options: ["--daily-memory-folder-name"]
    }
  }, {
    args: [
      "--config", "/tmp/fixture-private-config.json",
      "--daily-memory-folder-token", privateValue,
      "--daily-memory-folder-name", "fixture-folder"
    ],
    code: "SETUP_CONFIG_OPTION_CONFLICT",
    expected: {
      conflicting_options: [
        "--daily-memory-folder-token",
        "--daily-memory-folder-name"
      ]
    }
  }, {
    args: [
      "--console-base-token", privateValue,
      "--console-runtime-table", "fixture-runtime-table",
      "--console-group-rules-table", "fixture-group-rules-table",
      "--knowledge-space-name", "fixture-space-name",
      "--knowledge-space-id", "fixture-space-id",
      "--knowledge-direction", "fixture-direction"
    ],
    code: "BASE_RULE_SOURCE_CONFLICT",
    messagePattern: /personalized rules/u
  }];

  for (const [index, fixture] of cases.entries()) {
    const root = path.join(
      mkdtempSync(path.join(tmpdir(), `twin-guided-resource-error-${index}-`)),
      "install"
    );
    const result = run(["--root", root, "setup", ...fixture.args], { expected: 1 });
    const error = JSON.parse(result.stderr);
    assert.equal(error.code, fixture.code);
    for (const [field, value] of Object.entries(fixture.expected ?? {})) {
      assert.deepEqual(error[field], value);
    }
    if (fixture.messagePattern) assert.match(error.message, fixture.messagePattern);
    assert.equal(result.stderr.includes(privateValue), false);
    assert.equal(existsSync(root), false);
  }
});

test("setup 从声明式能力选择生成去重的最小飞书业务域", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-guided-capabilities-")), "install");
  const tools = codexFixture({ lark: { includeOk: false } });
  const launchAgents = path.join(path.dirname(root), "launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-guided-capabilities-launchctl-"))
  );
  const result = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "setup",
    "--profile", "fixture-profile",
    "--timezone", "Asia/Shanghai",
    "--capabilities", [
      "message",
      "task",
      "calendar",
      "docs",
      "base",
      "enterprise_knowledge",
      "daily_memory",
      "console"
    ].join(","),
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], {
    env: { PATH: `${tools.directory}${path.delimiter}${process.env.PATH ?? ""}` }
  }));

  assert.equal(result.status, "setup-complete");
  const privateConfig = JSON.parse(readFileSync(
    path.join(root, "private/config.json"),
    "utf8"
  ));
  assert.deepEqual(privateConfig.allowed_lark_domains, [
    "im",
    "task",
    "calendar",
    "docs",
    "drive",
    "base",
    "wiki",
    "sheets",
    "markdown"
  ]);
  assert.equal(privateConfig.allowed_lark_domains.includes("event"), false);
});

test("setup 更新能力时保留已有知识空间和每日记忆所需的官方域", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-guided-resource-domains-")), "install");
  const tools = codexFixture({ lark: { includeOk: false } });
  const launchAgents = path.join(path.dirname(root), "launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-guided-resource-domains-launchctl-"))
  );
  const commonArgs = [
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "setup"
  ];
  const environment = {
    PATH: `${tools.directory}${path.delimiter}${process.env.PATH ?? ""}`
  };

  const initial = json(run([
    ...commonArgs,
    "--profile", "fixture-profile",
    "--timezone", "Asia/Shanghai",
    "--knowledge-space-name", "fixture_private_knowledge_name",
    "--knowledge-space-id", "fixture_private_space_id",
    "--knowledge-direction", "fixture_private_direction",
    "--daily-memory-folder-token", "fixture_private_folder_token",
    "--daily-memory-folder-name", "fixture_private_folder_name",
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], { env: environment }));
  assert.equal(initial.status, "setup-complete");

  const updated = json(run([
    ...commonArgs,
    "--capabilities", "message"
  ], { env: environment }));
  assert.equal(updated.status, "setup-complete");

  const privateConfig = JSON.parse(readFileSync(
    path.join(root, "private/config.json"),
    "utf8"
  ));
  assert.deepEqual(privateConfig.allowed_lark_domains, [
    "im",
    "drive",
    "wiki",
    "docs",
    "base",
    "sheets",
    "markdown",
    "task",
    "calendar"
  ]);
});

test("setup 更新能力时保留已有控制 Base 和每日记忆所需的官方域", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-guided-console-domains-")), "install");
  const tools = codexFixture({ lark: { includeOk: false } });
  const launchAgents = path.join(path.dirname(root), "launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-guided-console-domains-launchctl-"))
  );
  const commonArgs = [
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "setup"
  ];
  const environment = {
    PATH: `${tools.directory}${path.delimiter}${process.env.PATH ?? ""}`
  };

  assert.equal(json(run([
    ...commonArgs,
    "--profile", "fixture-profile",
    "--timezone", "Asia/Shanghai",
    "--console-base-token", "fixture_private_base_token",
    "--console-runtime-table", "fixture_private_runtime_table",
    "--console-group-rules-table", "fixture_private_group_rules_table",
    "--daily-memory-folder-token", "fixture_private_folder_token",
    "--daily-memory-folder-name", "fixture_private_folder_name",
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], { env: environment })).status, "setup-complete");

  assert.equal(json(run([
    ...commonArgs,
    "--capabilities", "message"
  ], { env: environment })).status, "setup-complete");

  const privateConfig = JSON.parse(readFileSync(
    path.join(root, "private/config.json"),
    "utf8"
  ));
  assert.deepEqual(privateConfig.allowed_lark_domains, [
    "im",
    "base",
    "task",
    "calendar",
    "drive",
    "docs"
  ]);
});

test("setup 对 Base 知识规则收紧掉必要域时失败关闭", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-base-knowledge-domains-")), "install");
  const tools = codexFixture({
    lark: {
      baseRuntimeData: [[
        true,
        ["im", "base"],
        "空间名称=fixture_private_knowledge_name；space_id=fixture_private_space_id"
      ]]
    }
  });
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-base-knowledge-domains-launchctl-"))
  );
  const result = run([
    "--root", root,
    "--launch-agents-dir", path.join(path.dirname(root), "launch-agents"),
    "--launchctl-bin", launchctl.filename,
    "setup",
    "--profile", "fixture-profile",
    "--timezone", "Asia/Shanghai",
    "--capabilities", "message,console,enterprise_knowledge",
    "--console-base-token", "fixture_private_base_token",
    "--console-runtime-table", "fixture_private_runtime_table",
    "--console-group-rules-table", "fixture_private_group_rules_table",
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], {
    env: { PATH: `${tools.directory}${path.delimiter}${process.env.PATH ?? ""}` },
    expected: 1
  });

  assert.equal(JSON.parse(result.stderr).code, "DOCTOR_FAILED");
  assert.equal(existsSync(root), false);
});

test("setup 拒绝同时使用能力选择和高级域覆盖", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-guided-domain-conflict-")), "install");
  const tools = codexFixture({ lark: { includeOk: false } });
  const launchAgents = path.join(path.dirname(root), "launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-guided-domain-conflict-launchctl-"))
  );
  const blocked = run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "setup",
    "--profile", "fixture-profile",
    "--timezone", "Asia/Shanghai",
    "--capabilities", "message,task",
    "--domains", "im,task",
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], {
    env: { PATH: `${tools.directory}${path.delimiter}${process.env.PATH ?? ""}` },
    expected: 1
  });

  assert.equal(JSON.parse(blocked.stderr).code, "CAPABILITY_DOMAIN_CONFLICT");
  assert.equal(existsSync(root), false);
});

test("setup 对未知能力和非业务域返回可机读错误", () => {
  const cases = [{
    option: "--capabilities",
    value: "message,telepathy",
    code: "UNKNOWN_CAPABILITY",
    detail: "unknown_capabilities",
    expectedUnknown: ["telepathy"]
  }, {
    option: "--domains",
    value: "im,event,telepathy",
    code: "UNKNOWN_LARK_DOMAIN",
    detail: "unknown_domains",
    expectedUnknown: ["event", "telepathy"]
  }];

  for (const [index, fixture] of cases.entries()) {
    const root = path.join(
      mkdtempSync(path.join(tmpdir(), `twin-guided-unknown-${index}-`)),
      "install"
    );
    const tools = codexFixture({ lark: { includeOk: false } });
    const launchctl = fakeStatefulLaunchctl(
      mkdtempSync(path.join(tmpdir(), `twin-guided-unknown-launchctl-${index}-`))
    );
    const blocked = run([
      "--root", root,
      "--launch-agents-dir", path.join(path.dirname(root), "launch-agents"),
      "--launchctl-bin", launchctl.filename,
      "setup",
      "--profile", "fixture-profile",
      "--timezone", "Asia/Shanghai",
      fixture.option, fixture.value,
      "--codex-environment-root", tools.codexEnvironmentRoot,
      "--approve-production-data"
    ], {
      env: { PATH: `${tools.directory}${path.delimiter}${process.env.PATH ?? ""}` },
      expected: 1
    });
    const error = JSON.parse(blocked.stderr);
    assert.equal(error.code, fixture.code);
    assert.deepEqual(error[fixture.detail], fixture.expectedUnknown);
    assert.equal(existsSync(root), false);
  }
});

test("setup 未指定 profile 时自动选择唯一可用的官方 profile", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-guided-profile-")), "install");
  const tools = codexFixture({
    lark: { includeOk: false, profiles: ["only-profile"] }
  });
  const launchAgents = path.join(path.dirname(root), "launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-guided-profile-launchctl-"))
  );
  const result = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "setup",
    "--timezone", "Asia/Shanghai",
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], {
    env: { PATH: `${tools.directory}${path.delimiter}${process.env.PATH ?? ""}` }
  }));

  assert.equal(result.status, "setup-complete");
  const config = JSON.parse(readFileSync(path.join(root, "private/config.json"), "utf8"));
  assert.equal(config.profile, "only-profile");
  const larkCalls = readFileSync(tools.larkLog, "utf8");
  assert.match(larkCalls, /^profile list$/mu);
  assert.match(larkCalls, /--profile only-profile auth status --json --verify/u);
});

test("setup 遇到多个 profile 时返回选择清单且不初始化实例", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-guided-profiles-")), "install");
  const tools = codexFixture({
    lark: { profiles: ["team-a", "team-b"] }
  });
  const result = run([
    "--root", root,
    "setup",
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], {
    env: { PATH: `${tools.directory}${path.delimiter}${process.env.PATH ?? ""}` },
    expected: 1
  });
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, "LARK_PROFILE_SELECTION_REQUIRED");
  assert.deepEqual(error.available_profiles, ["team-a", "team-b"]);
  assert.equal(existsSync(root), false);
});

test("setup 引导模式扩大消息范围仍要求独立确认且不初始化", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-guided-scope-")), "install");
  const tools = codexFixture({ lark: { includeOk: false } });
  const result = run([
    "--root", root,
    "setup",
    "--profile", "fixture-profile",
    "--timezone", "Asia/Shanghai",
    "--message-scope", "internal_visible",
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], {
    env: { PATH: `${tools.directory}${path.delimiter}${process.env.PATH ?? ""}` },
    expected: 1
  });

  assert.equal(JSON.parse(result.stderr).code, "MESSAGE_SCOPE_APPROVAL_REQUIRED");
  assert.equal(existsSync(root), false);
});

test("已配置实例的引导 setup 应用配置参数且扩围前仍要求确认", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-guided-update-")), "install");
  const tools = codexFixture({ lark: { includeOk: false } });
  const launchAgents = path.join(path.dirname(root), "launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-guided-update-launchctl-"))
  );
  const common = [
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "setup"
  ];
  const initial = run([
    ...common,
    "--profile", "fixture-profile",
    "--timezone", "Asia/Shanghai",
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], {
    env: { PATH: `${tools.directory}${path.delimiter}${process.env.PATH ?? ""}` }
  });
  assert.equal(json(initial).readiness, "ready");
  const configPath = path.join(root, "private/config.json");
  const before = readFileSync(configPath, "utf8");

  const blocked = run([
    ...common,
    "--message-scope", "internal_visible"
  ], { expected: 1 });
  assert.equal(JSON.parse(blocked.stderr).code, "MESSAGE_SCOPE_APPROVAL_REQUIRED");
  assert.equal(readFileSync(configPath, "utf8"), before);

  const updated = json(run([
    ...common,
    "--message-scope", "internal_visible",
    "--domains", "im,task,contact,approval",
    "--timezone", "Asia/Tokyo",
    "--principal-name", "更新后的示例主体",
    "--approve-message-scope"
  ]));
  assert.equal(updated.readiness, "ready");
  assert.equal(updated.message_scope, "internal_visible");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(config.allowed_lark_domains, ["im", "task", "contact", "approval"]);
  assert.equal(config.principal.name, "更新后的示例主体");
  assert.equal(config.principal.timezone, "Asia/Tokyo");
  assert.equal(config.principal.open_id, "ou_fixture_discovered_principal");
});

test("setup 服务健康失败时将调用前的已有空目录恢复为空", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-setup-failure-")), "install");
  mkdirSync(root, { mode: 0o700 });
  const tools = codexFixture();
  const candidate = writeCandidate(root, tools, {
    control: { mode: "local", enabled: true }
  });
  const launchAgents = path.join(path.dirname(root), "launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-setup-failure-launchctl-")),
    { failFirstStart: "app.feishu-digital-twin.setup-failure.realtime" }
  );

  const result = run([
    "--root", root,
    "--instance", "setup-failure",
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "setup",
    "--config", candidate,
    "--codex-bin", tools.codexBin,
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data",
    "--approve-message-scope"
  ], { expected: 1 });
  assert.equal(JSON.parse(result.stderr).code, "SERVICE_START_FAILED");
  assert.equal(existsSync(root), true);
  assert.deepEqual(readdirSync(root), []);
  assert.equal(existsSync(candidate), true);
  if (existsSync(launchAgents)) {
    assert.deepEqual(
      readFileSync(launchctl.log, "utf8").includes("bootstrap"),
      true
    );
    assert.equal(
      existsSync(path.join(
        launchAgents,
        "app.feishu-digital-twin.setup-failure.realtime.plist"
      )),
      false
    );
  }
});

test("setup 最终状态退化时不报告完成并恢复调用前状态", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-final-degraded-")), "install");
  const tools = codexFixture({ lark: { baseFailAfter: 2 } });
  const launchAgents = path.join(path.dirname(root), "launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-final-degraded-launchctl-"))
  );
  const result = run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "setup",
    "--profile", "fixture-profile",
    "--timezone", "Asia/Shanghai",
    "--console-base-token", "fixture_private_base_token",
    "--console-runtime-table", "fixture_private_runtime_table",
    "--console-group-rules-table", "fixture_private_group_rules_table",
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], {
    env: { PATH: tools.directory + path.delimiter + (process.env.PATH ?? "") },
    expected: 1
  });

  assert.equal(JSON.parse(result.stderr).code, "SETUP_FINAL_STATUS_DEGRADED");
  assert.equal(result.stdout.includes("setup-complete"), false);
  assert.equal(existsSync(root), false);
  if (existsSync(launchAgents)) assert.deepEqual(readdirSync(launchAgents), []);
});

test("setup 更新失败时恢复原配置、冻结状态和服务集合", () => {
  const { root } = initRoot("setup-rollback");
  const tools = codexFixture();
  configureRoot(root, tools, {
    overrides: {
      control: { mode: "local", enabled: true },
      message_scope: "bot_only"
    }
  });
  const launchAgents = path.join(root, "fake-launch-agents");
  const initialLaunchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-setup-original-launchctl-"))
  );
  json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", initialLaunchctl.filename,
    "service", "install"
  ]));
  json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", initialLaunchctl.filename,
    "resume"
  ]));

  const configPath = path.join(root, "private/config.json");
  const originalConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const candidate = path.join(path.dirname(root), "setup-rollback-candidate.json");
  const changed = structuredClone(originalConfig);
  changed.message_scope = "internal_visible";
  changed.principal.timezone = "Asia/Tokyo";
  writeFileSync(candidate, `${JSON.stringify(changed, null, 2)}\n`, { mode: 0o600 });
  const installation = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  const recoveryLaunchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-setup-recovery-launchctl-")),
    {
      initiallyLoaded: Object.values(installation.services),
      failFirstStart: installation.services.realtime
    }
  );

  const failed = run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", recoveryLaunchctl.filename,
    "setup",
    "--config", candidate,
    "--codex-bin", tools.codexBin,
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data",
    "--approve-message-scope"
  ], { expected: 1 });
  assert.equal(JSON.parse(failed.stderr).code, "SERVICE_START_FAILED");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), originalConfig);

  const restored = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", recoveryLaunchctl.filename,
    "status"
  ]));
  assert.equal(restored.frozen, false);
  assert.equal(restored.readiness, "ready");
  assert.equal(restored.message_scope, "bot_only");
  assert.equal(restored.service.healthy, true);
  assert.equal(existsSync(candidate), true);
});

test("setup 拒绝不可访问的每日记忆目录并恢复原运行状态", () => {
  const { root } = initRoot("setup-invalid-daily-memory");
  const tools = codexFixture({ lark: { driveListExitCode: 1 } });
  configureRoot(root, tools, {
    overrides: {
      control: { mode: "local", enabled: true },
      message_scope: "bot_only"
    }
  });
  const launchAgents = path.join(root, "fake-launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-invalid-memory-launchctl-"))
  );
  const serviceOptions = [
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename
  ];
  json(run([...serviceOptions, "service", "install"]));
  json(run([...serviceOptions, "resume"]));

  const configPath = path.join(root, "private/config.json");
  const originalConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const candidatePath = path.join(path.dirname(root), "invalid-daily-memory.json");
  const candidate = structuredClone(originalConfig);
  candidate.allowed_lark_domains = ["im", "task", "calendar", "drive", "docs"];
  candidate.daily_memory = {
    folder_token: "fixture_invalid_daily_memory_folder",
    folder_name: "不可访问的每日记忆目录",
    excluded_chat_ids: [],
    excluded_topics: []
  };
  writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });

  const failed = run([
    ...serviceOptions,
    "setup",
    "--config", candidatePath,
    "--codex-bin", tools.codexBin,
    "--codex-environment-root", tools.codexEnvironmentRoot,
    "--approve-production-data"
  ], { expected: 1 });
  assert.equal(JSON.parse(failed.stderr).code, "DOCTOR_FAILED");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), originalConfig);

  const restored = json(run([...serviceOptions, "status"]));
  assert.equal(restored.frozen, false);
  assert.equal(restored.readiness, "ready");
  assert.equal(restored.message_scope, "bot_only");
  assert.equal(restored.service.healthy, true);
  const larkCalls = readFileSync(tools.larkLog, "utf8");
  assert.match(larkCalls, /\bdrive files list\b/u);
  assert.match(larkCalls, /--params \{"folder_token":"fixture_invalid_daily_memory_folder","page_size":1\}/u);
});

test("config update 只在冻结和服务停止时原子更新业务配置", () => {
  const { root } = initRoot("config-update");
  const tools = codexFixture();
  configureRoot(root, tools);
  const configPath = path.join(root, "private/config.json");
  const installationPath = path.join(root, "installation.json");
  const originalConfig = readFileSync(configPath, "utf8");
  const originalInstallation = readFileSync(installationPath, "utf8");
  const candidate = JSON.parse(originalConfig);
  candidate.principal.timezone = "Asia/Tokyo";
  candidate.schedule.daily_memory_hour = 6;
  candidate.schedule.daily_memory_minute = 40;
  candidate.authority_rules = ["使用新的自然语言授权规则。"];
  const candidatePath = path.join(path.dirname(root), "config-update.json");
  writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
  chmodSync(candidatePath, 0o600);
  const launchAgents = path.join(root, "fake-launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-config-update-launchctl-"))
  );
  const serviceOptions = [
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename
  ];
  json(run([...serviceOptions, "service", "install"]));

  json(run([...serviceOptions, "resume"]));
  const running = run([
    ...serviceOptions,
    "config", "update",
    "--config", candidatePath
  ], { expected: 1 });
  assert.equal(JSON.parse(running.stderr).code, "CONFIG_UPDATE_REQUIRES_FREEZE");
  assert.equal(readFileSync(configPath, "utf8"), originalConfig);

  json(run(["--root", root, "freeze"]));
  json(run([...serviceOptions, "service", "stop"]));
  writeFileSync(path.join(tools.codexEnvironmentRoot, "codex-home/config.toml"), [
    'model = "codex-config-is-managed-outside-this-project"',
    ""
  ].join("\n"), { mode: 0o600 });
  const updated = json(run([
    ...serviceOptions,
    "config", "update",
    "--config", candidatePath
  ]));
  assert.equal(updated.status, "updated");
  assert.equal(updated.frozen, true);
  const active = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(active.principal.timezone, "Asia/Tokyo");
  assert.equal(active.schedule.daily_memory_hour, 6);
  assert.equal(active.schedule.daily_memory_minute, 40);
  assert.deepEqual(active.authority_rules, ["使用新的自然语言授权规则。"]);
  assert.equal(readFileSync(installationPath, "utf8"), originalInstallation);

  const codexEnvironmentChange = {
    ...active,
    codex_environment_root: path.join(path.dirname(tools.codexEnvironmentRoot), "other-codex")
  };
  writeFileSync(candidatePath, `${JSON.stringify(codexEnvironmentChange, null, 2)}\n`, { mode: 0o600 });
  const blocked = run([
    ...serviceOptions,
    "config", "update",
    "--config", candidatePath
  ], { expected: 1 });
  assert.equal(
    JSON.parse(blocked.stderr).code,
    "CODEX_ENVIRONMENT_CHANGE_REQUIRES_NEW_INSTANCE"
  );
  assert.match(
    JSON.parse(blocked.stderr).message,
    /executable.*environment root.*new instance.*model.*endpoint.*Codex/iu
  );
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), active);
});

test("config update 同级或收窄无需确认，扩大范围必须独立确认", () => {
  const { root } = initRoot("scope-update");
  const tools = codexFixture();
  configureRoot(root, tools, { overrides: { message_scope: "all_visible" } });
  const configPath = path.join(root, "private/config.json");
  const candidatePath = path.join(path.dirname(root), "scope-update.json");
  const updateScope = (messageScope, { approved = false, expected = 0 } = {}) => {
    const candidate = JSON.parse(readFileSync(configPath, "utf8"));
    candidate.message_scope = messageScope;
    writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
    const args = [
      "--root", root,
      "config", "update",
      "--config", candidatePath
    ];
    if (approved) args.push("--approve-message-scope");
    return run(args, { expected });
  };

  assert.equal(json(updateScope("internal_visible")).status, "updated");
  assert.equal(json(updateScope("internal_visible")).status, "updated");
  assert.equal(json(updateScope("bot_only")).status, "updated");

  const internalBlocked = updateScope("internal_visible", { expected: 1 });
  assert.equal(JSON.parse(internalBlocked.stderr).code, "MESSAGE_SCOPE_APPROVAL_REQUIRED");
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).message_scope, "bot_only");
  assert.equal(json(updateScope("internal_visible", { approved: true })).status, "updated");

  const allBlocked = updateScope("all_visible", { expected: 1 });
  assert.equal(JSON.parse(allBlocked.stderr).code, "MESSAGE_SCOPE_APPROVAL_REQUIRED");
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).message_scope, "internal_visible");
  assert.equal(json(updateScope("all_visible", { approved: true })).status, "updated");
});

test("config update 在冻结但服务仍加载时要求先停止服务", () => {
  const { root } = initRoot("config-update-loaded");
  configureRoot(root, codexFixture());
  const launchAgents = path.join(root, "fake-launch-agents");
  json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "service", "install", "--no-start"
  ]));
  const installation = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-config-update-loaded-")),
    { initiallyLoaded: [installation.services.realtime] }
  );
  const current = JSON.parse(readFileSync(path.join(root, "private/config.json"), "utf8"));
  current.schedule.daily_memory_minute = 41;
  const candidatePath = path.join(path.dirname(root), "config-update-loaded.json");
  writeFileSync(candidatePath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });

  const blocked = run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "config", "update",
    "--config", candidatePath
  ], { expected: 1 });
  const error = JSON.parse(blocked.stderr);
  assert.equal(error.code, "CONFIG_UPDATE_REQUIRES_SERVICES_STOPPED");
  assert.match(error.message, /freeze.*service stop.*config update.*service start/iu);
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "private/config.json"), "utf8")).schedule
      .daily_memory_minute,
    25
  );
});

test("Codex 内部配置由 Codex 自己管理，项目不读取或指纹化", () => {
  const { root } = initRoot("codex-owned-config");
  const tools = codexFixture();
  configureRoot(root, tools);
  writeFileSync(path.join(tools.codexEnvironmentRoot, "codex-home/config.toml"), [
    'model = "changed-model"',
    ""
  ].join("\n"), { mode: 0o600 });

  const result = json(run(["--root", root, "doctor"]));
  assert.equal(result.healthy, true);
  assert.equal(result.ready_for_service, true);
  assert.equal(result.checks.codex_runtime.status, "pass");
  assert.equal(result.checks.inference.status, "pass");
  assert.equal(JSON.stringify(result).includes("changed-model"), false);
  assert.equal(JSON.stringify(result).includes(tools.codexEnvironmentRoot), false);
  assert.equal(existsSync(path.join(root, "private/providers")), false);
});

test("未批准生产数据时不能安装服务或解除冻结", () => {
  const { root } = initRoot("unapproved");
  const tools = codexFixture();
  configureRoot(root, tools, { approved: false });
  const result = json(run(["--root", root, "doctor"], { expected: 1 }));
  assert.equal(result.checks.production_data.status, "fail");
  assert.equal(result.checks.production_data.code, "PRODUCTION_DATA_NOT_APPROVED");

  const launchAgents = path.join(root, "fake-launch-agents");
  const launchctl = fakeLaunchctl(mkdtempSync(path.join(tmpdir(), "twin-unapproved-launchctl-")));
  const install = run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "service", "install", "--no-start",
    "--launchctl-bin", launchctl.filename
  ], { expected: 1 });
  assert.equal(JSON.parse(install.stderr).code, "DOCTOR_FAILED");
  assert.equal(existsSync(launchAgents), false);
  assert.equal(existsSync(launchctl.log), false);

  const resume = run(["--root", root, "resume"], { expected: 1 });
  assert.equal(JSON.parse(resume.stderr).code, "DOCTOR_FAILED");
  assert.equal(json(run(["--root", root, "status"])).frozen, true);
});

test("中性 launchd 模板可安装、检查和卸载而不加载真实服务", () => {
  const { root } = initRoot("sample");
  configureRoot(root, codexFixture());
  const launchAgents = path.join(root, "fake-launch-agents");
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-launchctl-"))
  );
  const installed = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "service", "install", "--no-start"
  ]));
  assert.equal(installed.status, "installed");
  assert.equal(installed.started, false);

  const plistFiles = ["realtime", "supplement", "daily-memory"].map((suffix) => (
    path.join(launchAgents, `app.feishu-digital-twin.sample.${suffix}.plist`)
  ));
  for (const filename of plistFiles) {
    const content = readFileSync(filename, "utf8");
    assert.doesNotMatch(
      content,
      /legacy\.private\.service|Private Example Person|private-provider\.example|private\/workspace/u
    );
    assert.match(content, /launcher\.mjs/u);
    assert.doesNotMatch(content, /<key>TZ<\/key>/u);
  }
  const dailyMemoryPlist = readFileSync(plistFiles[2], "utf8");
  assert.doesNotMatch(dailyMemoryPlist, /StartCalendarInterval/u);
  assert.match(
    dailyMemoryPlist,
    /<key>StartInterval<\/key>\s*<integer>60<\/integer>/u
  );

  const started = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "service", "start",
    "--launchctl-bin", launchctl.filename
  ]));
  assert.equal(started.status, "started");
  assert.match(readFileSync(launchctl.log, "utf8"), /bootstrap/u);

  const unloadedLaunchctl = fakeLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-unloaded-launchctl-"))
  );
  const status = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "service", "status",
    "--launchctl-bin", unloadedLaunchctl.filename
  ]));
  assert.equal(status.installed, true);
  assert.equal(status.loaded, false);

  const removed = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "service", "uninstall",
    "--launchctl-bin", launchctl.filename
  ]));
  assert.equal(removed.status, "uninstalled");
  for (const filename of plistFiles) assert.equal(existsSync(filename), false);
});

test("service status 在 launchctl 查询失败时失败关闭", () => {
  const { root } = initRoot("launchctl-query-failure");
  configureRoot(root, codexFixture());
  const launchAgents = path.join(root, "fake-launch-agents");
  json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "service", "install", "--no-start"
  ]));

  const failed = run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "service", "status",
    "--launchctl-bin", path.join(root, "missing-launchctl")
  ], { expected: 1 });

  assert.equal(JSON.parse(failed.stderr).code, "SERVICE_STATUS_FAILED");
});

test("daily-memory 按主体时区补跑、失败重试且成功后每日只执行一次", async () => {
  const { root } = initRoot("daily-schedule");
  configureRoot(root, codexFixture(), {
    overrides: {
      daily_memory: {
        folder_token: "fixture_daily_memory_folder",
        folder_name: "合成每日工作记忆"
      }
    }
  });
  const attempts = [];
  const results = [7, 0, 0];
  const dailyMemoryRunner = async ({ targetDate }) => {
    attempts.push(targetDate);
    return results.shift();
  };

  assert.equal(await runServiceRole(root, "daily_memory", {
    now: new Date("2026-07-24T08:24:00.000Z"),
    dailyMemoryRunner
  }), 0);
  assert.deepEqual(attempts, []);

  assert.equal(await runServiceRole(root, "daily_memory", {
    now: new Date("2026-07-24T15:00:00.000Z"),
    dailyMemoryRunner
  }), 7);
  assert.deepEqual(attempts, ["2026-07-23"]);

  assert.equal(await runServiceRole(root, "daily_memory", {
    now: new Date("2026-07-24T15:01:00.000Z"),
    dailyMemoryRunner
  }), 0);
  assert.deepEqual(attempts, ["2026-07-23", "2026-07-23"]);

  assert.equal(await runServiceRole(root, "daily_memory", {
    now: new Date("2026-07-24T23:59:00.000Z"),
    dailyMemoryRunner
  }), 0);
  assert.deepEqual(attempts, ["2026-07-23", "2026-07-23"]);

  assert.equal(await runServiceRole(root, "daily_memory", {
    now: new Date("2026-07-25T15:00:00.000Z"),
    dailyMemoryRunner
  }), 0);
  assert.deepEqual(attempts, ["2026-07-23", "2026-07-23", "2026-07-24"]);
});

test("supplement 按可选 ISO 工作日集合选择工作与非工作间隔", async () => {
  const configureSchedule = (instance, workdays) => {
    const { root } = initRoot(instance);
    const schedule = {
      workday_start_hour: 8,
      workday_end_hour: 17,
      work_interval_seconds: 45,
      quiet_interval_seconds: 420,
      daily_memory_hour: 1,
      daily_memory_minute: 25
    };
    if (workdays !== undefined) schedule.workdays = workdays;
    configureRoot(root, codexFixture(), { overrides: { schedule } });
    return root;
  };
  const markerAt = (root, value) => writeFileSync(
    path.join(root, "private/supplement-schedule.json"),
    `${JSON.stringify({ supplement_last_started_at: value.toISOString() })}\n`,
    { mode: 0o600 }
  );
  const friday = new Date("2026-07-24T16:00:00.000Z");
  const saturday = new Date("2026-07-25T16:00:00.000Z");

  const legacyRoot = configureSchedule("legacy-workdays");
  let legacyRuns = 0;
  const legacyRunner = async () => { legacyRuns += 1; return 0; };
  markerAt(legacyRoot, new Date(friday.getTime() - 100_000));
  assert.equal(await runServiceRole(legacyRoot, "supplement", {
    now: friday,
    supplementRunner: legacyRunner
  }), 0);
  assert.equal(legacyRuns, 1);
  markerAt(legacyRoot, new Date(saturday.getTime() - 100_000));
  assert.equal(await runServiceRole(legacyRoot, "supplement", {
    now: saturday,
    supplementRunner: legacyRunner
  }), 0);
  assert.equal(legacyRuns, 1);

  const saturdayRoot = configureSchedule("saturday-workday", [6]);
  let saturdayRuns = 0;
  const saturdayRunner = async () => { saturdayRuns += 1; return 0; };
  markerAt(saturdayRoot, new Date(friday.getTime() - 100_000));
  assert.equal(await runServiceRole(saturdayRoot, "supplement", {
    now: friday,
    supplementRunner: saturdayRunner
  }), 0);
  assert.equal(saturdayRuns, 0);
  markerAt(saturdayRoot, new Date(saturday.getTime() - 100_000));
  assert.equal(await runServiceRole(saturdayRoot, "supplement", {
    now: saturday,
    supplementRunner: saturdayRunner
  }), 0);
  assert.equal(saturdayRuns, 1);
});

test("后台业务结果日志使用配置中的更短隐私上限", async () => {
  const { root } = initRoot("result-log-privacy");
  const tools = codexFixture();
  configureRoot(root, tools, {
    overrides: {
      privacy: {
        result_log_retention_days: 2,
        result_log_max_bytes: 1048576,
        signal_log_retention_days: 1,
        signal_log_max_bytes: 131072
      },
      daily_memory: {
        folder_token: "fixture_daily_memory_folder",
        folder_name: "合成每日工作记忆"
      }
    }
  });
  let policy;
  assert.equal(await runServiceRole(root, "daily_memory", {
    now: new Date("2026-07-24T09:00:00.000Z"),
    dailyMemoryRunner: async (options) => {
      policy = options.logPolicy;
      return 0;
    }
  }), 0);
  assert.deepEqual(policy, {
    maxBytes: 1048576,
    maxAgeSeconds: 172800
  });
});

test("upgrade 原子切换版本，rollback 恢复上一版本", () => {
  const { root } = initRoot();
  const source = versionedSource("0.2.0");

  const upgraded = json(run(["--root", root, "upgrade", "--source", source]));
  assert.equal(upgraded.status, "upgraded");
  assert.equal(upgraded.active_version, "0.2.0");
  assert.equal(upgraded.previous_version, CURRENT_VERSION);
  assert.ok(existsSync(path.join(root, "versions/0.2.0/bin/feishu-digital-twin.mjs")));

  const rolledBack = json(run(["--root", root, "rollback"]));
  assert.equal(rolledBack.status, "rolled-back");
  assert.equal(rolledBack.active_version, CURRENT_VERSION);
  assert.equal(rolledBack.previous_version, "0.2.0");
});

test("upgrade 不会跨不可回退的状态格式边界", () => {
  const { root } = initRoot("state-format");
  const blocked = run([
    "--root", root,
    "upgrade",
    "--source", versionedSource("0.2.0", { stateFormat: 2 })
  ], { expected: 1 });
  assert.equal(JSON.parse(blocked.stderr).code, "INCOMPATIBLE_STATE_FORMAT");
  const installation = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  assert.equal(installation.active_version, CURRENT_VERSION);
  assert.equal(installation.state_format, 1);
});

test("安装和升级都拒绝 npm 与 Codex 插件版本不一致的发行源", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-version-mismatch-")), "install");
  const mismatched = versionedSource("0.2.0", { pluginVersion: "0.1.0" });

  const install = run([
    "--root", root,
    "init",
    "--source", mismatched
  ], { expected: 1 });
  assert.equal(JSON.parse(install.stderr).code, "INVALID_PACKAGE");
  assert.equal(existsSync(path.join(root, "installation.json")), false);

  const initialized = initRoot("version-mismatch-upgrade");
  const upgrade = run([
    "--root", initialized.root,
    "upgrade",
    "--source", mismatched
  ], { expected: 1 });
  assert.equal(JSON.parse(upgrade.stderr).code, "INVALID_PACKAGE");
  assert.equal(
    JSON.parse(readFileSync(path.join(initialized.root, "installation.json"), "utf8"))
      .active_version,
    CURRENT_VERSION
  );
});

test("运行中的后台服务不能在无 restart 时形成混合版本", () => {
  const { root } = initRoot("atomic-version");
  configureRoot(root, codexFixture());
  const launchAgents = path.join(root, "fake-launch-agents");
  json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "service", "install", "--no-start"
  ]));
  const launchctl = fakeLoadedLaunchctl(mkdtempSync(path.join(tmpdir(), "twin-loaded-launchctl-")));
  const blocked = run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl,
    "upgrade",
    "--source", versionedSource("0.2.0")
  ], { expected: 1 });
  assert.equal(JSON.parse(blocked.stderr).code, "RESTART_REQUIRED");
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8")).active_version,
    CURRENT_VERSION
  );
});

test("upgrade 和 rollback restart 只恢复原先加载的服务并逐个检查启动状态", () => {
  const { root } = initRoot("selective-restart");
  configureRoot(root, codexFixture());
  const launchAgents = path.join(root, "fake-launch-agents");
  json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "service", "install", "--no-start"
  ]));
  const installation = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  const loadedLabels = [
    installation.services.realtime,
    installation.services.daily_memory
  ];
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-selective-launchctl-")),
    { initiallyLoaded: loadedLabels }
  );

  const installedCli = path.join(root, `versions/${CURRENT_VERSION}/product/src/cli.mjs`);
  const installedCliBefore = readFileSync(installedCli, "utf8");
  const sameVersionSource = versionedSource(CURRENT_VERSION);
  const sameVersionCli = path.join(sameVersionSource, "product/src/cli.mjs");
  writeFileSync(
    sameVersionCli,
    `${readFileSync(sameVersionCli, "utf8")}\n// synthetic replacement must not install\n`
  );
  const unchanged = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "control", "upgrade",
    "--source", sameVersionSource,
    "--restart"
  ]));
  assert.equal(unchanged.status, "unchanged");
  assert.equal(readFileSync(installedCli, "utf8"), installedCliBefore);

  const restartRequired = run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "control", "upgrade",
    "--source", versionedSource("0.2.0")
  ], { expected: 1 });
  assert.equal(JSON.parse(restartRequired.stderr).code, "RESTART_REQUIRED");

  const upgraded = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "control", "upgrade",
    "--source", versionedSource("0.2.0"),
    "--restart"
  ]));
  assert.equal(upgraded.active_version, "0.2.0");
  assert.equal(upgraded.services_restarted, true);

  const commands = readFileSync(launchctl.log, "utf8").trim().split("\n");
  const labelsFor = (command) => commands
    .filter((line) => line.startsWith(command + " "))
    .map((line) => path.basename(
      line.split(" ").at(-1),
      command === "bootstrap" ? ".plist" : ""
    ));
  assert.deepEqual(labelsFor("bootout"), loadedLabels);
  assert.deepEqual(labelsFor("bootstrap"), loadedLabels);
  assert.deepEqual(
    commands
      .filter((line) => line.startsWith("bootout ") || line.startsWith("bootstrap "))
      .map((line) => {
        const [command] = line.split(" ");
        return command + ":" + path.basename(
          line.split(" ").at(-1),
          command === "bootstrap" ? ".plist" : ""
        );
      }),
    [
      "bootout:" + loadedLabels[0],
      "bootstrap:" + loadedLabels[0],
      "bootout:" + loadedLabels[1],
      "bootstrap:" + loadedLabels[1]
    ]
  );
  assert.equal(commands.some((line) => line.includes(installation.services.supplement)), true);
  assert.equal(
    commands.some((line) => line.startsWith("bootstrap ") &&
      line.includes(installation.services.supplement)),
    false
  );
  for (const label of loadedLabels) {
    const bootstrapIndex = commands.findIndex((line) => (
      line.startsWith("bootstrap ") && line.endsWith(label + ".plist")
    ));
    const nextBootstrap = commands.findIndex((line, index) => (
      index > bootstrapIndex && line.startsWith("bootstrap ")
    ));
    const checks = commands.slice(
      bootstrapIndex + 1,
      nextBootstrap === -1 ? commands.length : nextBootstrap
    );
    assert.equal(
      checks.some((line) => line.startsWith("print ") && line.endsWith("/" + label)),
      true
    );
  }

  rmSync(launchctl.log, { force: true });
  const rollbackRestartRequired = run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "control", "rollback"
  ], { expected: 1 });
  assert.equal(JSON.parse(rollbackRestartRequired.stderr).code, "RESTART_REQUIRED");

  const rolledBack = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "control", "rollback",
    "--restart"
  ]));
  assert.equal(rolledBack.active_version, CURRENT_VERSION);
  assert.deepEqual(
    readFileSync(launchctl.log, "utf8").trim().split("\n")
      .filter((line) => line.startsWith("bootout ") || line.startsWith("bootstrap "))
      .map((line) => {
        const [command] = line.split(" ");
        return command + ":" + path.basename(
          line.split(" ").at(-1),
          command === "bootstrap" ? ".plist" : ""
        );
      }),
    [
      "bootout:" + loadedLabels[0],
      "bootstrap:" + loadedLabels[0],
      "bootout:" + loadedLabels[1],
      "bootstrap:" + loadedLabels[1]
    ]
  );
});

test("版本切换等待 launchd 完成卸载后再启动同一实时服务", () => {
  const { root } = initRoot("delayed-realtime-bootout");
  configureRoot(root, codexFixture());
  const launchAgents = path.join(root, "fake-launch-agents");
  json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "service", "install", "--no-start"
  ]));
  const installation = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  const realtime = installation.services.realtime;
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-delayed-bootout-launchctl-")),
    { initiallyLoaded: [realtime], delayedBootout: [realtime] }
  );

  const upgraded = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "control", "upgrade",
    "--source", versionedSource("0.2.0"),
    "--restart"
  ]));
  const status = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "service", "status"
  ]));

  assert.equal(upgraded.services_restarted, true);
  assert.equal(status.services.realtime.loaded, true);
  assert.equal(status.services.realtime.running, true);
  assert.equal(status.services.realtime.healthy, true);
  const transitions = readFileSync(launchctl.log, "utf8").trim().split("\n")
    .filter((line) => (
      line.includes(realtime) &&
      (line.startsWith("bootout ") || line.startsWith("bootstrap "))
    ))
    .map((line) => line.split(" ")[0]);
  assert.deepEqual(transitions, ["bootout", "bootstrap"]);

  rmSync(launchctl.log, { force: true });
  const rolledBack = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "control", "rollback",
    "--restart"
  ]));
  const rollbackStatus = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "service", "status"
  ]));

  assert.equal(rolledBack.active_version, CURRENT_VERSION);
  assert.equal(rolledBack.services_restarted, true);
  assert.equal(rollbackStatus.services.realtime.loaded, true);
  assert.equal(rollbackStatus.services.realtime.running, true);
  assert.equal(rollbackStatus.services.realtime.healthy, true);
  const rollbackTransitions = readFileSync(launchctl.log, "utf8").trim().split("\n")
    .filter((line) => (
      line.includes(realtime) &&
      (line.startsWith("bootout ") || line.startsWith("bootstrap "))
    ))
    .map((line) => line.split(" ")[0]);
  assert.deepEqual(rollbackTransitions, ["bootout", "bootstrap"]);
});

test("upgrade restart 检测到服务立即退出时恢复旧版本和原加载集合", () => {
  const { root } = initRoot("failed-restart");
  configureRoot(root, codexFixture());
  const launchAgents = path.join(root, "fake-launch-agents");
  json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "service", "install", "--no-start"
  ]));
  const installation = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  const realtime = installation.services.realtime;
  const dailyMemory = installation.services.daily_memory;
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-failed-launchctl-")),
    { initiallyLoaded: [realtime, dailyMemory], failFirstStart: realtime }
  );

  const failed = run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "upgrade",
    "--source", versionedSource("0.2.0"),
    "--restart"
  ], { expected: 1 });
  assert.equal(JSON.parse(failed.stderr).code, "UPGRADE_ROLLED_BACK");
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8")).active_version,
    CURRENT_VERSION
  );

  const status = json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "service", "status"
  ]));
  assert.equal(status.services.realtime.loaded, true);
  assert.equal(status.services.realtime.last_exit_ok, true);
  assert.equal(status.services.supplement.loaded, false);
  assert.equal(status.services.daily_memory.loaded, true);
  const transitionLines = readFileSync(launchctl.log, "utf8").trim().split("\n")
    .filter((line) => line.startsWith("bootstrap ") || line.startsWith("bootout "));
  const bootstrapped = transitionLines
    .filter((line) => line.startsWith("bootstrap "))
    .map((line) => path.basename(line.split(" ").at(-1), ".plist"));
  assert.deepEqual(bootstrapped, [realtime, realtime]);
  assert.equal(transitionLines.some((line) => line.includes(dailyMemory)), false);
});

test("upgrade 回退后的服务再次消失时不声称自动恢复成功", () => {
  const { root } = initRoot("failed-recovery-health");
  configureRoot(root, codexFixture());
  const launchAgents = path.join(root, "fake-launch-agents");
  json(run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "service", "install", "--no-start"
  ]));
  const installation = JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8"));
  const realtime = installation.services.realtime;
  const launchctl = fakeStatefulLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-failed-recovery-launchctl-")),
    {
      initiallyLoaded: [realtime],
      failFirstStart: realtime,
      disappearAfterRecoveryStart: realtime
    }
  );

  const failed = run([
    "--root", root,
    "--launch-agents-dir", launchAgents,
    "--launchctl-bin", launchctl.filename,
    "upgrade",
    "--source", versionedSource("0.2.0"),
    "--restart"
  ], { expected: 1 });

  assert.equal(JSON.parse(failed.stderr).code, "VERSION_RECOVERY_FAILED");
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8")).active_version,
    CURRENT_VERSION
  );
});

test("upgrade 和 rollback 带 restart 时先用目标版本 Doctor，失败不停止服务", () => {
  const { root } = initRoot("version-doctor");
  configureRoot(root, codexFixture());
  const launchctl = fakeLaunchctl(mkdtempSync(path.join(tmpdir(), "twin-version-launchctl-")));
  const failedUpgrade = run([
    "--root", root,
    "upgrade",
    "--source", versionedSource("0.2.0", { doctorReady: false }),
    "--restart",
    "--launchctl-bin", launchctl.filename
  ], { expected: 1 });
  assert.equal(JSON.parse(failedUpgrade.stderr).code, "UPGRADE_ROLLED_BACK");
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8")).active_version,
    CURRENT_VERSION
  );
  assert.doesNotMatch(readFileSync(launchctl.log, "utf8"), /bootstrap|bootout/u);

  rmSync(launchctl.log, { force: true });
  const upgraded = json(run([
    "--root", root,
    "upgrade",
    "--source", versionedSource("0.3.0")
  ]));
  assert.equal(upgraded.active_version, "0.3.0");
  forceDoctorFailure(path.join(root, `versions/${CURRENT_VERSION}/product/src/cli.mjs`));

  const failedRollback = run([
    "--root", root,
    "rollback",
    "--restart",
    "--launchctl-bin", launchctl.filename
  ], { expected: 1 });
  assert.equal(JSON.parse(failedRollback.stderr).code, "ROLLBACK_ABORTED");
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8")).active_version,
    "0.3.0"
  );
  assert.doesNotMatch(readFileSync(launchctl.log, "utf8"), /bootstrap|bootout/u);
});

test("已配置实例即使没有加载服务也先通过目标版本 Doctor 再升级", () => {
  const { root } = initRoot("version-doctor-no-services");
  configureRoot(root, codexFixture());
  const failed = run([
    "--root", root,
    "upgrade",
    "--source", versionedSource("0.2.0", { doctorReady: false })
  ], { expected: 1 });
  assert.equal(JSON.parse(failed.stderr).code, "UPGRADE_ROLLED_BACK");
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8")).active_version,
    CURRENT_VERSION
  );
});

test("npm tarball 解包后可通过安装启动器完成 Doctor、升级回退和卸载", {
  skip: process.env.TWIN_TEST_MODE === "1"
    ? "npm is intentionally unavailable inside the isolated runtime test PATH"
    : false
}, () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "twin-product-tarball-"));
  const cache = path.join(workspace, "npm-cache");
  try {
    const packed = spawnSync("npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      workspace
    ], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_cache: cache,
        npm_config_fund: "false",
        npm_config_update_notifier: "false"
      }
    });
    assert.equal(packed.status, 0, packed.stderr || packed.error?.message);
    const archive = path.join(workspace, JSON.parse(packed.stdout)[0].filename);
    const extracted = spawnSync("tar", ["-xzf", archive, "-C", workspace], {
      encoding: "utf8"
    });
    assert.equal(extracted.status, 0, extracted.stderr || extracted.error?.message);

    const packageRoot = path.join(workspace, "package");
    const packagedCli = path.join(packageRoot, "bin/feishu-digital-twin.mjs");
    const root = path.join(workspace, "install");
    const instance = `package-${process.pid}-${++syntheticInstanceSequence}`;
    const installed = json(runCli(packagedCli, [
      "--root", root,
      "init",
      "--instance", instance,
      "--source", packageRoot
    ]));
    assert.equal(installed.status, "initialized");
    assert.ok(existsSync(path.join(root, `versions/${CURRENT_VERSION}/.codex-plugin/plugin.json`)));
    assert.ok(existsSync(path.join(
      root,
      `versions/${CURRENT_VERSION}/runtime/bin/feishu-digital-twin-runtime.mjs`
    )));

    const launcher = path.join(root, "launcher.mjs");
    const tools = codexFixture();
    const candidate = writeCandidate(root, tools);
    const configured = json(runCli(launcher, [
      "configure",
      "--config", candidate,
      "--codex-bin", tools.codexBin,
      "--codex-environment-root", tools.codexEnvironmentRoot,
      "--approve-production-data",
      "--approve-message-scope"
    ]));
    assert.equal(configured.status, "configured");
    assert.equal(json(runCli(launcher, ["doctor"])).healthy, true);

    const upgradeSource = path.join(workspace, "package-0.2.0");
    cpSync(packageRoot, upgradeSource, { recursive: true });
    const upgradeManifestPath = path.join(upgradeSource, "package.json");
    const upgradeManifest = JSON.parse(readFileSync(upgradeManifestPath, "utf8"));
    upgradeManifest.version = "0.2.0";
    writeFileSync(upgradeManifestPath, `${JSON.stringify(upgradeManifest, null, 2)}\n`);
    const upgradePluginManifestPath = path.join(upgradeSource, ".codex-plugin/plugin.json");
    const upgradePluginManifest = JSON.parse(readFileSync(
      upgradePluginManifestPath,
      "utf8"
    ));
    upgradePluginManifest.version = "0.2.0";
    writeFileSync(
      upgradePluginManifestPath,
      `${JSON.stringify(upgradePluginManifest, null, 2)}\n`
    );

    const upgraded = json(runCli(launcher, ["upgrade", "--source", upgradeSource]));
    assert.equal(upgraded.active_version, "0.2.0");
    assert.equal(json(runCli(launcher, ["rollback"])).active_version, CURRENT_VERSION);

    const marker = path.join(root, "private/keep-after-package-uninstall.txt");
    writeFileSync(marker, "private\n", { mode: 0o600 });
    const uninstallLaunchctl = fakeLaunchctl(
      mkdtempSync(path.join(tmpdir(), "twin-package-uninstall-launchctl-"))
    );
    const removed = json(runCli(launcher, [
      "--launch-agents-dir", path.join(root, "fake-launch-agents"),
      "--launchctl-bin", uninstallLaunchctl.filename,
      "uninstall"
    ]));
    assert.equal(removed.status, "uninstalled");
    assert.equal(removed.private_data_preserved, true);
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(path.join(root, "launcher.mjs")), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("uninstall 默认移除运行时但保留私有数据", () => {
  const { root } = initRoot();
  const marker = path.join(root, "private/keep-me.txt");
  writeFileSync(marker, "private\n", { mode: 0o600 });
  const launchctl = fakeLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-default-uninstall-launchctl-"))
  );

  const result = json(run([
    "--root", root,
    "--launch-agents-dir", path.join(root, "fake-launch-agents"),
    "uninstall",
    "--launchctl-bin", launchctl.filename
  ]));
  assert.equal(result.status, "uninstalled");
  assert.equal(result.private_data_preserved, true);
  assert.ok(existsSync(marker));
  assert.equal(existsSync(path.join(root, "versions")), false);
  assert.equal(existsSync(path.join(root, "installation.json")), false);
});
