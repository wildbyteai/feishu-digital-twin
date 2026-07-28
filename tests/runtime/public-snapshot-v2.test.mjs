import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  mergePrivateScanPolicyWithInstanceConfig,
  scanPublicBuffers,
  scanPublicFiles
} from "../../ops/public-content-scan.mjs";
import { buildPublicSnapshot, verifyPublicCandidate } from "../../ops/public-snapshot.mjs";

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeProjectFile(root, filename, content, mode = 0o644) {
  const target = path.join(root, filename);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, { mode });
  chmodSync(target, mode);
}

function createSyntheticRepository({ objectFormat } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "public-snapshot-source-"));
  writeProjectFile(root, ".gitignore", ".runtime/\n");
  writeProjectFile(root, "package.json", `${JSON.stringify({
    name: "fixture-digital-twin",
    version: "1.2.3",
    private: false,
    license: "Apache-2.0",
    files: [".codex-plugin", "package.json", "src", "tests"]
  })}\n`);
  writeProjectFile(root, ".codex-plugin/plugin.json", `${JSON.stringify({
    name: "fixture-digital-twin",
    version: "1.2.3",
    description: "Synthetic Codex plugin fixture",
    skills: "./skills/"
  })}\n`);
  writeProjectFile(
    root,
    "src/core.mjs",
    'export const fixturePrincipal = "ou_fixture_principal";\n' +
      'export const fixtureSort = (left, right) => left.path.localeCompare(right.path, "en");\n'
  );
  writeProjectFile(
    root,
    "tests/fixture.mjs",
    'export const fixtureUrl = "https://docs.example.invalid/fixture";\n'
  );
  runGit(root, ["init", "-q", ...(objectFormat ? [`--object-format=${objectFormat}`] : [])]);
  runGit(root, [
    "add",
    ".codex-plugin/plugin.json",
    ".gitignore",
    "package.json",
    "src/core.mjs",
    "tests/fixture.mjs"
  ]);
  runGit(root, [
    "-c", "user.name=Fixture Maintainer",
    "-c", "user.email=maintainer@example.invalid",
    "commit", "-qm", "fixture source"
  ]);
  return root;
}

function commitAll(root, message) {
  runGit(root, ["add", "-A"]);
  runGit(root, [
    "-c", "user.name=Fixture Maintainer",
    "-c", "user.email=maintainer@example.invalid",
    "commit", "-qm", message
  ]);
}

function publicPolicy() {
  return {
    schema_version: 1,
    archive_prefix: "fixture-digital-twin",
    files: [
      { path: ".codex-plugin/plugin.json", provenance: "project" },
      { path: "package.json", provenance: "project" },
      { path: "src/core.mjs", provenance: "project" },
      { path: "tests/fixture.mjs", provenance: "synthetic" }
    ],
    provenance: {
      project: { origin: "project-authored", synthetic: false },
      synthetic: { origin: "project-authored", synthetic: true }
    },
    limits: { max_files: 20, max_total_bytes: 1024 * 1024 }
  };
}

