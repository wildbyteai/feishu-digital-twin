import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { scanPublicBuffers, scanPublicFiles } from "../../ops/public-content-scan.mjs";
import { validatePublicSnapshotPolicy } from "../../ops/public-snapshot.mjs";
import { validateInstanceConfig } from "../../runtime/src/config-loader.mjs";

const projectRoot = path.resolve(".");
const syntheticPrivatePattern = new RegExp([
  "Private Example Person",
  "private_profile",
  "legacy\\.private\\.service",
  "private-provider\\.example"
].join("|"), "iu");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

test("公开配置示例保持中性并默认拒绝处理生产数据", () => {
  const config = readJson("config.example.json");
  const fullConfig = readJson("config.full.example.json");
  const serialized = JSON.stringify([config, fullConfig]);

  assert.equal(config.schema_version, 2);
  assert.equal(config.production_data_approved, false);
  assert.deepEqual(config.control, { mode: "local", enabled: false });
  assert.equal(config.profile, "example_profile");
  assert.equal(config.message_scope, "bot_only");
  assert.equal(config.codex_bin, "/opt/feishu-digital-twin/bin/codex");
  assert.equal(
    config.codex_environment_root,
    "/opt/feishu-digital-twin/codex-environment"
  );
  assert.equal(Object.hasOwn(config, "provider_ref"), false);
  assert.equal(Object.hasOwn(config, "codex_isolation_root"), false);
  assert.equal(config.principal.name, "示例负责人");
  assert.deepEqual(config.principal.address_names, ["示例负责人"]);
  assert.equal(Object.hasOwn(config, "console"), false);
  assert.equal(Object.hasOwn(config, "daily_memory"), false);
  assert.equal(config.privacy.state_retention_days, 7);
  assert.equal(config.privacy.result_log_retention_days, 3);
  assert.equal(config.privacy.result_log_max_bytes, 1048576);
  assert.equal(config.privacy.signal_log_retention_days, 3);
  assert.equal(config.privacy.signal_log_max_bytes, 262144);
  assert.deepEqual(validateInstanceConfig(config), config);
  assert.equal(fullConfig.daily_memory.folder_name, "数字分身每日工作记忆");
  assert.deepEqual(fullConfig.control, { mode: "base" });
  assert.deepEqual(fullConfig.daily_memory.excluded_chat_ids, []);
  assert.deepEqual(fullConfig.daily_memory.excluded_topics, []);
  assert.equal(fullConfig.allowed_lark_domains.includes("docs"), true);
  assert.equal(fullConfig.allowed_lark_domains.includes("docx"), false);
  assert.deepEqual(validateInstanceConfig(fullConfig), fullConfig);
  assert.doesNotMatch(serialized, syntheticPrivatePattern);
  assert.doesNotMatch(serialized, /\/(?:Users|home|private|var)\//u);
});

test("Codex 插件元数据与 npm 版本保持一致并包含公开目录所需信息", () => {
  const manifest = readJson("package.json");
  const plugin = readJson(".codex-plugin/plugin.json");

  assert.equal(plugin.name, manifest.name);
  assert.equal(plugin.version, manifest.version);
  assert.equal(plugin.license, manifest.license);
  assert.equal(plugin.skills, "./skills/");
  assert.equal(typeof plugin.description, "string");
  assert.equal(plugin.description.length > 0, true);
  assert.equal(typeof plugin.author?.name, "string");
  assert.equal(plugin.author.name.length > 0, true);
  for (const field of [
    "displayName",
    "shortDescription",
    "longDescription",
    "developerName"
  ]) {
    assert.equal(typeof plugin.interface?.[field], "string", field);
    assert.equal(plugin.interface[field].trim().length > 0, true, field);
  }
  assert.equal(plugin.interface?.category, "Productivity");
  assert.deepEqual(plugin.interface?.capabilities, ["Read", "Write", "Automation"]);
  assert.equal(Array.isArray(plugin.interface?.defaultPrompt), true);
  assert.equal(plugin.interface.defaultPrompt.length > 0, true);
  assert.equal(
    plugin.interface.defaultPrompt.every((prompt) => (
      typeof prompt === "string" && prompt.trim().length > 0
    )),
    true
  );
  assert.match(plugin.interface?.brandColor ?? "", /^#[A-Fa-f0-9]{6}$/u);
  assert.doesNotMatch(JSON.stringify(plugin), syntheticPrivatePattern);
});

test("公共快照清单覆盖现有完整产品面且排除私有区域", () => {
  const policy = readJson("release/public-snapshot.example.json");
  const paths = policy.files.map((entry) => entry.path);
  const requiredPaths = [
    ".codex-plugin/plugin.json",
    ".github/CODEOWNERS.example",
    ".github/dependabot.yml",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/pull_request_template.md",
    ".github/workflows/ci.yml",
    ".github/workflows/codeql.yml",
    ".github/workflows/dependency-review.yml",
    ".github/workflows/scorecard.yml",
    ".gitignore",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "GOVERNANCE.md",
    "LICENSE",
    "LICENSES/Apache-2.0.txt",
    "NOTICE",
    "README.md",
    "REUSE.toml",
    "SECURITY.md",
    "bin/feishu-digital-twin.mjs",
    "bin/feishu-digital-twin-supervisor.mjs",
    "bin/run-isolated-tests.mjs",
    "bin/supervisor-core.mjs",
    "bin/twin-public-content-scan.mjs",
    "bin/twin-public-snapshot.mjs",
    "config.example.json",
    "config.full.example.json",
    "deploy/launchd/daily-memory.plist.template",
    "deploy/launchd/realtime.plist.template",
    "deploy/launchd/supplement.plist.template",
    "docs/dependencies.md",
    "docs/public/README.md",
    "docs/public/product-spec.md",
    "executor/src/lark-guard.mjs",
    "intake/bin/feishu-digital-twin-intake.mjs",
    "intake/src/intake-command.mjs",
    "ops/public-content-scan.mjs",
    "ops/public-snapshot.mjs",
    "package.json",
    "product/src/cli.mjs",
    "runtime/bin/feishu-digital-twin-runtime.mjs",
    "runtime/README.md",
    "runtime/schemas/codex-decision.schema.json",
    "runtime/schemas/instance-config.schema.json",
    "runtime/src/daily-memory-privacy.mjs",
    "runtime/src/inference-adapter.mjs",
    "runtime/src/twin-runtime.mjs",
    "shared/authority-labels.mjs",
    "shared/lark-capability-catalog.mjs",
    "skills/feishu-daily-work-memory/SKILL.md",
    "skills/feishu-digital-twin-control/SKILL.md",
    "skills/feishu-digital-twin/SKILL.md",
    "tests/runtime/daily-memory-privacy-v2.test.mjs",
    "tests/runtime/privacy-projection-v2.test.mjs",
    "tests/runtime/prompt-projection-v2.test.mjs",
    "tests/runtime/runtime-entry-v2.test.mjs",
    "tests/runtime/public-snapshot-v2.test.mjs"
  ];

  assert.equal(policy.schema_version, 1);
  assert.equal(policy.archive_prefix, "feishu-digital-twin");
  assert.equal(paths.length >= 60, true);
  assert.deepEqual(paths, [...paths].sort((left, right) => left.localeCompare(right, "en")));
  assert.equal(new Set(paths).size, paths.length);
  for (const requiredPath of requiredPaths) assert.equal(paths.includes(requiredPath), true, requiredPath);
  assert.equal(paths.includes("runtime/src/base-analytics.mjs"), false);
  assert.equal(paths.includes(".github/CODEOWNERS"), false);
  assert.equal(paths.includes("tests/runtime/base-analytics-v2.test.mjs"), false);
  assert.equal(paths.includes("bin/twin-supervisor.mjs"), false);
  assert.equal(paths.includes("runtime/bin/twin-runtime.mjs"), false);
  assert.equal(paths.includes("tests/runtime/legacy-runtime-entry-v2.test.mjs"), false);
  for (const relativePath of paths) {
    assert.doesNotMatch(relativePath, /(?:^|\/)\.(?:git|scratch|runtime|codex-runtime|workbuddy)(?:\/|$)/u);
    assert.doesNotMatch(relativePath, /(?:^|\/)AGENTS\.md$/u);
    assert.doesNotMatch(relativePath, /(?:^|\/)com\.[^/]+/iu);
    assert.doesNotMatch(relativePath, /\.privacy-key$/u);
    const metadata = lstatSync(path.join(projectRoot, relativePath));
    assert.equal(metadata.isFile(), true, relativePath);
    assert.equal(metadata.isSymbolicLink(), false, relativePath);
  }
});

test("公共 CI 使用最小权限、固定第三方 Action 并执行完整公开内容扫描", () => {
  const workflowPaths = [
    ".github/workflows/ci.yml",
    ".github/workflows/codeql.yml",
    ".github/workflows/dependency-review.yml",
    ".github/workflows/scorecard.yml"
  ];
  const workflows = workflowPaths.map((relativePath) => ({
    relativePath,
    content: readFileSync(path.join(projectRoot, relativePath), "utf8")
  }));
  const workflow = workflows[0].content;
  const dependabot = readFileSync(path.join(projectRoot, ".github/dependabot.yml"), "utf8");

  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/u);
  assert.match(workflow, /npm test/u);
  assert.match(workflow, /npm run test:distribution/u);
  assert.match(workflow, /npm pack --dry-run --json --ignore-scripts/u);
  assert.match(workflow, /twin-public-snapshot\.mjs\s+policy-check/u);
  assert.match(workflow, /twin-public-content-scan\.mjs\s+release\/public-snapshot\.example\.json/u);
  assert.match(workflow, /--require-complete-tracked-set/u);
  assert.match(workflow, /repository\.visibility\s*==\s*'public'/u);
  assert.match(workflow, /fsfe\/reuse-action@[a-f0-9]{40}/u);
  for (const { relativePath, content } of workflows) {
    const uses = [...content.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gmu)]
      .map((match) => match[1]);
    assert.equal(uses.length > 0, true, relativePath);
    for (const value of uses) {
      assert.match(
        value,
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}$/u,
        `${relativePath}: ${value}`
      );
    }
    assert.doesNotMatch(content, /pull_request_target|secrets\./u);
  }
  assert.match(dependabot, /package-ecosystem:\s*"github-actions"/u);
  assert.match(dependabot, /interval:\s*"weekly"/u);
});

