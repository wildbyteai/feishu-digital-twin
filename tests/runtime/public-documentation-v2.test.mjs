import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const ROOT_READMES = Object.freeze(["README.md", "README.en.md"]);

const REQUIRED_DOCUMENTS = Object.freeze([
  "docs/compatibility.md",
  "docs/features/daily-memory.md",
  "docs/features/enterprise-knowledge.md",
  "docs/getting-started/codex.md",
  "docs/getting-started/feishu-cli.md",
  "docs/getting-started/global-configuration.md",
  "docs/operations/runtime.md",
  "docs/reference/configuration.md",
  "docs/reference/feishu-permissions.md",
  "docs/security/privacy.md"
]);

function read(relativePath) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function markdownLinks(content) {
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
    .map((match) => match[1].trim())
    .filter((target) => (
      !target.startsWith("#") &&
      !/^[a-z][a-z0-9+.-]*:/iu.test(target)
    ));
}

test("公开上手、配置、运行和隐私文档随源码、公共快照和 npm 包完整发布", () => {
  const packageManifest = JSON.parse(read("package.json"));
  const publicSnapshot = JSON.parse(read("release/public-snapshot.example.json"));
  const packaged = new Set(packageManifest.files);
  const publicFiles = new Set(publicSnapshot.files.map((entry) => entry.path));

  for (const relativePath of REQUIRED_DOCUMENTS) {
    const metadata = lstatSync(path.join(projectRoot, relativePath));
    assert.equal(metadata.isFile(), true, relativePath);
    assert.equal(metadata.isSymbolicLink(), false, relativePath);
    assert.equal(packaged.has(relativePath), true, `${relativePath} missing from package.json`);
    assert.equal(publicFiles.has(relativePath), true, `${relativePath} missing from public snapshot`);
  }
  assert.equal(packaged.has("tests/runtime/public-documentation-v2.test.mjs"), true);
  assert.equal(publicFiles.has("tests/runtime/public-documentation-v2.test.mjs"), true);
});