function writePolicies(root, policy = publicPolicy()) {
  const policyPath = path.join(root, "public-snapshot-policy.json");
  const privatePolicyPath = path.join(root, "public-snapshot-private-policy.json");
  writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  writeFileSync(privatePolicyPath, `${JSON.stringify({
    schema_version: 1,
    forbidden_literals: [["Private", " Person"].join("")],
    private_domains: [["corp", ".internal"].join("")]
  }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(privatePolicyPath, 0o600);
  return { policyPath, privatePolicyPath };
}

function writeSyntheticInstanceConfig(root, { controlMode = "local" } = {}) {
  const configPath = path.join(root, "instance-config.json");
  const consoleBaseToken = ["console", "-private-", "amber-9012"].join("");
  const dailyFolderToken = ["daily", "-private-", "vault-9012"].join("");
  const value = {
    schema_version: 2,
    instance_id: "orchid-production-instance",
    profile: "orchid-operator-private",
    message_scope: "bot_only",
    production_data_approved: false,
    private_capability_packs: ["orchid.records"],
    allowed_capabilities: ["orchid.records.read"],
    required_capabilities: [],
    control: controlMode === "base"
      ? { mode: "base" }
      : { mode: "local", enabled: false },
    principal: {
      name: "林昭",
      open_id: "principal-private-orchid-9012",
      timezone: "Asia/Shanghai",
      address_names: ["林昭本人"]
    },
    schedule: {
      workdays: [1, 2, 3, 4, 5],
      workday_start_hour: 9,
      workday_end_hour: 18,
      work_interval_seconds: 30,
      quiet_interval_seconds: 300,
      daily_memory_hour: 0,
      daily_memory_minute: 10
    },
    daily_memory: {
      folder_token: dailyFolderToken,
      folder_name: "星河每日工作记忆",
      excluded_chat_ids: ["chat-private-excluded-9012"],
      excluded_topics: ["星河董事会专题"]
    },
    allowed_lark_domains: controlMode === "base" ? ["base", "im"] : ["im"],
    ...(controlMode === "base" ? {
      console: {
        base_token: consoleBaseToken,
        runtime_table: "星河运行控制总表",
        group_rules_table: "星河群级规则总表"
      }
    } : {
      group_rules: [{
        chat_id: "chat-private-rule-9012",
        rules: ["企业知识库：星河产品资料；space_id=space-private-nebula-9012"]
      }],
      authority_rules: [
        "公司=星河传讯实验组织；企业知识库=星河产品资料；space_id=space-private-nebula-9012",
        "公司=星澜",
        "品牌=`云舟`",
        "项目=‘霁月’",
        "租户名称=星屿",
        "公司=\"O'Reilly Labs\"",
        "公司=\"Secret Labs",
        "只引用 https://tenant-private-aurora.feishu.cn/wiki/ 中已发布的资料"
      ]
    })
  };
  writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return { configPath, value };
}

function healthyContinuity(calls = []) {
  return {
    async capture() {
      calls.push("capture");
      return { healthy: true, baseline: { marker: "before" } };
    },
    async compare(baseline) {
      calls.push(["compare", baseline.marker]);
      return { healthy: true, violations: [] };
    }
  };
}

test("公共快照只从允许清单生成可审核候选并经过连续性前后门", async () => {
  const sourceRoot = createSyntheticRepository();
  const outputRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-output-"));
  const { policyPath, privatePolicyPath } = writePolicies(outputRoot);
  const continuityCalls = [];

  const result = await buildPublicSnapshot({
    sourceRoot,
    outputRoot,
    policyPath,
    privatePolicyPath,
    continuity: healthyContinuity(continuityCalls)
  });

  assert.deepEqual(continuityCalls, [
    "capture",
    ["compare", "before"],
    ["compare", "before"]
  ]);
  assert.match(result.candidate_id, /^sha256-[a-f0-9]{64}$/u);
  assert.equal(result.version, "1.2.3");
  assert.equal(result.file_count, 4);
  const candidate = path.join(outputRoot, "candidates", result.candidate_id);
  assert.equal(existsSync(candidate), true);
  assert.deepEqual(
    readdirSync(path.join(candidate, "tree")).sort(),
    [".codex-plugin", "package.json", "src", "tests"]
  );
  assert.equal(existsSync(path.join(candidate, "tree", ".git")), false);
  assert.equal(existsSync(path.join(candidate, "source.tar")), true);
  assert.equal(existsSync(path.join(candidate, "codex-plugin.tar")), true);
  assert.equal(existsSync(path.join(candidate, "npm-package.tgz")), true);
  assert.equal(existsSync(path.join(candidate, "sbom.spdx.json")), true);
  assert.equal(existsSync(path.join(candidate, "provenance.intoto.jsonl")), true);
  assert.equal(existsSync(path.join(candidate, "SHA256SUMS")), true);
  assert.equal(statSync(path.join(candidate, "snapshot-manifest.json")).isFile(), true);

  const manifestContent = readFileSync(path.join(candidate, "snapshot-manifest.json"));
  const manifest = JSON.parse(manifestContent.toString("utf8"));
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.tree_sha256, result.tree_sha256);
  assert.equal(manifest.archive.sha256, result.archive_sha256);
  assert.equal(manifest.artifacts.source.sha256, result.archive_sha256);
  assert.equal(manifest.artifacts.codex_plugin.sha256, result.plugin_sha256);
  assert.equal(manifest.artifacts.npm.sha256, result.npm_sha256);
  assert.equal(manifest.artifacts.sbom.sha256, result.sbom_sha256);
  assert.equal(manifest.artifacts.provenance.sha256, result.provenance_sha256);
  for (const artifact of Object.values(manifest.artifacts)) {
    assert.equal(artifact.version, "1.2.3");
    assert.equal(artifact.source_tree_sha256, result.tree_sha256);
  }
  assert.deepEqual(manifest.files.map((file) => file.path), [
    ".codex-plugin/plugin.json",
    "package.json",
    "src/core.mjs",
    "tests/fixture.mjs"
  ]);
  assert.deepEqual(manifest.scans.map((scan) => scan.stage), [
    "source-selection",
    "staging-tree",
    "archive-unpacked",
    "plugin-unpacked",
    "npm-unpacked",
    "candidate-metadata"
  ]);
  assert.equal(manifest.scans.every((scan) => scan.finding_count === 0), true);
  const checksumContent = readFileSync(path.join(candidate, "SHA256SUMS"), "utf8");
  const manifestSha256 = createHash("sha256").update(manifestContent).digest("hex");
  assert.equal(checksumContent.includes(`${manifestSha256}  snapshot-manifest.json`), true);
  assert.equal(
    checksumContent.includes(`${result.plugin_sha256}  codex-plugin.tar`),
    true
  );
  assert.equal(checksumContent.includes(`${result.npm_sha256}  npm-package.tgz`), true);
  assert.equal(checksumContent.includes(`${result.sbom_sha256}  sbom.spdx.json`), true);
  assert.equal(
    checksumContent.includes(`${result.provenance_sha256}  provenance.intoto.jsonl`),
    true
  );

  const sbom = JSON.parse(readFileSync(path.join(candidate, "sbom.spdx.json"), "utf8"));
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.equal(sbom.dataLicense, "CC0-1.0");
  assert.equal(sbom.packages.length, 1);
  assert.equal(sbom.packages[0].name, "fixture-digital-twin");
  assert.equal(sbom.packages[0].versionInfo, "1.2.3");
  assert.equal(sbom.packages[0].licenseDeclared, "Apache-2.0");
  assert.deepEqual(
    sbom.files.map((entry) => entry.fileName),
    [
      "./.codex-plugin/plugin.json",
      "./package.json",
      "./src/core.mjs",
      "./tests/fixture.mjs"
    ]
  );

  const provenanceLines = readFileSync(
    path.join(candidate, "provenance.intoto.jsonl"),
    "utf8"
  ).trim().split(/\r?\n/u);
  assert.equal(provenanceLines.length, 1);
  const provenance = JSON.parse(provenanceLines[0]);
  assert.equal(provenance._type, "https://in-toto.io/Statement/v1");
  assert.equal(provenance.predicateType, "https://slsa.dev/provenance/v1");
  assert.equal(provenance.predicate.buildDefinition.externalParameters.version, "1.2.3");
  assert.equal(
    provenance.predicate.buildDefinition.externalParameters.source_tree_sha256,
    result.tree_sha256
  );
  assert.deepEqual(
    provenance.subject.map((subject) => subject.name),
    ["codex-plugin.tar", "npm-package.tgz", "sbom.spdx.json", "source.tar"]
  );
  const pluginListing = spawnSync("tar", ["-tf", path.join(candidate, "codex-plugin.tar")], {
    encoding: "utf8"
  });
  assert.equal(pluginListing.status, 0, pluginListing.stderr);
  assert.equal(
    pluginListing.stdout.split(/\r?\n/u).includes(
      "fixture-digital-twin/.codex-plugin/plugin.json"
    ),
    true
  );
  const npmListing = spawnSync("tar", ["-tzf", path.join(candidate, "npm-package.tgz")], {
    encoding: "utf8"
  });
  assert.equal(npmListing.status, 0, npmListing.stderr);
  assert.equal(npmListing.stdout.split(/\r?\n/u).includes("package/package.json"), true);
  const receipts = readdirSync(path.join(outputRoot, "receipts"));
  assert.equal(receipts.length, 1);
  const receiptPath = path.join(outputRoot, "receipts", receipts[0]);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
  assert.equal(receipt.status, "attested");
  assert.equal(receipt.candidate_id, result.candidate_id);
  assert.equal(receipt.tree_sha256, result.tree_sha256);
  assert.match(receipt.public_policy_sha256, /^[a-f0-9]{64}$/u);
  assert.match(receipt.private_policy_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.manifest_sha256, manifestSha256);
  assert.match(receipt.continuity.before.evidence_sha256, /^[a-f0-9]{64}$/u);
  assert.match(receipt.continuity.after.evidence_sha256, /^[a-f0-9]{64}$/u);
  assert.match(receipt.continuity.before.source_evidence_sha256, /^[a-f0-9]{64}$/u);
  assert.match(receipt.continuity.after.source_evidence_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.continuity.before.healthy, true);
  assert.equal(receipt.continuity.after.healthy, true);
  assert.deepEqual(receipt.continuity.before.violation_codes, []);
  assert.deepEqual(receipt.continuity.after.violation_codes, []);
  const verification = await verifyPublicCandidate({ candidatePath: candidate });
  assert.deepEqual(verification, {
    status: "verified",
    candidate_id: result.candidate_id,
    version: "1.2.3",
    file_count: 4,
    tree_sha256: result.tree_sha256,
    archive_sha256: result.archive_sha256,
    plugin_sha256: result.plugin_sha256,
    npm_sha256: result.npm_sha256,
    sbom_sha256: result.sbom_sha256,
    provenance_sha256: result.provenance_sha256
  });
  assert.doesNotMatch(JSON.stringify(receipt), /\/Users\/|\/private\/var\/|Private Person/u);
  assert.equal(
    readdirSync(outputRoot).some((entry) => entry.startsWith(".attempt-")),
    false
  );
});

test("公共快照从 Git 外实例配置派生私有禁止值并且不在输出或回执中回显", async () => {
  const localInstanceRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-instance-local-"));
  const baseInstanceRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-instance-base-"));
  const { configPath, value: instanceConfig } = writeSyntheticInstanceConfig(localInstanceRoot);
  const {
    configPath: baseConfigPath,
    value: baseInstanceConfig
  } = writeSyntheticInstanceConfig(baseInstanceRoot, { controlMode: "base" });
  const canaries = [
    { value: instanceConfig.instance_id, configPath },
    { value: instanceConfig.profile, configPath },
    { value: instanceConfig.private_capability_packs[0], configPath },
    { value: instanceConfig.principal.name, configPath },
    { value: instanceConfig.principal.open_id, configPath },
    { value: instanceConfig.principal.address_names[0], configPath },
    { value: baseInstanceConfig.console.base_token, configPath: baseConfigPath },
    { value: baseInstanceConfig.console.runtime_table, configPath: baseConfigPath },
    { value: baseInstanceConfig.console.group_rules_table, configPath: baseConfigPath },
    { value: instanceConfig.daily_memory.folder_token, configPath },
    { value: instanceConfig.daily_memory.folder_name, configPath },
    { value: instanceConfig.daily_memory.excluded_chat_ids[0], configPath },
    { value: instanceConfig.daily_memory.excluded_topics[0], configPath },
    { value: instanceConfig.group_rules[0].chat_id, configPath },
    { value: "space-private-nebula-9012", configPath },
    { value: "星河产品资料", configPath },
    { value: "星河传讯实验组织", configPath },
    { value: "星澜", configPath },
    { value: "云舟", configPath },
    { value: "霁月", configPath },
    { value: "星屿", configPath },
    { value: "O'Reilly Labs", configPath },
    { value: "Secret Labs", configPath },
    { value: "tenant-private-aurora.feishu.cn", configPath },
    { value: ["Private", " Person"].join(""), configPath }
  ];

  for (const [index, canary] of canaries.entries()) {
    const sourceRoot = createSyntheticRepository();
    writeProjectFile(
      sourceRoot,
      "src/core.mjs",
      `export const privateCanary = ${JSON.stringify(canary.value)};\n`
    );
    commitAll(sourceRoot, `private config canary ${index}`);
    const outputRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-instance-canary-"));
    await assert.rejects(
      () => buildPublicSnapshot({
        sourceRoot,
        outputRoot,
        ...writePolicies(outputRoot),
        instanceConfigPath: canary.configPath,
        continuity: healthyContinuity()
      }),
      (error) => {
        assert.equal(error.stage, "source-selection");
        assert.equal(error.code, "privacy-scan-failed");
        assert.equal(error.finding_codes.includes("forbidden-literal") ||
          error.finding_codes.includes("private-domain"), true);
        assert.doesNotMatch(JSON.stringify(error), new RegExp(canary.value, "u"));
        return true;
      }
    );
  }

  const cleanSource = createSyntheticRepository();
  writeProjectFile(
    cleanSource,
    "src/core.mjs",
    "export const genericConfigValues = [true, false, 1, 3, 'bot_only', 'im', 'Asia/Shanghai'];\n"
  );
  commitAll(cleanSource, "generic config values stay public");
  const cleanOutput = mkdtempSync(path.join(tmpdir(), "public-snapshot-instance-clean-"));
  const result = await buildPublicSnapshot({
    sourceRoot: cleanSource,
    outputRoot: cleanOutput,
    ...writePolicies(cleanOutput),
    instanceConfigPath: configPath,
    continuity: healthyContinuity()
  });
  const receiptName = readdirSync(path.join(cleanOutput, "receipts"))[0];
  const receiptText = readFileSync(path.join(cleanOutput, "receipts", receiptName), "utf8");
  const privatePolicySha256 = JSON.parse(receiptText).private_policy_sha256;
  const candidatePath = path.join(cleanOutput, "candidates", result.candidate_id);
  const publicCandidateMetadata = [
    readFileSync(path.join(candidatePath, "snapshot-manifest.json"), "utf8"),
    readFileSync(path.join(candidatePath, "provenance.intoto.jsonl"), "utf8")
  ].join("\n");
  assert.doesNotMatch(publicCandidateMetadata, /private_policy_sha256/u);
  assert.doesNotMatch(publicCandidateMetadata, new RegExp(privatePolicySha256, "u"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privatePolicySha256, "u"));
  const publicEvidence = [
    JSON.stringify(result),
    receiptText
  ].join("\n");
  for (const canary of canaries) {
    assert.doesNotMatch(publicEvidence, new RegExp(canary.value, "u"));
  }
  assert.doesNotMatch(publicEvidence, new RegExp(configPath, "u"));
  assert.doesNotMatch(publicEvidence, new RegExp(baseConfigPath, "u"));
});

test("私有扫描策略按类别阻止组织、能力包、MCP server、工具、域名、路径和凭据", async () => {
  const policy = {
    schema_version: 1,
    forbidden_literals: ["Private Person"],
    organization_identifiers: ["Orchid Holdings"],
    private_capability_pack_ids: ["orchid.records"],
    private_domains: [["records", "orchid", "internal"].join(".")],
    private_mcp_server_refs: ["orchid-records-server"],
    private_tool_names: ["records.private.get"]
  };
  const canaries = [
    ["organization", "Orchid Holdings", "forbidden-literal"],
    ["capability-pack", "orchid.records", "forbidden-literal"],
    ["mcp-server", "orchid-records-server", "forbidden-literal"],
    ["tool", "records.private.get", "forbidden-literal"],
    [
      "domain",
      ["https://records", "orchid", "internal/item"].join("."),
      "private-domain"
    ],
    [
      "local-path",
      ["", "Users", "fixture-user", "private-capability.json"].join("/"),
      "absolute-local-path"
    ],
    [
      "credential",
      ["Authorization", ": Bearer ", "A1b2C3d4E5f6G7h8I9j0K1l2"].join(""),
      "known-secret-shape"
    ]
  ];

  for (const [name, value, code] of canaries) {
    const report = await scanPublicBuffers({
      files: [{ path: `fixtures/${name}.txt`, content: Buffer.from(value) }],
      policy,
      stage: "distribution-boundary"
    });
    assert.equal(report.findings.some((finding) => finding.code === code), true, name);
  }
});

test("私有扫描策略同样阻止组织、能力包、MCP server、工具和域名进入发行路径", async () => {
  const policy = {
    schema_version: 1,
    forbidden_literals: ["Private Person"],
    organization_identifiers: ["Orchid Holdings"],
    private_capability_pack_ids: ["orchid.records"],
    private_domains: [["records", "orchid", "internal"].join(".")],
    private_mcp_server_refs: ["orchid-records-server"],
    private_tool_names: ["records.private.get"]
  };
  const canaries = [
    ["Orchid Holdings", "forbidden-literal"],
    ["orchid.records", "forbidden-literal"],
    ["orchid-records-server", "forbidden-literal"],
    ["records.private.get", "forbidden-literal"],
    [["records", "orchid", "internal"].join("."), "private-domain"]
  ];

  for (const [value, code] of canaries) {
    const relativePath = `fixtures/${value}.txt`;
    const report = await scanPublicBuffers({
      files: [{ path: relativePath, content: Buffer.from("neutral fixture") }],
      policy,
      stage: "distribution-path-boundary"
    });
    assert.equal(
      report.findings.some((finding) => (
        finding.code === code && finding.path === "<private-path>"
      )),
      true,
      relativePath
    );
    assert.doesNotMatch(JSON.stringify(report), new RegExp(value, "u"));
  }

  const duplicateValue = "orchid.records";
  const duplicatePath = `fixtures/${duplicateValue}.txt`;
  const duplicateReport = await scanPublicBuffers({
    files: [{ path: duplicatePath, content: Buffer.from(duplicateValue) }],
    policy,
    stage: "distribution-path-boundary"
  });
  assert.deepEqual(duplicateReport.findings, [
    { code: "forbidden-literal", path: "<private-path>" }
  ]);

  const failedReadReport = await scanPublicBuffers({
    files: [{ path: duplicatePath, content: "not a buffer" }],
    policy,
    stage: "distribution-path-boundary"
  });
  assert.deepEqual(failedReadReport.findings, [
    { code: "file-read-failed", path: "<private-path>" }
  ]);
  assert.doesNotMatch(JSON.stringify(failedReadReport), new RegExp(duplicateValue, "u"));
});

test("未明确标注的普通短资源名不会被提升为私有身份禁词", () => {
  const merged = mergePrivateScanPolicyWithInstanceConfig({
    schema_version: 1,
    forbidden_literals: ["Private Person"],
    private_domains: []
  }, {
    console: {
      runtime_table: "运行配置",
      group_rules_table: "群规则"
    },
    daily_memory: {
      folder_name: "日报",
      excluded_topics: ["例会"]
    }
  });

  for (const value of ["运行配置", "群规则", "日报", "例会"]) {
    assert.equal(merged.forbidden_literals.includes(value), false);
  }
});

test("实例私有扫描配置不是源码树外 0600 普通文件时在连续性检查前失败关闭", async () => {
  for (const scenario of ["inside-source", "external-world-readable"]) {
    const sourceRoot = createSyntheticRepository();
    const outputRoot = mkdtempSync(path.join(tmpdir(), `public-snapshot-instance-${scenario}-`));
    const configRoot = scenario === "inside-source"
      ? sourceRoot
      : mkdtempSync(path.join(tmpdir(), "public-snapshot-instance-unsafe-"));
    const { configPath } = writeSyntheticInstanceConfig(configRoot);
    if (scenario === "external-world-readable") chmodSync(configPath, 0o644);
    let continuityCalls = 0;

    await assert.rejects(
      () => buildPublicSnapshot({
        sourceRoot,
        outputRoot,
        ...writePolicies(outputRoot),
        instanceConfigPath: configPath,
        continuity: {
          async capture() {
            continuityCalls += 1;
            return { healthy: true };
          },
          async compare() {
            continuityCalls += 1;
            return { healthy: true };
          }
        }
      }),
      (error) => {
        assert.equal(error.stage, "policy");
        assert.equal(error.code, "instance-config-invalid");
        assert.doesNotMatch(JSON.stringify(error), /林昭|orchid-operator-private/u);
        return true;
      }
    );
    assert.equal(continuityCalls, 0);
  }
});

test("消费者校验拒绝被修改的 SBOM 或来源记录", async () => {
  for (const artifact of ["sbom.spdx.json", "provenance.intoto.jsonl"]) {
    const sourceRoot = createSyntheticRepository();
    const outputRoot = mkdtempSync(path.join(tmpdir(), `public-candidate-verify-${artifact}-`));
    const result = await buildPublicSnapshot({
      sourceRoot,
      outputRoot,
      ...writePolicies(outputRoot),
      continuity: healthyContinuity()
    });
    const candidatePath = path.join(outputRoot, "candidates", result.candidate_id);
    writeFileSync(
      path.join(candidatePath, artifact),
      `${readFileSync(path.join(candidatePath, artifact), "utf8").trimEnd()}\n{}\n`
    );

    await assert.rejects(
      () => verifyPublicCandidate({ candidatePath }),
      (error) => {
        assert.equal(error.stage, "candidate-verify");
        assert.equal(error.code, "candidate-checksum-mismatch");
        return true;
      }
    );
  }
});

test("插件和 npm 产物只从已扫描候选树生成，不读取私有工作树增量", async () => {
  const sourceRoot = createSyntheticRepository();
  const outputRoot = mkdtempSync(path.join(tmpdir(), "public-artifacts-tree-only-"));
  const policies = writePolicies(outputRoot);
  const privateCanary = ["Private", " Person"].join("");

  const result = await buildPublicSnapshot({
    sourceRoot,
    outputRoot,
    ...policies,
    continuity: healthyContinuity(),
    testHooks: {
      beforeReleaseArtifacts() {
        writeProjectFile(
          sourceRoot,
          "src/private-worktree-only.mjs",
          `export const privateOwner = ${JSON.stringify(privateCanary)};\n`
        );
      }
    }
  });

  const candidate = path.join(outputRoot, "candidates", result.candidate_id);
  for (const [artifact, args] of [
    ["codex-plugin.tar", ["-tf"]],
    ["npm-package.tgz", ["-tzf"]]
  ]) {
    const listing = spawnSync("tar", [...args, path.join(candidate, artifact)], {
      encoding: "utf8"
    });
    assert.equal(listing.status, 0, listing.stderr);
    assert.doesNotMatch(listing.stdout, /private-worktree-only/u);
  }
  assert.equal(
    existsSync(path.join(candidate, "tree", "src/private-worktree-only.mjs")),
    false
  );
});

test("源码、Codex 插件和 npm 包版本不一致时不生成候选", async () => {
  const sourceRoot = createSyntheticRepository();
  writeProjectFile(sourceRoot, ".codex-plugin/plugin.json", `${JSON.stringify({
    name: "fixture-digital-twin",
    version: "1.2.4",
    description: "Synthetic Codex plugin fixture",
    skills: "./skills/"
  })}\n`);
  commitAll(sourceRoot, "mismatched plugin version");
  const outputRoot = mkdtempSync(path.join(tmpdir(), "public-artifacts-version-mismatch-"));

  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot,
      outputRoot,
      ...writePolicies(outputRoot),
      continuity: healthyContinuity()
    }),
    (error) => {
      assert.equal(error.stage, "release-metadata");
      assert.equal(error.code, "release-version-mismatch");
      return true;
    }
  );
  assert.equal(existsSync(path.join(outputRoot, "candidates")), false);
});

test("公共快照拒绝越界、重复、未排序和缺失来源的允许清单", async () => {
  const sourceRoot = createSyntheticRepository();
  const invalidPolicies = [
    {
      name: "absolute",
      mutate(policy) { policy.files[0].path = ["/", "etc/passwd"].join(""); }
    },
    {
      name: "traversal",
      mutate(policy) { policy.files[0].path = "../package.json"; }
    },
    {
      name: "backslash",
      mutate(policy) { policy.files[1].path = "src\\core.mjs"; }
    },
    {
      name: "duplicate",
      mutate(policy) { policy.files[1].path = policy.files[0].path; }
    },
    {
      name: "unsorted",
      mutate(policy) { policy.files.reverse(); }
    },
    {
      name: "private-area",
      mutate(policy) { policy.files[0].path = ".scratch/private.md"; }
    },
    {
      name: "private-area-case-alias",
      mutate(policy) { policy.files[0].path = ".RUNTIME/private.md"; }
    },
    {
      name: "provenance",
      mutate(policy) { policy.files[0].provenance = "unknown"; }
    },
    {
      name: "unused-provenance",
      mutate(policy) {
        policy.provenance.unused = { origin: "project-authored", synthetic: false };
      }
    },
    {
      name: "unknown-origin",
      mutate(policy) {
        policy.provenance.project.origin = "unknown";
      }
    }
  ];

  for (const scenario of invalidPolicies) {
    const outputRoot = mkdtempSync(path.join(tmpdir(), `public-snapshot-policy-${scenario.name}-`));
    const policy = structuredClone(publicPolicy());
    scenario.mutate(policy);
    const { policyPath, privatePolicyPath } = writePolicies(outputRoot, policy);
    let continuityCalls = 0;
    await assert.rejects(
      () => buildPublicSnapshot({
        sourceRoot,
        outputRoot,
        policyPath,
        privatePolicyPath,
        continuity: {
          async capture() {
            continuityCalls += 1;
            return { healthy: true };
          },
          async compare() {
            continuityCalls += 1;
            return { healthy: true };
          }
        }
      }),
      (error) => {
        assert.equal(error.stage, "policy");
        assert.equal(error.code, "public-policy-invalid");
        return true;
      }
    );
    assert.equal(continuityCalls, 0);
    assert.equal(existsSync(path.join(outputRoot, "candidates")), false);
  }
});

test("源文件、暂存树和归档解包任一隐私扫描失败都不会产生候选", async () => {
  const privateLiteral = ["Private", " Person"].join("");
  const scenarios = [
    {
      name: "source-selection",
      prepare(sourceRoot) {
        writeProjectFile(sourceRoot, "src/core.mjs", `export const owner = ${JSON.stringify(privateLiteral)};\n`);
        runGit(sourceRoot, ["add", "src/core.mjs"]);
        runGit(sourceRoot, [
          "-c", "user.name=Fixture Maintainer",
          "-c", "user.email=maintainer@example.invalid",
          "commit", "-qm", "private canary"
        ]);
      }
    },
    {
      name: "staging-tree",
      hooks: {
        afterStagingCopy({ treeRoot }) {
          writeProjectFile(treeRoot, "src/core.mjs", `export const owner = ${JSON.stringify(privateLiteral)};\n`);
        }
      }
    },
    {
      name: "archive-unpacked",
      hooks: {
        async afterArchiveWritten({ sourceRecords, replaceArchive }) {
          const maliciousRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-archive-private-"));
          for (const record of sourceRecords) {
            writeProjectFile(
              maliciousRoot,
              record.path,
              record.path === "src/core.mjs"
                ? `export const owner = ${JSON.stringify(privateLiteral)};\n`
                : readFileSync(path.join(this.sourceRoot, record.path))
            );
          }
          const records = sourceRecords.map((record) => ({
            ...record,
            bytes: statSync(path.join(maliciousRoot, record.path)).size
          }));
          await replaceArchive({ treeRoot: maliciousRoot, records });
        }
      }
    },
    {
      name: "plugin-unpacked",
      hooks: {
        async afterPluginArtifactWritten({ sourceRecords, replacePluginArtifact }) {
          const maliciousRoot = mkdtempSync(path.join(tmpdir(), "public-plugin-private-"));
          for (const record of sourceRecords) {
            writeProjectFile(
              maliciousRoot,
              record.path,
              record.path === "src/core.mjs"
                ? `export const owner = ${JSON.stringify(privateLiteral)};\n`
                : readFileSync(path.join(this.sourceRoot, record.path))
            );
          }
          const records = sourceRecords.map((record) => ({
            ...record,
            bytes: statSync(path.join(maliciousRoot, record.path)).size
          }));
          await replacePluginArtifact({ treeRoot: maliciousRoot, records });
        }
      }
    },
    {
      name: "npm-unpacked",
      hooks: {
        async afterNpmArtifactWritten({ sourceRecords, replaceNpmArtifact }) {
          const maliciousRoot = mkdtempSync(path.join(tmpdir(), "public-npm-private-"));
          for (const record of sourceRecords) {
            writeProjectFile(
              maliciousRoot,
              record.path,
              record.path === "src/core.mjs"
                ? `export const owner = ${JSON.stringify(privateLiteral)};\n`
                : readFileSync(path.join(this.sourceRoot, record.path))
            );
          }
          const records = sourceRecords.map((record) => ({
            ...record,
            bytes: statSync(path.join(maliciousRoot, record.path)).size
          }));
          await replaceNpmArtifact({ treeRoot: maliciousRoot, records });
        }
      }
    },
    {
      name: "candidate-metadata",
      hooks: {
        afterMetadataWritten({ manifestPath }) {
          writeFileSync(
            manifestPath,
            `${readFileSync(manifestPath, "utf8").trimEnd()}\n${privateLiteral}\n`
          );
        }
      }
    }
  ];

  for (const scenario of scenarios) {
    const sourceRoot = createSyntheticRepository();
    scenario.prepare?.(sourceRoot);
    const outputRoot = mkdtempSync(path.join(tmpdir(), `public-snapshot-private-${scenario.name}-`));
    const { policyPath, privatePolicyPath } = writePolicies(outputRoot);
    if (
      scenario.hooks?.afterArchiveWritten ||
      scenario.hooks?.afterPluginArtifactWritten ||
      scenario.hooks?.afterNpmArtifactWritten
    ) {
      scenario.hooks.sourceRoot = sourceRoot;
    }
    await assert.rejects(
      () => buildPublicSnapshot({
        sourceRoot,
        outputRoot,
        policyPath,
        privatePolicyPath,
        continuity: healthyContinuity(),
        testHooks: scenario.hooks
      }),
      (error) => {
        assert.equal(error.code, "privacy-scan-failed");
        assert.equal(error.stage, scenario.name);
        return true;
      }
    );
    assert.equal(existsSync(path.join(outputRoot, "candidates")), false);
    assert.equal(
      readdirSync(outputRoot).some((entry) => entry.startsWith(".attempt-")),
      false
    );
    if (scenario.name !== "source-selection") {
      const failures = readdirSync(path.join(outputRoot, "failures"));
      assert.equal(failures.length, 1);
      const receipt = readFileSync(path.join(outputRoot, "failures", failures[0]), "utf8");
      assert.doesNotMatch(receipt, new RegExp(privateLiteral, "u"));
      assert.doesNotMatch(receipt, /\/Users\/|\/private\/var\//u);
    }
  }
});

test("源选择拒绝未跟踪、脏文件、符号链接和 Git LFS 指针", async () => {
  const scenarios = [
    {
      name: "untracked",
      expected: "source-not-tracked",
      prepare(sourceRoot, policy) {
        writeProjectFile(sourceRoot, "src/untracked.mjs", "export const value = 1;\n");
        policy.files.push({ path: "src/untracked.mjs", provenance: "project" });
        policy.files.sort((left, right) => left.path.localeCompare(right.path, "en"));
      }
    },
    {
      name: "dirty",
      expected: "source-file-dirty",
      prepare(sourceRoot) {
        writeProjectFile(sourceRoot, "src/core.mjs", "export const changed = true;\n");
      }
    },
    {
      name: "staged",
      expected: "source-file-dirty",
      prepare(sourceRoot) {
        writeProjectFile(sourceRoot, "src/core.mjs", "export const staged = true;\n");
        runGit(sourceRoot, ["add", "src/core.mjs"]);
      }
    },
    {
      name: "symlink",
      expected: "source-not-regular-file",
      prepare(sourceRoot) {
        unlinkSync(path.join(sourceRoot, "src/core.mjs"));
        symlinkSync("../package.json", path.join(sourceRoot, "src/core.mjs"));
      }
    },
    {
      name: "parent-symlink-to-runtime",
      expected: "source-parent-symlink",
      prepare(sourceRoot) {
        writeProjectFile(
          sourceRoot,
          ".runtime/core.mjs",
          readFileSync(path.join(sourceRoot, "src/core.mjs"))
        );
        unlinkSync(path.join(sourceRoot, "src/core.mjs"));
        rmdirSync(path.join(sourceRoot, "src"));
        symlinkSync(".runtime", path.join(sourceRoot, "src"), "dir");
      }
    },
    {
      name: "lfs",
      expected: "git-lfs-pointer",
      prepare(sourceRoot) {
        writeProjectFile(
          sourceRoot,
          "src/core.mjs",
          "version https://git-lfs.github.com/spec/v1\noid sha256:fixture\nsize 42\n"
        );
        commitAll(sourceRoot, "lfs pointer");
      }
    },
    {
      name: "assume-unchanged",
      expected: "source-index-flags",
      prepare(sourceRoot) {
        runGit(sourceRoot, ["update-index", "--assume-unchanged", "src/core.mjs"]);
        writeProjectFile(sourceRoot, "src/core.mjs", "export const hiddenChange = true;\n");
      }
    },
    {
      name: "skip-worktree",
      expected: "source-index-flags",
      prepare(sourceRoot) {
        runGit(sourceRoot, ["update-index", "--skip-worktree", "src/core.mjs"]);
        writeProjectFile(sourceRoot, "src/core.mjs", "export const hiddenChange = true;\n");
      }
    },
    {
      name: "assume-and-skip",
      expected: "source-index-flags",
      prepare(sourceRoot) {
        runGit(sourceRoot, ["update-index", "--assume-unchanged", "src/core.mjs"]);
        runGit(sourceRoot, ["update-index", "--skip-worktree", "src/core.mjs"]);
        writeProjectFile(sourceRoot, "src/core.mjs", "export const hiddenChange = true;\n");
      }
    },
    {
      name: "unsafe-mode",
      expected: "source-unsafe-mode",
      prepare(sourceRoot) {
        chmodSync(path.join(sourceRoot, "src/core.mjs"), 0o666);
      }
    },
    {
      name: "replace-object",
      expected: "source-file-dirty",
      prepare(sourceRoot) {
        writeProjectFile(sourceRoot, "src/core.mjs", "export const replacementTree = true;\n");
        commitAll(sourceRoot, "replacement tree");
        const replacementCommit = runGit(sourceRoot, ["rev-parse", "HEAD"]);
        runGit(sourceRoot, ["reset", "--hard", "HEAD^"]);
        runGit(sourceRoot, ["replace", "HEAD", replacementCommit]);
        runGit(sourceRoot, ["reset", "--hard", "HEAD"]);
      }
    },
    {
      name: "index-lock",
      expected: "source-repository-busy",
      prepare(sourceRoot) {
        writeProjectFile(sourceRoot, ".git/index.lock", "");
      }
    }
  ];

  for (const scenario of scenarios) {
    const sourceRoot = createSyntheticRepository();
    const policy = structuredClone(publicPolicy());
    scenario.prepare(sourceRoot, policy);
    const outputRoot = mkdtempSync(path.join(tmpdir(), `public-snapshot-source-${scenario.name}-`));
    const { policyPath, privatePolicyPath } = writePolicies(outputRoot, policy);
    await assert.rejects(
      () => buildPublicSnapshot({
        sourceRoot,
        outputRoot,
        policyPath,
        privatePolicyPath,
        continuity: healthyContinuity()
      }),
      (error) => {
        assert.equal(error.stage, "source-selection");
        assert.equal(error.code, scenario.expected);
        return true;
      }
    );
    assert.equal(existsSync(path.join(outputRoot, "candidates")), false);
  }
});

test("源选择按字面路径处理、忽略清单外漂移并隔离 Git 环境覆盖", { concurrency: false }, async () => {
  const sourceRoot = createSyntheticRepository();
  writeProjectFile(sourceRoot, "src/literal[ab].mjs", "export const literal = true;\n");
  writeProjectFile(sourceRoot, "src/literala.mjs", "export const decoyA = true;\n");
  writeProjectFile(sourceRoot, "src/literalb.mjs", "export const decoyB = true;\n");
  commitAll(sourceRoot, "literal path fixtures");
  writeProjectFile(sourceRoot, "src/literala.mjs", "export const unrelatedDirty = true;\n");
  writeProjectFile(sourceRoot, "src/untracked-outside-policy.mjs", "export const ignored = true;\n");

  const policy = structuredClone(publicPolicy());
  policy.files.push({ path: "src/literal[ab].mjs", provenance: "project" });
  policy.files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const outputRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-literal-path-"));
  const policies = writePolicies(outputRoot, policy);
  const previousIndexFile = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = path.join(outputRoot, "attacker-controlled-index");
  try {
    const result = await buildPublicSnapshot({
      sourceRoot,
      outputRoot,
      ...policies,
      continuity: healthyContinuity()
    });
    const treeRoot = path.join(outputRoot, "candidates", result.candidate_id, "tree");
    assert.equal(existsSync(path.join(treeRoot, "src/literal[ab].mjs")), true);
    assert.equal(existsSync(path.join(treeRoot, "src/literala.mjs")), false);
    assert.equal(existsSync(path.join(treeRoot, "src/literalb.mjs")), false);
    assert.equal(existsSync(path.join(treeRoot, "src/untracked-outside-policy.mjs")), false);
  } finally {
    if (previousIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndexFile;
  }
});

test("源扫描后父目录被替换为私有运行态链接时失败关闭", async () => {
  const sourceRoot = createSyntheticRepository();
  const outputRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-source-race-"));
  const policies = writePolicies(outputRoot);
  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot,
      outputRoot,
      ...policies,
      continuity: healthyContinuity(),
      testHooks: {
        afterSourceScan() {
          writeProjectFile(
            sourceRoot,
            ".runtime/core.mjs",
            readFileSync(path.join(sourceRoot, "src/core.mjs"))
          );
          unlinkSync(path.join(sourceRoot, "src/core.mjs"));
          rmdirSync(path.join(sourceRoot, "src"));
          symlinkSync(".runtime", path.join(sourceRoot, "src"), "dir");
        }
      }
    }),
    (error) => {
      assert.equal(error.stage, "source-selection");
      assert.equal(error.code, "source-parent-symlink");
      return true;
    }
  );
  assert.equal(existsSync(path.join(outputRoot, "candidates")), false);
});

test("允许清单中的大文件不会被 Git 输出缓冲上限误拒绝", async () => {
  const sourceRoot = createSyntheticRepository();
  const largeContent = `export const payload = ${JSON.stringify("a".repeat(6 * 1024 * 1024))};\n`;
  writeProjectFile(sourceRoot, "src/large-fixture.mjs", largeContent);
  commitAll(sourceRoot, "large source fixture");
  const policy = structuredClone(publicPolicy());
  policy.files.push({ path: "src/large-fixture.mjs", provenance: "synthetic" });
  policy.files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  policy.limits.max_total_bytes = 8 * 1024 * 1024;
  const outputRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-large-source-"));
  const result = await buildPublicSnapshot({
    sourceRoot,
    outputRoot,
    ...writePolicies(outputRoot, policy),
    continuity: healthyContinuity()
  });
  assert.equal(result.file_count, 5);
});

test("Git SHA-256 仓库可生成候选且仍拒绝脏文件", async (t) => {
  const probeRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-sha256-probe-"));
  const probe = spawnSync("git", ["init", "-q", "--object-format=sha256"], {
    cwd: probeRoot,
    encoding: "utf8"
  });
  if (probe.status !== 0) {
    t.skip("installed Git does not support SHA-256 repositories");
    return;
  }
  const sourceRoot = createSyntheticRepository({ objectFormat: "sha256" });
  const outputRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-sha256-"));
  const result = await buildPublicSnapshot({
    sourceRoot,
    outputRoot,
    ...writePolicies(outputRoot),
    continuity: healthyContinuity()
  });
  assert.match(result.candidate_id, /^sha256-[a-f0-9]{64}$/u);

  writeProjectFile(sourceRoot, "src/core.mjs", "export const sha256Dirty = true;\n");
  const dirtyOutput = mkdtempSync(path.join(tmpdir(), "public-snapshot-sha256-dirty-"));
  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot,
      outputRoot: dirtyOutput,
      ...writePolicies(dirtyOutput),
      continuity: healthyContinuity()
    }),
    (error) => {
      assert.equal(error.stage, "source-selection");
      assert.equal(error.code, "source-file-dirty");
      return true;
    }
  );
});

test("扫描器拒绝 Secret、PII、私有域名、本机路径和真实飞书 ID 形状", async () => {
  const canaries = [
    {
      name: "secret",
      code: "known-secret-shape",
      value: ["sk", "-", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("")
    },
    {
      name: "github-pat",
      code: "known-secret-shape",
      value: ["github", "_pat_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("")
    },
    {
      name: "bearer",
      code: "known-secret-shape",
      value: ["Authorization", ": Bearer ", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("")
    },
    {
      name: "basic-auth",
      code: "known-secret-shape",
      value: ["Authorization", ": Basic ", "QWxhZGRpbjpvcGVuIHNlc2FtZQ=="].join("")
    },
    {
      name: "json-bearer",
      code: "known-secret-shape",
      content: `${JSON.stringify({
        Authorization: ["Bearer", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join(" ")
      })}\n`
    },
    {
      name: "json-basic",
      code: "known-secret-shape",
      content: `${JSON.stringify({
        authorization: ["Basic", "QWxhZGRpbjpvcGVuIHNlc2FtZQ=="].join(" ")
      })}\n`
    },
    {
      name: "cli-base-token",
      code: "known-secret-shape",
      content: [
        "lark-cli base +record-list --base-token ",
        "OpaqueBaseCredentialA1b2C3d4E5f6",
        "\n"
      ].join("")
    },
    {
      name: "punctuation-password",
      code: "high-entropy-credential",
      value: ["password", "=", "N3v!@#$%^&*()_+=-Z9q"].join("")
    },
    {
      name: "password-with-test-segment",
      code: "high-entropy-credential",
      value: ["password", "=", "N3v_test_Material_A1b2C3d4E5f6"].join("")
    },
    {
      name: "email",
      code: "email-address",
      value: ["person", "@", "mail.example.com"].join("")
    },
    {
      name: "phone",
      code: "phone-number",
      value: ["138", "0013", "8000"].join("")
    },
    {
      name: "mainland-id",
      code: "chinese-id-number",
      value: ["110105", "19491231", "002X"].join("")
    },
    {
      name: "domain",
      code: "private-domain",
      value: ["https://portal.", "corp", ".internal", "/entry"].join("")
    },
    {
      name: "path",
      code: "absolute-local-path",
      value: ["/", "Users", "/", "alice", "/", "private-project"].join("")
    },
    {
      name: "synthetic-looking-home",
      code: "absolute-local-path",
      value: ["/", "Users", "/", "test", "/", "private-project"].join("")
    },
    {
      name: "temp-path",
      code: "absolute-local-path",
      value: ["/", "private/var/folders/ab/cdef0123456789abcdef0123456789/T/private-output"].join("")
    },
    {
      name: "synthetic-looking-temp-path",
      code: "absolute-local-path",
      value: ["/", "private/var/folders/fixture-output"].join("")
    },
    {
      name: "home-key-path",
      code: "absolute-local-path",
      value: ["HOME=", "/", "home", "/", "alice", "/", ".ssh", "/", "id_rsa"].join("")
    },
    {
      name: "yaml-home-path",
      code: "absolute-local-path",
      value: ["home: ", "/", "home", "/", "alice", "/", ".ssh", "/", "id_rsa"].join("")
    },
    {
      name: "unicode-path",
      code: "absolute-local-path",
      value: ["cwd=", "/", "Users", "/", "alice", "/", "私有目录"].join("")
    },
    {
      name: "windows-path",
      code: "absolute-local-path",
      value: ["C:", "\\", "Users\\alice\\private-project"].join("")
    },
    {
      name: "windows-legacy-home",
      code: "absolute-local-path",
      value: ["C:", "\\", "Documents and Settings\\alice\\private-project"].join("")
    },
    {
      name: "windows-forward-legacy-home",
      code: "absolute-local-path",
      value: ["C:", "/", "Documents and Settings/alice/private-project"].join("")
    },
    {
      name: "markdown-path",
      code: "absolute-local-path",
      value: ["`", "/", "private/var/folders/ab/cdef0123456789abcdef0123456789/T/private-output", "`"].join("")
    },
    {
      name: "markdown-angle-path-with-spaces",
      code: "absolute-local-path",
      value: ["[report](<", "/", "Users/alice/My Project/report.md>)"].join("")
    },
    {
      name: "markdown-volume-path-with-spaces",
      code: "absolute-local-path",
      value: ["[report](<", "/", "Volumes/Company Drive/private.xlsx>)"].join("")
    },
    {
      name: "markdown-angle-path-with-title",
      code: "absolute-local-path",
      value: ["[report](<", "/", "Users/alice/My Project/report.md> \"local\")"].join("")
    },
    {
      name: "html-code-path",
      code: "absolute-local-path",
      value: ["<code>", "/", "Users/alice/private-project</code>"].join("")
    },
    {
      name: "shell-semicolon-path",
      code: "absolute-local-path",
      value: ["cd;", "/", "Users/alice/private-project"].join("")
    },
    {
      name: "file-url-path",
      code: "absolute-local-path",
      value: ["file", "://", "/", "Users/alice/private-output"].join("")
    },
    {
      name: "file-url-remote-share",
      code: "absolute-local-path",
      value: ["file", "://", "server/share/private-output"].join("")
    },
    {
      name: "file-url-slash-unc",
      code: "absolute-local-path",
      value: ["file", "://", "//server/share/private-output"].join("")
    },
    {
      name: "unc-path",
      code: "absolute-local-path",
      value: ["\\\\", "fixture-server", "\\", "share", "\\", "private-project"].join("")
    },
    {
      name: "feishu-id",
      code: "feishu-resource-identifier",
      value: ["ou_", "A".repeat(20)].join("")
    },
    {
      name: "feishu-folder-token",
      code: "feishu-resource-identifier",
      value: ["fld", "A1b2C3d4E5f6G7h8I9j0"].join("")
    },
    {
      name: "feishu-base-token",
      code: "feishu-resource-identifier",
      value: ["bascn", "A1b2C3d4E5f6G7h8I9j0"].join("")
    },
    {
      name: "feishu-legacy-base-token",
      code: "feishu-resource-identifier",
      value: ["bas", "A1b2C3d4E5f6G7h8I9j0"].join("")
    },
    {
      name: "feishu-letter-only-token",
      code: "feishu-resource-identifier",
      value: ["fld", "AbCdEfGhIjKlMnOpQrStUv"].join("")
    },
    {
      name: "feishu-modern-wiki-url",
      code: "feishu-resource-identifier",
      value: [
        "https://example.feishu.cn/wiki/",
        "AbCdEfGhIjKlMnOpQrStUvWxYz"
      ].join("")
    },
    {
      name: "lark-modern-docx-url",
      code: "feishu-resource-identifier",
      value: [
        "https://example.larksuite.com/docx/",
        "ZyXwVuTsRqPoNmLkJiHgFeDcBa"
      ].join("")
    }
  ];

  for (const canary of canaries) {
    const sourceRoot = createSyntheticRepository();
    writeProjectFile(
      sourceRoot,
      "src/core.mjs",
      canary.content ?? `export const canary = ${JSON.stringify(canary.value)};\n`
    );
    commitAll(sourceRoot, `canary ${canary.name}`);
    const outputRoot = mkdtempSync(path.join(tmpdir(), `public-snapshot-canary-${canary.name}-`));
    const { policyPath, privatePolicyPath } = writePolicies(outputRoot);
    await assert.rejects(
      () => buildPublicSnapshot({
        sourceRoot,
        outputRoot,
        policyPath,
        privatePolicyPath,
        continuity: healthyContinuity()
      }),
      (error) => {
        assert.equal(error.code, "privacy-scan-failed");
        assert.equal(error.stage, "source-selection");
        assert.equal(error.finding_codes.includes(canary.code), true);
        return true;
      }
    );
  }
});

test("扫描器允许标准系统路径、临时目录、拆分合成标识和源码表达式", async () => {
  const report = await scanPublicBuffers({
    files: [{
      path: "tests/fixture.mjs",
      content: Buffer.from([
        "const paths = ['/bin/launchctl', '/usr/bin/git', '/opt/homebrew/bin', '/dev/null', '/tmp/test-output'];",
        "const fixturePath = ['/', 'Users', '/', 'fixture-owner', '/private-evidence'].join('');",
        "const localFile = 'file:///usr/bin/node';",
        "const ignoredFiles = ['.env.local'];",
        "const messageId = ['om_', 'fixturemessage000000'].join('');",
        "const folderToken = 'fixture_daily_memory_folder';",
        "const token = config.daily_memory.folder_token;",
        "const optionalToken = config.daily_memory?.folder_token;",
        "const delegatedToken = folderToken;",
        "const API_KEY = process.env.OPENAI_API_KEY;",
        "const secret = vault(A1b2C3d4E5f6G7h8I9j0);",
        "const continuityPathArgument = true;"
      ].join("\n"))
    }],
    policy: {
      schema_version: 1,
      forbidden_literals: ["fixture-private-identity"],
      private_domains: []
    },
    stage: "scanner-public-fixtures"
  });

  assert.deepEqual(report.findings, []);

  const environmentReport = await scanPublicBuffers({
    files: [{
      path: ".env",
      content: Buffer.from([
        "password",
        "=",
        "vault(",
        "A1b2C3d4E5f6G7h8I9j0",
        ")"
      ].join(""))
    }],
    policy: {
      schema_version: 1,
      forbidden_literals: ["fixture-private-identity"],
      private_domains: []
    },
    stage: "scanner-non-code-expression"
  });
  assert.equal(
    environmentReport.findings.some((finding) => finding.code === "high-entropy-credential"),
    true
  );
});

test("候选元数据不把完整 SHA-256 摘要中的数字片段误判为个人标识", async () => {
  const phoneLikeDigits = ["138", "0013", "8000"].join("");
  const idLikeDigits = ["110105", "19491231", "0021"].join("");
  const phoneDigest = `${"a".repeat(20)}${phoneLikeDigits}${"b".repeat(33)}`;
  const idDigest = `${"a".repeat(15)}${idLikeDigits}${"b".repeat(31)}`;
  const report = await scanPublicBuffers({
    files: [
      {
        path: "SHA256SUMS",
        content: Buffer.from(`${phoneDigest}  tree/README.md\n`)
      },
      {
        path: "provenance.intoto.jsonl",
        content: Buffer.from(`${JSON.stringify({ digest: idDigest })}\n`)
      },
      {
        path: "sbom.spdx.json",
        content: Buffer.from(`${JSON.stringify({ checksum: phoneDigest })}\n`)
      },
      {
        path: "snapshot-manifest.json",
        content: Buffer.from(`${JSON.stringify({ sha256: idDigest })}\n`)
      }
    ],
    policy: {
      schema_version: 1,
      forbidden_literals: ["fixture-private-identity"],
      private_domains: []
    },
    stage: "candidate-metadata"
  });

  assert.deepEqual(report.findings, []);
});

test("SHA-256 元数据例外不放宽其他阶段、边界长度或独立个人标识", async () => {
  const phoneLikeDigits = ["138", "0013", "8000"].join("");
  const idLikeDigits = ["110105", "19491231", "0021"].join("");
  const exactDigest = `${"a".repeat(20)}${phoneLikeDigits}${"b".repeat(33)}`;
  const shortDigest = `${"a".repeat(19)}${phoneLikeDigits}${"b".repeat(33)}`;
  const longDigest = `${"a".repeat(21)}${phoneLikeDigits}${"b".repeat(33)}`;
  const policy = {
    schema_version: 1,
    forbidden_literals: ["fixture-private-identity"],
    private_domains: []
  };
  const scanOne = async ({ path: relativePath, content, stage = "candidate-metadata" }) => (
    scanPublicBuffers({
      files: [{ path: relativePath, content: Buffer.from(content) }],
      policy,
      stage
    })
  );
  const assertFinding = async (fixture, expectedCode) => {
    const report = await scanOne(fixture);
    assert.deepEqual(report.findings.map((finding) => finding.code), [expectedCode]);
  };

  await assertFinding({ path: "SHA256SUMS", content: shortDigest }, "phone-number");
  await assertFinding({ path: "SHA256SUMS", content: longDigest }, "phone-number");
  await assertFinding({ path: "SHA256SUMS", content: phoneLikeDigits }, "phone-number");
  await assertFinding({ path: "SHA256SUMS", content: idLikeDigits }, "chinese-id-number");
  await assertFinding({ path: "src/digest.txt", content: exactDigest }, "phone-number");
  await assertFinding(
    { path: "SHA256SUMS", content: exactDigest, stage: "source-selection" },
    "phone-number"
  );
});

test("扫描器允许合法源码正则字面量通过自身检查", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-regex-fixture-"));
  writeFileSync(
    path.join(fixtureRoot, "route.mjs"),
    "export const matchesRoute = (value) => /api\\/v1/u.test(value);\n"
  );
  const report = await scanPublicFiles({
    root: process.cwd(),
    files: ["ops/public-content-scan.mjs", "ops/public-snapshot.mjs"],
    policy: {
      schema_version: 1,
      forbidden_literals: ["fixture-private-identity"],
      private_domains: []
    },
    stage: "scanner-self-check"
  });
  assert.deepEqual(report.findings, []);
  const fixtureReport = await scanPublicFiles({
    root: fixtureRoot,
    files: ["route.mjs"],
    policy: {
      schema_version: 1,
      forbidden_literals: ["fixture-private-identity"],
      private_domains: []
    },
    stage: "scanner-regex-fixture"
  });
  assert.deepEqual(fixtureReport.findings, []);
});

test("连续性前门不健康时不创建尝试，后门退化时不晋升候选", async () => {
  const sourceRoot = createSyntheticRepository();
  const beforeOutput = mkdtempSync(path.join(tmpdir(), "public-snapshot-continuity-before-"));
  const beforePolicies = writePolicies(beforeOutput);
  let beforeCompareCalls = 0;
  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot,
      outputRoot: beforeOutput,
      ...beforePolicies,
      continuity: {
        async capture() { return { healthy: false, violations: [{ code: "fixture" }] }; },
        async compare() {
          beforeCompareCalls += 1;
          return { healthy: true };
        }
      }
    }),
    (error) => {
      assert.equal(error.stage, "continuity-before");
      assert.equal(error.code, "continuity-before-failed");
      return true;
    }
  );
  assert.equal(beforeCompareCalls, 0);
  assert.equal(readdirSync(beforeOutput).some((entry) => entry.startsWith(".attempt-")), false);
  assert.equal(existsSync(path.join(beforeOutput, "candidates")), false);

  const afterOutput = mkdtempSync(path.join(tmpdir(), "public-snapshot-continuity-after-"));
  const afterPolicies = writePolicies(afterOutput);
  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot,
      outputRoot: afterOutput,
      ...afterPolicies,
      continuity: {
        async capture() { return { healthy: true, baseline: { marker: "before" } }; },
        async compare(baseline) {
          assert.equal(baseline.marker, "before");
          return {
            healthy: false,
            current_captured_at: ["/", "Users", "/", "fixture-owner", "/private-evidence"].join(""),
            violations: [
              { code: "service-regressed" },
              { code: `ou_${"A".repeat(20)}` }
            ]
          };
        }
      }
    }),
    (error) => {
      assert.equal(error.stage, "continuity-after");
      assert.equal(error.code, "continuity-after-failed");
      return true;
    }
  );
  assert.equal(readdirSync(afterOutput).some((entry) => entry.startsWith(".attempt-")), false);
  assert.equal(existsSync(path.join(afterOutput, "candidates")), false);
  const afterFailures = readdirSync(path.join(afterOutput, "failures"));
  assert.equal(afterFailures.length, 1);
  const afterFailurePath = path.join(afterOutput, "failures", afterFailures[0]);
  const afterFailure = JSON.parse(readFileSync(afterFailurePath, "utf8"));
  assert.equal(statSync(afterFailurePath).mode & 0o777, 0o600);
  assert.match(afterFailure.public_policy_sha256, /^[a-f0-9]{64}$/u);
  assert.match(afterFailure.private_policy_sha256, /^[a-f0-9]{64}$/u);
  assert.match(afterFailure.manifest_sha256, /^[a-f0-9]{64}$/u);
  assert.match(afterFailure.continuity.before.evidence_sha256, /^[a-f0-9]{64}$/u);
  assert.match(afterFailure.continuity.after.evidence_sha256, /^[a-f0-9]{64}$/u);
  assert.match(afterFailure.continuity.before.source_evidence_sha256, /^[a-f0-9]{64}$/u);
  assert.match(afterFailure.continuity.after.source_evidence_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(afterFailure.continuity.after.captured_at, null);
  assert.deepEqual(afterFailure.continuity.after.violation_codes, [
    "redacted-violation-code",
    "service-regressed"
  ]);
  assert.doesNotMatch(JSON.stringify(afterFailure), /"marker"|\/Users\/|\/private\/var\//u);
});

test("快照自身失败后仍执行连续性后检并保留原始失败码", async () => {
  const sourceRoot = createSyntheticRepository();
  const outputRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-failure-continuity-"));
  const policies = writePolicies(outputRoot);
  const calls = [];
  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot,
      outputRoot,
      ...policies,
      continuity: {
        async capture() {
          calls.push("capture");
          return { healthy: true, baseline: { marker: "before" } };
        },
        async compare(baseline) {
          calls.push(["compare", baseline.marker]);
          return { healthy: false, violations: [{ code: "fixture-regression" }] };
        }
      },
      testHooks: {
        afterStagingCopy({ treeRoot }) {
          writeProjectFile(treeRoot, "src/core.mjs", "export const safeButChanged = true;\n");
        }
      }
    }),
    (error) => {
      assert.equal(error.stage, "staging-tree");
      assert.equal(error.code, "staging-tree-content-drift");
      assert.deepEqual(error.secondary_codes, ["continuity-after-failed"]);
      return true;
    }
  );
  assert.deepEqual(calls, ["capture", ["compare", "before"]]);
  const failure = JSON.parse(readFileSync(
    path.join(outputRoot, "failures", readdirSync(path.join(outputRoot, "failures"))[0]),
    "utf8"
  ));
  assert.deepEqual(failure.codes, ["continuity-after-failed", "staging-tree-content-drift"]);
});

test("连续性后检期间发生候选漂移时不会晋升", async () => {
  const sourceRoot = createSyntheticRepository();
  const outputRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-late-drift-"));
  const policies = writePolicies(outputRoot);
  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot,
      outputRoot,
      ...policies,
      continuity: {
        async capture() {
          return { healthy: true, baseline: { marker: "before" } };
        },
        async compare() {
          const attempt = readdirSync(outputRoot).find((entry) => entry.startsWith(".attempt-"));
          assert.equal(typeof attempt, "string");
          writeProjectFile(
            path.join(outputRoot, attempt),
            "late-private-note.txt",
            ["Private", " Person", "\n"].join("")
          );
          return { healthy: true, violations: [] };
        }
      }
    }),
    (error) => {
      assert.equal(error.stage, "candidate-metadata");
      assert.equal(error.code, "candidate-layout-drift");
      return true;
    }
  );
  assert.equal(existsSync(path.join(outputRoot, "candidates")), false);
  assert.equal(readdirSync(outputRoot).some((entry) => entry.startsWith(".attempt-")), false);
});

test("清理所有权证据损坏时明确记录 cleanup-failed", async () => {
  const sourceRoot = createSyntheticRepository();
  const outputRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-cleanup-failure-"));
  const policies = writePolicies(outputRoot);
  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot,
      outputRoot,
      ...policies,
      continuity: healthyContinuity(),
      testHooks: {
        afterStagingCopy({ treeRoot }) {
          const ownerMarker = readdirSync(outputRoot).find((entry) => entry.endsWith(".owner.json"));
          assert.equal(typeof ownerMarker, "string");
          writeFileSync(path.join(outputRoot, ownerMarker), "not-json\n");
          writeProjectFile(
            treeRoot,
            "src/core.mjs",
            `export const owner = ${JSON.stringify(["Private", " Person"].join(""))};\n`
          );
        }
      }
    }),
    (error) => {
      assert.equal(error.stage, "staging-tree");
      assert.equal(error.code, "privacy-scan-failed");
      assert.deepEqual(error.secondary_codes, ["cleanup-failed"]);
      return true;
    }
  );
  assert.equal(readdirSync(outputRoot).some((entry) => entry.startsWith(".attempt-")), true);
  const failureName = readdirSync(path.join(outputRoot, "failures"))[0];
  const failure = JSON.parse(readFileSync(path.join(outputRoot, "failures", failureName), "utf8"));
  assert.equal(failure.cleanup_status, "failed");
  assert.equal(failure.quarantined, false);
  assert.equal(failure.codes.includes("cleanup-failed"), true);
});

test("attestation 先持久化且最终候选 rename 是最后提交边界", async () => {
  const sourceRoot = createSyntheticRepository();
  const outputRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-promotion-rollback-"));
  const policies = writePolicies(outputRoot);
  let promotionBoundaryObserved = false;
  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot,
      outputRoot,
      ...policies,
      continuity: healthyContinuity(),
      testHooks: {
        beforeCandidatePromoted({ candidatePath, candidateId }) {
          promotionBoundaryObserved = true;
          assert.equal(existsSync(candidatePath), false);
          const receiptNames = readdirSync(path.join(outputRoot, "receipts"));
          assert.equal(receiptNames.length, 1);
          const receipt = JSON.parse(readFileSync(
            path.join(outputRoot, "receipts", receiptNames[0]),
            "utf8"
          ));
          assert.equal(receipt.status, "attested");
          assert.equal(receipt.candidate_id, candidateId);
          throw new Error("synthetic promotion interruption");
        }
      }
    }),
    (error) => {
      assert.equal(error.stage, "promotion");
      assert.equal(error.code, "snapshot-build-failed");
      return true;
    }
  );
  assert.equal(promotionBoundaryObserved, true);
  assert.equal(readdirSync(outputRoot).some((entry) => entry.startsWith(".attempt-")), false);
  assert.equal(existsSync(path.join(outputRoot, "candidates"))
    ? readdirSync(path.join(outputRoot, "candidates")).length
    : 0, 0);
  assert.equal(existsSync(path.join(outputRoot, "receipts"))
    ? readdirSync(path.join(outputRoot, "receipts")).length
    : 0, 0);
  const failureName = readdirSync(path.join(outputRoot, "failures"))[0];
  const failure = JSON.parse(readFileSync(path.join(outputRoot, "failures", failureName), "utf8"));
  assert.equal(failure.cleanup_status, "removed");
});

test("最终晋升前的终态连续性失败不会留下候选或 attestation", async () => {
  const sourceRoot = createSyntheticRepository();
  const outputRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-final-continuity-"));
  const policies = writePolicies(outputRoot);
  let compareCalls = 0;
  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot,
      outputRoot,
      ...policies,
      continuity: {
        async capture() {
          return { healthy: true, baseline: { marker: "before" } };
        },
        async compare() {
          compareCalls += 1;
          if (compareCalls === 2) {
            return { healthy: false, violations: [{ code: "post-promotion-regression" }] };
          }
          return { healthy: true, violations: [] };
        }
      }
    }),
    (error) => {
      assert.equal(error.stage, "continuity-after");
      assert.equal(error.code, "continuity-after-failed");
      return true;
    }
  );
  assert.equal(compareCalls, 3);
  assert.equal(existsSync(path.join(outputRoot, "candidates"))
    ? readdirSync(path.join(outputRoot, "candidates")).length
    : 0, 0);
  assert.equal(existsSync(path.join(outputRoot, "receipts"))
    ? readdirSync(path.join(outputRoot, "receipts")).length
    : 0, 0);
  const failureName = readdirSync(path.join(outputRoot, "failures"))[0];
  const failure = JSON.parse(readFileSync(path.join(outputRoot, "failures", failureName), "utf8"));
  assert.equal(failure.cleanup_status, "removed");
  assert.equal(failure.codes.includes("continuity-after-failed"), true);
});

test("固定候选、receipt 和失败目录使用符号链接时拒绝越界", async () => {
  const scenarios = [
    { directory: "candidates", failureCode: "output-subdirectory-unsafe" },
    { directory: "receipts", failureCode: "output-subdirectory-unsafe" },
    {
      directory: "failures",
      failureCode: "staging-tree-content-drift",
      hooks: {
        afterStagingCopy({ treeRoot }) {
          writeProjectFile(treeRoot, "src/core.mjs", "export const safeButChanged = true;\n");
        }
      }
    }
  ];

  for (const scenario of scenarios) {
    const sourceRoot = createSyntheticRepository();
    const outputRoot = mkdtempSync(path.join(tmpdir(), `public-snapshot-link-${scenario.directory}-`));
    const outside = mkdtempSync(path.join(tmpdir(), `public-snapshot-link-target-${scenario.directory}-`));
    symlinkSync(outside, path.join(outputRoot, scenario.directory), "dir");
    const policies = writePolicies(outputRoot);
    await assert.rejects(
      () => buildPublicSnapshot({
        sourceRoot,
        outputRoot,
        ...policies,
        continuity: healthyContinuity(),
        testHooks: scenario.hooks
      }),
      (error) => {
        assert.equal(error.code, scenario.failureCode);
        return true;
      }
    );
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(readdirSync(outputRoot).some((entry) => entry.startsWith(".attempt-")), false);
  }
});

test("仓库内输出只允许 Git 忽略的 .runtime 私有根并拒绝父级符号链接", async () => {
  const sourceRoot = createSyntheticRepository();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-output-policy-"));
  const policies = writePolicies(policyRoot);
  const privateOutput = path.join(sourceRoot, ".runtime", "public-snapshots");
  const result = await buildPublicSnapshot({
    sourceRoot,
    outputRoot: privateOutput,
    ...policies,
    continuity: healthyContinuity()
  });
  assert.equal(
    existsSync(path.join(privateOutput, "candidates", result.candidate_id)),
    true
  );

  const arbitraryOutput = path.join(sourceRoot, "public-output");
  mkdirSync(arbitraryOutput, { mode: 0o700 });
  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot,
      outputRoot: arbitraryOutput,
      ...policies,
      continuity: healthyContinuity()
    }),
    (error) => {
      assert.equal(error.stage, "initialization");
      assert.equal(error.code, "output-root-not-private");
      return true;
    }
  );

  for (const scenario of ["source-alias", "output-alias"]) {
    const aliasParent = mkdtempSync(path.join(tmpdir(), `public-snapshot-${scenario}-`));
    const sourceAlias = path.join(aliasParent, "source-repository");
    symlinkSync(sourceRoot, sourceAlias, "dir");
    const aliasedOutput = path.join(sourceRoot, `public-output-${scenario}`);
    mkdirSync(aliasedOutput, { mode: 0o700 });
    await assert.rejects(
      () => buildPublicSnapshot({
        sourceRoot: scenario === "source-alias" ? sourceAlias : sourceRoot,
        outputRoot: scenario === "source-alias"
          ? aliasedOutput
          : path.join(sourceAlias, path.basename(aliasedOutput)),
        ...policies,
        continuity: healthyContinuity()
      }),
      (error) => {
        assert.equal(error.stage, "initialization");
        assert.equal(error.code, "output-root-not-private");
        return true;
      }
    );
    assert.deepEqual(readdirSync(aliasedOutput), []);
  }

  const symlinkSourceRoot = createSyntheticRepository();
  const outside = mkdtempSync(path.join(tmpdir(), "public-snapshot-output-link-target-"));
  symlinkSync(outside, path.join(symlinkSourceRoot, ".runtime"), "dir");
  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot: symlinkSourceRoot,
      outputRoot: path.join(symlinkSourceRoot, ".runtime", "public-snapshots"),
      ...policies,
      continuity: healthyContinuity()
    }),
    (error) => {
      assert.equal(error.stage, "initialization");
      assert.equal(error.code, "output-root-parent-symlink");
      return true;
    }
  );
  assert.deepEqual(readdirSync(outside), []);
});

test("暂存安全漂移和归档的路径穿越、链接、额外文件都会失败关闭", async () => {
  const scenarios = [
    {
      name: "staging-drift",
      expectedStage: "staging-tree",
      expectedCode: "staging-tree-content-drift",
      hooks: {
        afterStagingCopy({ treeRoot }) {
          writeProjectFile(treeRoot, "src/core.mjs", "export const safeButChanged = true;\n");
        }
      }
    },
    {
      name: "staging-mode",
      expectedStage: "staging-tree",
      expectedCode: "staging-unsafe-mode",
      hooks: {
        afterStagingCopy({ treeRoot }) {
          chmodSync(path.join(treeRoot, "src/core.mjs"), 0o666);
        }
      }
    },
    {
      name: "archive-traversal",
      expectedStage: "archive-unpacked",
      expectedCode: "archive-unsafe-path",
      hooks: {
        async afterArchiveWritten({ replaceArchive }) {
          const maliciousRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-traversal-"));
          const child = path.join(maliciousRoot, "child");
          mkdirSync(child);
          writeProjectFile(maliciousRoot, "escape.mjs", "export const escaped = true;\n");
          const bytes = statSync(path.join(maliciousRoot, "escape.mjs")).size;
          await replaceArchive({
            treeRoot: child,
            records: [{ path: "../escape.mjs", mode: "0644", bytes }]
          });
        }
      }
    },
    {
      name: "archive-link",
      expectedStage: "archive-unpacked",
      expectedCode: "archive-non-regular-entry",
      hooks: {
        afterArchiveWritten({ archivePath }) {
          const archive = readFileSync(archivePath);
          archive[156] = "2".charCodeAt(0);
          archive.fill(0x20, 148, 156);
          const checksum = archive.subarray(0, 512).reduce((total, byte) => total + byte, 0);
          Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `).copy(archive, 148);
          writeFileSync(archivePath, archive);
        }
      }
    },
    {
      name: "archive-header-metadata",
      expectedStage: "archive-unpacked",
      expectedCode: "archive-noncanonical-header",
      hooks: {
        afterArchiveWritten({ archivePath }) {
          const archive = readFileSync(archivePath);
          Buffer.from(["Private", " Person"].join(""), "utf8").copy(archive, 265);
          archive.fill(0x20, 148, 156);
          const checksum = archive.subarray(0, 512).reduce((total, byte) => total + byte, 0);
          Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `).copy(archive, 148);
          writeFileSync(archivePath, archive);
        }
      }
    },
    {
      name: "archive-extra-file",
      expectedStage: "archive-unpacked",
      expectedCode: "archive-file-limit-exceeded",
      mutatePolicy(policy) {
        policy.limits.max_files = policy.files.length;
      },
      hooks: {
        async afterArchiveWritten({ sourceRecords, replaceArchive }) {
          const extraRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-extra-"));
          for (const record of sourceRecords) {
            writeProjectFile(extraRoot, record.path, readFileSync(path.join(this.sourceRoot, record.path)));
          }
          writeProjectFile(extraRoot, "src/extra.mjs", "export const extra = true;\n");
          const records = [
            ...sourceRecords,
            {
              path: "src/extra.mjs",
              mode: "0644",
              bytes: statSync(path.join(extraRoot, "src/extra.mjs")).size
            }
          ].sort((left, right) => left.path.localeCompare(right.path, "en"));
          await replaceArchive({ treeRoot: extraRoot, records });
        }
      }
    },
    {
      name: "candidate-extra-root-file",
      expectedStage: "candidate-metadata",
      expectedCode: "candidate-layout-drift",
      hooks: {
        afterArchiveWritten({ archivePath }) {
          writeProjectFile(
            path.dirname(archivePath),
            "unexpected-private-note.txt",
            ["Private", " Person", "\n"].join("")
          );
        }
      }
    }
  ];

  for (const scenario of scenarios) {
    const sourceRoot = createSyntheticRepository();
    if (scenario.hooks.afterArchiveWritten) scenario.hooks.sourceRoot = sourceRoot;
    const outputRoot = mkdtempSync(path.join(tmpdir(), `public-snapshot-${scenario.name}-`));
    const policy = structuredClone(publicPolicy());
    scenario.mutatePolicy?.(policy);
    const policies = writePolicies(outputRoot, policy);
    await assert.rejects(
      () => buildPublicSnapshot({
        sourceRoot,
        outputRoot,
        ...policies,
        continuity: healthyContinuity(),
        testHooks: scenario.hooks
      }),
      (error) => {
        assert.equal(error.stage, scenario.expectedStage);
        assert.equal(error.code, scenario.expectedCode);
        return true;
      }
    );
    assert.equal(existsSync(path.join(outputRoot, "candidates")), false);
    assert.equal(readdirSync(outputRoot).some((entry) => entry.startsWith(".attempt-")), false);
  }
});

test("相同来源生成相同树与归档摘要，来源变化会改变候选 ID", async () => {
  const sourceRoot = createSyntheticRepository();
  const firstOutput = mkdtempSync(path.join(tmpdir(), "public-snapshot-repeat-first-"));
  const secondOutput = mkdtempSync(path.join(tmpdir(), "public-snapshot-repeat-second-"));
  const first = await buildPublicSnapshot({
    sourceRoot,
    outputRoot: firstOutput,
    ...writePolicies(firstOutput),
    continuity: healthyContinuity()
  });
  const second = await buildPublicSnapshot({
    sourceRoot,
    outputRoot: secondOutput,
    ...writePolicies(secondOutput),
    continuity: healthyContinuity()
  });
  assert.equal(first.tree_sha256, second.tree_sha256);
  assert.equal(first.archive_sha256, second.archive_sha256);
  assert.equal(first.plugin_sha256, second.plugin_sha256);
  assert.equal(first.npm_sha256, second.npm_sha256);
  assert.equal(first.candidate_id, second.candidate_id);

  writeProjectFile(sourceRoot, "src/core.mjs", 'export const fixturePrincipal = "ou_fixture_changed";\n');
  commitAll(sourceRoot, "change public source");
  const changedOutput = mkdtempSync(path.join(tmpdir(), "public-snapshot-repeat-changed-"));
  const changed = await buildPublicSnapshot({
    sourceRoot,
    outputRoot: changedOutput,
    ...writePolicies(changedOutput),
    continuity: healthyContinuity()
  });
  assert.notEqual(changed.tree_sha256, first.tree_sha256);
  assert.notEqual(changed.candidate_id, first.candidate_id);
});

test("私有扫描策略权限、非 UTF-8 内容和重复候选都失败关闭", async () => {
  const placeholderSource = createSyntheticRepository();
  const placeholderOutput = mkdtempSync(path.join(tmpdir(), "public-snapshot-private-policy-placeholder-"));
  const placeholderPolicies = writePolicies(placeholderOutput);
  writeFileSync(
    placeholderPolicies.privatePolicyPath,
    readFileSync(path.resolve("release/public-snapshot-private-policy.example.json")),
    { mode: 0o600 }
  );
  chmodSync(placeholderPolicies.privatePolicyPath, 0o600);
  let placeholderContinuityCalls = 0;
  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot: placeholderSource,
      outputRoot: placeholderOutput,
      ...placeholderPolicies,
      continuity: {
        async capture() {
          placeholderContinuityCalls += 1;
          return { healthy: true };
        },
        async compare() {
          placeholderContinuityCalls += 1;
          return { healthy: true };
        }
      }
    }),
    (error) => {
      assert.equal(error.stage, "policy");
      assert.equal(error.code, "private-policy-invalid");
      return true;
    }
  );
  assert.equal(placeholderContinuityCalls, 0);

  const modeSource = createSyntheticRepository();
  const modeOutput = mkdtempSync(path.join(tmpdir(), "public-snapshot-private-policy-mode-"));
  const modePolicies = writePolicies(modeOutput);
  chmodSync(modePolicies.privatePolicyPath, 0o644);
  let continuityCalls = 0;
  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot: modeSource,
      outputRoot: modeOutput,
      ...modePolicies,
      continuity: {
        async capture() {
          continuityCalls += 1;
          return { healthy: true };
        },
        async compare() {
          continuityCalls += 1;
          return { healthy: true };
        }
      }
    }),
    (error) => {
      assert.equal(error.stage, "policy");
      assert.equal(error.code, "private-policy-invalid");
      return true;
    }
  );
  assert.equal(continuityCalls, 0);

  const binarySource = createSyntheticRepository();
  writeProjectFile(binarySource, "src/core.mjs", Buffer.from([0xff, 0xfe, 0xfd]));
  commitAll(binarySource, "binary canary");
  const binaryOutput = mkdtempSync(path.join(tmpdir(), "public-snapshot-non-utf8-"));
  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot: binarySource,
      outputRoot: binaryOutput,
      ...writePolicies(binaryOutput),
      continuity: healthyContinuity()
    }),
    (error) => {
      assert.equal(error.code, "privacy-scan-failed");
      assert.equal(error.finding_codes.includes("non-utf8-content"), true);
      return true;
    }
  );

  const duplicateSource = createSyntheticRepository();
  const duplicateOutput = mkdtempSync(path.join(tmpdir(), "public-snapshot-candidate-collision-"));
  const duplicatePolicies = writePolicies(duplicateOutput);
  const first = await buildPublicSnapshot({
    sourceRoot: duplicateSource,
    outputRoot: duplicateOutput,
    ...duplicatePolicies,
    continuity: healthyContinuity()
  });
  await assert.rejects(
    () => buildPublicSnapshot({
      sourceRoot: duplicateSource,
      outputRoot: duplicateOutput,
      ...duplicatePolicies,
      continuity: healthyContinuity()
    }),
    (error) => {
      assert.equal(error.stage, "promotion");
      assert.equal(error.code, "candidate-already-exists");
      return true;
    }
  );
  assert.deepEqual(readdirSync(path.join(duplicateOutput, "candidates")), [first.candidate_id]);
  assert.equal(readdirSync(duplicateOutput).some((entry) => entry.startsWith(".attempt-")), false);
});

test("公共快照 CLI 使用稳定退出码且失败输出不泄露路径或命中正文", () => {
  const cliPath = path.resolve("bin/twin-public-snapshot.mjs");
  const usage = spawnSync(process.execPath, [cliPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(usage.status, 64);
  assert.deepEqual(JSON.parse(usage.stderr), {
    type: "usage",
    command: "twin-public-snapshot build POLICY PRIVATE_POLICY OUTPUT_ROOT CONTINUITY_MANIFEST [--instance-config ABSOLUTE_PATH]"
  });

  const sourceRoot = createSyntheticRepository();
  const privateLiteral = ["Private", " Person"].join("");
  writeFileSync(path.join(sourceRoot, "policy.json"), "{}\n");
  writeFileSync(path.join(sourceRoot, "private-policy.json"), `${JSON.stringify({
    schema_version: 1,
    forbidden_literals: [privateLiteral],
    private_domains: [["corp", ".internal"].join("")]
  })}\n`, { mode: 0o600 });
  chmodSync(path.join(sourceRoot, "private-policy.json"), 0o600);
  writeFileSync(path.join(sourceRoot, "continuity.json"), "{}\n");
  const failed = spawnSync(process.execPath, [
    cliPath,
    "build",
    "policy.json",
    "private-policy.json",
    "output",
    "continuity.json"
  ], {
    cwd: sourceRoot,
    encoding: "utf8"
  });
  assert.equal(failed.status, 1);
  assert.deepEqual(JSON.parse(failed.stderr), {
    type: "snapshot_failed",
    stage: "policy",
    code: "public-policy-invalid",
    finding_codes: [],
    secondary_codes: []
  });
  assert.doesNotMatch(failed.stderr, new RegExp(privateLiteral, "u"));
  assert.doesNotMatch(failed.stderr, /\/Users\/|\/private\/var\//u);

  const absoluteOutput = mkdtempSync(path.join(tmpdir(), "public-snapshot-cli-output-"));
  const failedWithAbsoluteOutput = spawnSync(process.execPath, [
    cliPath,
    "build",
    "policy.json",
    "private-policy.json",
    absoluteOutput,
    "continuity.json"
  ], {
    cwd: sourceRoot,
    encoding: "utf8"
  });
  assert.equal(failedWithAbsoluteOutput.status, 1);
  assert.equal(JSON.parse(failedWithAbsoluteOutput.stderr).code, "public-policy-invalid");

  const invalidPath = spawnSync(process.execPath, [
    cliPath,
    "build",
    "../policy.json",
    "private-policy.json",
    "output",
    "continuity.json"
  ], {
    cwd: sourceRoot,
    encoding: "utf8"
  });
  assert.equal(invalidPath.status, 64);
  assert.equal(JSON.parse(invalidPath.stderr).type, "usage");

  writeFileSync(path.join(sourceRoot, "policy.json"), `${JSON.stringify(publicPolicy())}\n`);
  const instanceRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-cli-instance-"));
  const { configPath } = writeSyntheticInstanceConfig(instanceRoot);
  chmodSync(configPath, 0o644);
  const invalidInstance = spawnSync(process.execPath, [
    cliPath,
    "build",
    "policy.json",
    "private-policy.json",
    "output",
    "continuity.json",
    "--instance-config",
    configPath
  ], {
    cwd: sourceRoot,
    encoding: "utf8"
  });
  assert.equal(invalidInstance.status, 1);
  assert.deepEqual(JSON.parse(invalidInstance.stderr), {
    type: "snapshot_failed",
    stage: "policy",
    code: "instance-config-invalid",
    finding_codes: [],
    secondary_codes: []
  });
  assert.doesNotMatch(invalidInstance.stderr, /林昭|orchid-operator-private/u);
  assert.doesNotMatch(invalidInstance.stderr, new RegExp(configPath, "u"));
});

test("公共快照 CLI 可只读验证候选及供应链元数据", async () => {
  const sourceRoot = createSyntheticRepository();
  const outputRoot = mkdtempSync(path.join(tmpdir(), "public-snapshot-cli-verify-"));
  const result = await buildPublicSnapshot({
    sourceRoot,
    outputRoot,
    ...writePolicies(outputRoot),
    continuity: healthyContinuity()
  });
  const cliPath = path.resolve("bin/twin-public-snapshot.mjs");
  const candidateRelativePath = `candidates/${result.candidate_id}`;
  const verified = spawnSync(process.execPath, [cliPath, "verify", candidateRelativePath], {
    cwd: outputRoot,
    encoding: "utf8"
  });
  const verifiedAbsolute = spawnSync(process.execPath, [
    cliPath,
    "verify",
    path.join(outputRoot, candidateRelativePath)
  ], {
    cwd: sourceRoot,
    encoding: "utf8"
  });

  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verifiedAbsolute.status, 0, verifiedAbsolute.stderr);
  assert.equal(verified.stderr, "");
  assert.equal(verifiedAbsolute.stderr, "");
  assert.deepEqual(JSON.parse(verified.stdout), {
    type: "public_snapshot_candidate",
    status: "verified",
    candidate_id: result.candidate_id,
    version: "1.2.3",
    file_count: 4,
    tree_sha256: result.tree_sha256,
    archive_sha256: result.archive_sha256,
    plugin_sha256: result.plugin_sha256,
    npm_sha256: result.npm_sha256,
    sbom_sha256: result.sbom_sha256,
    provenance_sha256: result.provenance_sha256
  });
  assert.deepEqual(JSON.parse(verifiedAbsolute.stdout), JSON.parse(verified.stdout));
  assert.doesNotMatch(verified.stdout, /\/Users\/|\/private\/var\//u);
});