test("公共协作模板默认阻止真实飞书和企业数据进入公开讨论", () => {
  const relativePaths = [
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/pull_request_template.md"
  ];
  for (const relativePath of relativePaths) {
    const content = readFileSync(path.join(projectRoot, relativePath), "utf8");
    assert.match(content, /真实消息|business data|企业数据/iu, relativePath);
    assert.match(content, /凭据|credential/iu, relativePath);
    assert.match(content, /飞书\s*(?:ID|标识)|Lark ID/iu, relativePath);
    assert.match(content, /日志|log/iu, relativePath);
  }
});

test("完整公共清单通过内容扫描且不依赖私有词表明文", async () => {
  const policy = readJson("release/public-snapshot.example.json");
  const report = await scanPublicFiles({
    root: projectRoot,
    files: policy.files,
    policy: {
      schema_version: 1,
      forbidden_literals: [["SYNTHETIC", "PRIVATE", "IDENTITY", "X"].join("_")],
      private_domains: [["private-only", "invalid", "test"].join(".")]
    },
    stage: "full-public-manifest"
  });

  assert.deepEqual(report.findings, []);
});

test("公共内容扫描 CLI 只输出路径和发现代码", () => {
  const result = spawnSync(process.execPath, [
    path.join(projectRoot, "bin/twin-public-content-scan.mjs"),
    "release/public-snapshot.example.json"
  ], {
    cwd: projectRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.type, "public_content_scan");
  assert.equal(report.status, "clean");
  assert.equal(report.finding_count, 0);
  assert.deepEqual(report.findings, []);
  assert.equal(Object.hasOwn(report, "bytes_scanned"), true);
  assert.doesNotMatch(result.stdout, syntheticPrivatePattern);
});

test("公共仓完整性门拒绝任何未进入允许清单的 tracked 文件", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "twin-public-tracked-set-"));
  const release = path.join(root, "release");
  mkdirSync(release, { recursive: true });
  const policy = {
    schema_version: 1,
    archive_prefix: "fixture-public-product",
    files: [
      { path: "README.md", provenance: "project" },
      { path: "release/public-snapshot.example.json", provenance: "project" }
    ],
    provenance: {
      project: { origin: "project-authored", synthetic: false }
    },
    limits: { max_files: 10, max_total_bytes: 1048576 }
  };
  writeFileSync(path.join(root, "README.md"), "# Synthetic public product\n");
  writeFileSync(
    path.join(release, "public-snapshot.example.json"),
    `${JSON.stringify(policy, null, 2)}\n`
  );
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["add", "--", "README.md", "release/public-snapshot.example.json"], {
    cwd: root
  }).status, 0);

  const command = [
    path.join(projectRoot, "bin/twin-public-content-scan.mjs"),
    "release/public-snapshot.example.json",
    "--require-complete-tracked-set"
  ];
  const clean = spawnSync(process.execPath, command, { cwd: root, encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);

  writeFileSync(path.join(root, "UNLISTED.md"), "synthetic unlisted content\n");
  assert.equal(spawnSync("git", ["add", "--", "UNLISTED.md"], { cwd: root }).status, 0);
  const blocked = spawnSync(process.execPath, command, { cwd: root, encoding: "utf8" });
  assert.equal(blocked.status, 1);
  const report = JSON.parse(blocked.stderr);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.findings, [
    { code: "tracked-file-not-in-public-manifest", path: "UNLISTED.md" }
  ]);
});