test("根 README 保持中英文双语且关键安装边界一致", () => {
  const packageManifest = JSON.parse(read("package.json"));
  const publicSnapshot = JSON.parse(read("release/public-snapshot.example.json"));
  const packaged = new Set(packageManifest.files);
  const publicFiles = new Set(publicSnapshot.files.map((entry) => entry.path));
  const chinese = read("README.md");
  const english = read("README.en.md");

  assert.match(chinese, /\[English\]\(\.\/README\.en\.md\)/u);
  assert.match(english, /\[中文\]\(\.\/README\.md\)/u);
  assert.match(chinese, /## 一分钟理解/u);
  assert.match(english, /## Understand it in one minute/u);
  assert.match(chinese, /安全接入与身份路由/u);
  assert.match(english, /safe intake and identity routing/u);
  assert.match(chinese, /## 适用范围/u);
  assert.match(english, /## Intended use/u);
  for (const [content, targets, headings] of [
    [
      chinese,
      [
        ["#三步开始", "## 三步开始"],
        ["#功能与所需权限", "## 功能与所需权限"],
        ["#安装后验收", "## 安装后验收"],
        ["#配置与隐私边界", "## 配置与隐私边界"],
        ["#架构原则", "## 架构原则"]
      ],
      ["## 一分钟理解", "## 它能做什么", "## 适用范围", "## 安装前需要准备"]
    ],
    [
      english,
      [
        ["#get-started-in-three-steps", "## Get started in three steps"],
        ["#features-and-required-permissions", "## Features and required permissions"],
        ["#post-installation-verification", "## Post-installation verification"],
        ["#configuration-and-privacy-boundaries", "## Configuration and privacy boundaries"],
        ["#architecture-principles", "## Architecture principles"]
      ],
      ["## Understand it in one minute", "## What it can do", "## Intended use", "## Prerequisites"]
    ]
  ]) {
    for (const [link, targetHeading] of targets) {
      assert.match(content, new RegExp(`\\(${link}\\)`, "u"));
      assert.equal(content.includes(targetHeading), true, targetHeading);
    }
    const positions = headings.map((heading) => content.indexOf(heading));
    assert.equal(positions.every((position) => position >= 0), true);
    assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  }
  for (const relativePath of ROOT_READMES) {
    assert.equal(packaged.has(relativePath), true, `${relativePath} missing from package.json`);
    assert.equal(publicFiles.has(relativePath), true, `${relativePath} missing from public snapshot`);
  }
  for (const content of [chinese, english]) {
    assert.match(content, /v0\.1\.11/u);
    assert.match(content, /--create-missing-resources/u);
    assert.match(content, /im\.message\.receive_v1/u);
    assert.match(content, /codex exec --ephemeral/u);
    assert.match(content, /base \+base-create/u);
    assert.match(content, /base \+table-create/u);
    assert.match(content, /base \+record-upsert/u);
    assert.match(content, /wiki \+space-create/u);
    assert.match(content, /drive \+create-folder/u);
  }
  assert.match(chinese, /Base 控制台是强制配置.*不要求提前手工创建/su);
  assert.match(english, /Base console is mandatory.*does not need to be created manually in advance/su);
});

test("根 README 只用三个主步骤引导真实安装并链接全部详细指引", () => {
  for (const [relativePath, heading] of [
    ["README.md", "## 三步开始"],
    ["README.en.md", "## Get started in three steps"]
  ]) {
    const content = read(relativePath);
    for (const link of [
      "./docs/getting-started/feishu-cli.md",
      "./docs/getting-started/codex.md",
      "./docs/getting-started/global-configuration.md"
    ]) assert.match(content, new RegExp(link.replaceAll(".", "\\."), "u"));
    for (const requiredDocument of REQUIRED_DOCUMENTS) {
      assert.match(
        content,
        new RegExp(requiredDocument.replaceAll(".", "\\."), "u"),
        `${relativePath}: ${requiredDocument}`
      );
    }
    const start = content.indexOf(heading);
    const end = content.indexOf("\n## ", start + 4);
    assert.notEqual(start, -1, relativePath);
    const section = content.slice(start, end === -1 ? undefined : end);
    assert.deepEqual(
      [...section.matchAll(/^\d+\.\s+\*\*/gmu)].map((match) => match[0].slice(0, 2)),
      ["1.", "2.", "3."],
      relativePath
    );
  }
});

test("公开文档中的本地 Markdown 链接均留在发行树内并可读取", () => {
  const packageManifest = JSON.parse(read("package.json"));
  const packaged = new Set(packageManifest.files);
  for (const sourcePath of [...ROOT_READMES, ...REQUIRED_DOCUMENTS]) {
    const sourceDirectory = path.dirname(sourcePath);
    for (const target of markdownLinks(read(sourcePath))) {
      const pathname = decodeURIComponent(target.split("#", 1)[0]);
      const resolved = path.posix.normalize(path.posix.join(sourceDirectory, pathname));
      assert.equal(resolved.startsWith("../"), false, `${sourcePath}: ${target}`);
      const metadata = lstatSync(path.join(projectRoot, resolved));
      assert.equal(metadata.isFile(), true, `${sourcePath}: ${target}`);
      assert.equal(packaged.has(resolved), true, `${sourcePath}: ${target} is not packaged`);
    }
  }
});

test("配置参考逐项说明来源、敏感性、验证和安全回退", () => {
  const content = read("docs/reference/configuration.md");
  for (const required of [
    "用途",
    "取得位置",
    "敏感级别",
    "保存方式",
    "最小权限",
    "默认值或范围",
    "验证方法",
    "成功后置条件",
    "常见错误",
    "安全回退"
  ]) assert.match(content, new RegExp(required, "u"));

  const schema = JSON.parse(read("runtime/schemas/instance-config.schema.json"));
  for (const field of Object.keys(schema.properties)) {
    assert.equal(content.includes(`\`${field}\``), true, field);
  }
});

test("公开接入文档固定官方组件、Codex 黑盒和数据防泄漏边界", () => {
  const combined = REQUIRED_DOCUMENTS.map(read).join("\n");
  assert.match(combined, /npx @larksuite\/cli@latest install/u);
  assert.match(combined, /lark-cli profile list/u);
  assert.match(combined, /im\.message\.receive_v1/u);
  assert.match(combined, /codex exec --ephemeral/u);
  assert.match(combined, /不读取.*模型.*端点.*Provider/iu);
  assert.match(combined, /不要在公开 (?:Issue|Issue\/PR).*凭据.*二维码.*业务正文/iu);
  assert.doesNotMatch(combined, /file:\/\/|\/(?:Users|home)\/|localhost|api\.private-provider\.example/iu);
});

test("公开运行指引给出可直接执行的运行中升级与回退参数", () => {
  const runtime = read("docs/operations/runtime.md");
  const globalConfiguration = read("docs/getting-started/global-configuration.md");
  const readme = read("README.md");

  for (const content of [runtime, globalConfiguration]) {
    assert.match(
      content,
      /feishu-digital-twin control upgrade --source <absolute-new-release-tree> --restart/u
    );
    assert.match(content, /feishu-digital-twin control rollback --restart/u);
  }
  assert.match(runtime, /同一版本号.*status=unchanged.*不会覆盖/u);
  assert.match(runtime, /source\.tar.*SHA256SUMS/su);
  assert.match(runtime, /tar -xf .*source\.tar.*twin-public-snapshot\.mjs.*verify/su);
  assert.match(runtime, /\$CANDIDATE\/tree.*--source/u);
  assert.match(readme, /运行中升级.*--source.*--restart.*同版本.*不会覆盖/u);
});

test("公开安装文档说明缺失资源提示、官方 CLI 自动创建和最小权限", () => {
  const readme = read("README.md");
  const globalConfiguration = read("docs/getting-started/global-configuration.md");
  const knowledge = read("docs/features/enterprise-knowledge.md");
  const dailyMemory = read("docs/features/daily-memory.md");
  const permissions = read("docs/reference/feishu-permissions.md");

  for (const content of [readme, globalConfiguration, knowledge, dailyMemory]) {
    assert.match(content, /--create-missing-resources/u);
  }
  assert.match(globalConfiguration, /missing_resources/u);
  assert.match(globalConfiguration, /created_resources_retained/u);
  assert.match(knowledge, /wiki \+space-create.*--dry-run/su);
  assert.match(dailyMemory, /drive \+create-folder.*--dry-run/su);
  assert.match(permissions, /wiki:space:write_only/u);
  assert.match(permissions, /space:folder:create/u);
  assert.match(permissions, /base \+base-create/u);
  assert.match(permissions, /base \+table-create/u);
  assert.match(permissions, /base \+record-upsert/u);
  assert.match(readme, /Base 控制台是强制配置.*不要求提前手工创建/su);
  assert.match(readme, /多个同名资源.*停止/su);
});

test("setup 首装指引明确区分日常总开关、部署确认和 Base 建表步骤", () => {
  const chinese = read("README.md");
  const english = read("README.en.md");
  const globalConfiguration = read("docs/getting-started/global-configuration.md");
  const consoleGuide = read("docs/feishu-console.md");

  for (const content of [chinese, english]) {
    assert.match(content, /feishu-digital-twin setup --help/u);
    assert.match(content, /数字分身启用/u);
    assert.match(content, /safe-but-disabled/u);
    assert.match(content, /--approve-production-data/u);
    assert.match(content, /--approve-message-scope/u);
  }
  assert.match(globalConfiguration, /唯一日常总开关/u);
  assert.match(globalConfiguration, /部署时确认/u);
  assert.match(globalConfiguration, /Base 控制台是普通完整安装的强制配置/u);
  assert.match(globalConfiguration, /自动创建两张表和安全关闭的初始记录/u);
  assert.match(consoleGuide, /首次创建清单/u);
  assert.match(consoleGuide, /名称.*可选/u);
  assert.match(consoleGuide, /群名称.*可选/u);
  assert.match(consoleGuide, /生产执行.*旧版兼容/u);
  assert.match(consoleGuide, /首装时先不勾选/u);
  assert.match(consoleGuide, /最长约 10 秒/u);
  assert.match(consoleGuide, /readiness=ready/u);
});