test("npm 包声明 Apache-2.0 并使用显式公共文件白名单", () => {
  const manifest = readJson("package.json");
  const publicPaths = new Set(
    readJson("release/public-snapshot.example.json").files.map((entry) => entry.path)
  );

  assert.notEqual(manifest.private, true);
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(typeof manifest.description, "string");
  assert.equal(manifest.description.length > 0, true);
  assert.equal(Array.isArray(manifest.keywords), true);
  assert.equal(manifest.keywords.length > 0, true);
  assert.equal(Array.isArray(manifest.files), true);
  assert.equal(manifest.files.length > 0, true);
  assert.deepEqual(
    manifest.files,
    [...manifest.files].sort((left, right) => left.localeCompare(right, "en"))
  );
  assert.equal(new Set(manifest.files).size, manifest.files.length);
  assert.equal(Object.hasOwn(manifest, "repository"), false);

  const requiredEntries = [
    ".codex-plugin/plugin.json",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "GOVERNANCE.md",
    "LICENSE",
    "NOTICE",
    "SECURITY.md",
    "bin/feishu-digital-twin.mjs",
    "bin/feishu-digital-twin-supervisor.mjs",
    "bin/supervisor-core.mjs",
    "config.example.json",
    "deploy/launchd/daily-memory.plist.template",
    "executor/src/lark-guard.mjs",
    "intake/bin/feishu-digital-twin-intake.mjs",
    "intake/src/intake-command.mjs",
    "product/src/cli.mjs",
    "runtime/bin/feishu-digital-twin-runtime.mjs",
    "runtime/src/daily-memory-privacy.mjs",
    "shared/lark-capability-catalog.mjs",
    "skills/feishu-digital-twin/SKILL.md"
  ];
  for (const requiredEntry of requiredEntries) {
    assert.equal(manifest.files.includes(requiredEntry), true, requiredEntry);
  }

  for (const relativePath of manifest.files) {
    assert.equal(publicPaths.has(relativePath), true, `${relativePath} is not public-snapshot approved`);
    assert.doesNotMatch(relativePath, /(?:^|\/)\.(?:git|scratch|runtime|codex-runtime|workbuddy)(?:\/|$)/u);
    assert.doesNotMatch(relativePath, /(?:^|\/)AGENTS\.md$/u);
    assert.doesNotMatch(relativePath, /\.privacy-key$/u);
    const metadata = lstatSync(path.join(projectRoot, relativePath));
    assert.equal(metadata.isFile(), true, relativePath);
    assert.equal(metadata.isSymbolicLink(), false, relativePath);
  }
});

test("公共许可证与依赖台账覆盖外部执行组件", () => {
  const reuse = readFileSync(path.join(projectRoot, "REUSE.toml"), "utf8");
  const dependencies = readFileSync(path.join(projectRoot, "docs/dependencies.md"), "utf8");
  const apacheLicense = readFileSync(path.join(projectRoot, "LICENSES/Apache-2.0.txt"), "utf8");

  assert.match(
    reuse,
    /SPDX-FileCopyrightText\s*=\s*"2026 Feishu Digital Twin contributors"/u
  );
  assert.match(reuse, /SPDX-License-Identifier\s*=\s*"Apache-2\.0"/u);
  assert.match(apacheLicense, /Apache License\s+Version 2\.0/u);
  for (const dependency of [
    "Node.js",
    "Codex CLI",
    "lark-cli",
    "lark-* Skills",
    "GitHub Actions"
  ]) {
    const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(dependencies, new RegExp(escaped, "u"));
  }
  assert.match(dependencies, /不随.*发行物.*再分发|not redistributed/iu);
  assert.match(dependencies, /升级|upgrade/iu);
  assert.match(dependencies, /停用|disable|removal/iu);
});

test("npm 打包预演不会隐式夹带公共白名单外文件", {
  skip: process.env.TWIN_TEST_MODE === "1"
    ? "npm is intentionally unavailable inside the isolated runtime test PATH"
    : false
}, () => {
  const manifest = readJson("package.json");
  const cache = mkdtempSync(path.join(os.tmpdir(), "feishu-digital-twin-npm-cache-"));
  try {
    const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
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
    assert.equal(result.status, 0, result.stderr || result.error?.message || "npm pack failed");
    const report = JSON.parse(result.stdout);
    const packedPaths = report[0].files.map((entry) => entry.path);
    assert.deepEqual(
      packedPaths.sort((left, right) => left.localeCompare(right, "en")),
      [...manifest.files].sort((left, right) => left.localeCompare(right, "en"))
    );
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("正式公共文档不依赖私有 scratch 或合成私密实例标识", () => {
  const content = [
    readFileSync(path.join(projectRoot, "docs/public/README.md"), "utf8"),
    readFileSync(path.join(projectRoot, "docs/public/product-spec.md"), "utf8"),
    readFileSync(path.join(projectRoot, "docs/feishu-console.md"), "utf8"),
    readFileSync(path.join(projectRoot, "docs/operations/local-service-continuity.md"), "utf8"),
    readFileSync(path.join(projectRoot, "docs/operations/public-snapshot.md"), "utf8")
  ].join("\n");

  assert.doesNotMatch(content, /\.scratch\//u);
  assert.doesNotMatch(content, syntheticPrivatePattern);
  assert.doesNotMatch(content, /任务\s*0?3|公共核心/u);
  assert.match(content, /完整功能|完整能力/u);
  assert.match(content, /本机|私有运行态/u);
  assert.match(content, /\.privacy-key/u);
});

test("公共 launchd 模板使用中性服务名且不固化业务配置", () => {
  const templates = [
    "deploy/launchd/daily-memory.plist.template",
    "deploy/launchd/realtime.plist.template",
    "deploy/launchd/supplement.plist.template"
  ];
  for (const relativePath of templates) {
    const content = readFileSync(path.join(projectRoot, relativePath), "utf8");
    assert.match(content, /__SERVICE_LABEL__/u);
    assert.match(content, /__INSTALL_ROOT__/u);
    assert.doesNotMatch(content, /__TIMEZONE__|<key>TZ<\/key>/u);
    assert.doesNotMatch(content, /<string>com\.[^<]+<\/string>/iu);
    assert.doesNotMatch(content, /<string>Asia\/[A-Za-z_]+<\/string>/u);
  }
  const dailyMemory = readFileSync(
    path.join(projectRoot, "deploy/launchd/daily-memory.plist.template"),
    "utf8"
  );
  assert.doesNotMatch(dailyMemory, /StartCalendarInterval|__DAILY_HOUR__|__DAILY_MINUTE__/u);
  assert.match(dailyMemory, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/u);
});

test("Git 忽略规则阻止授权二维码和私有运行态进入候选", () => {
  const repository = mkdtempSync(path.join(os.tmpdir(), "public-gitignore-"));
  writeFileSync(
    path.join(repository, ".gitignore"),
    readFileSync(path.join(projectRoot, ".gitignore"), "utf8")
  );
  const initialized = spawnSync("git", ["init", "-q"], {
    cwd: repository,
    encoding: "utf8"
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const canaries = [
    ".runtime/config.json",
    ".runtime/identifier.privacy-key",
    ".workbuddy/memory.md",
    ".scratch/private-provider-config-qr.png",
    "config.local.json"
  ];
  for (const canary of canaries) {
    const result = spawnSync("git", ["check-ignore", "--no-index", "--", canary], {
      cwd: repository,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, canary);
  }
});

test("公共策略和内容扫描都拒绝本机 privacy key", async () => {
  const policy = readJson("release/public-snapshot.example.json");
  const withPrivateKey = structuredClone(policy);
  withPrivateKey.files.push({ path: "state/identifier.privacy-key", provenance: "project" });
  withPrivateKey.files.sort((left, right) => left.path.localeCompare(right.path, "en"));

  assert.throws(
    () => validatePublicSnapshotPolicy(withPrivateKey),
    /forbidden private area/u
  );

  const report = await scanPublicBuffers({
    files: [{ path: "state/identifier.privacy-key", content: Buffer.from("fixture-secret") }],
    policy: {
      schema_version: 1,
      forbidden_literals: ["Private Person"],
      private_domains: []
    },
    stage: "source-selection"
  });
  assert.equal(report.finding_count, 1);
  assert.deepEqual(report.findings, [
    { code: "sensitive-private-path", path: "state/identifier.privacy-key" }
  ]);
});

test("公共快照 CLI 可以只读校验允许清单并输出脱敏摘要", () => {
  const result = spawnSync(process.execPath, [
    path.join(projectRoot, "bin/twin-public-snapshot.mjs"),
    "policy-check",
    "release/public-snapshot.example.json"
  ], {
    cwd: projectRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output, {
    type: "public_snapshot_policy",
    status: "valid",
    archive_prefix: "feishu-digital-twin",
    file_count: readJson("release/public-snapshot.example.json").files.length,
    provenance_count: 2
  });
  assert.doesNotMatch(result.stdout, new RegExp([
    "\\.scratch",
    "\\/Users\\/",
    "private-provider\\.example",
    "Private Example Person"
  ].join("|"), "iu"));
});
