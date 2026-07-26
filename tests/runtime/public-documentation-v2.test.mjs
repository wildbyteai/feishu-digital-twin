import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "../..");

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

test("根 README 只用三个主步骤引导真实安装并链接全部详细指引", () => {
  const content = read("README.md");
  for (const link of [
    "./docs/getting-started/feishu-cli.md",
    "./docs/getting-started/codex.md",
    "./docs/getting-started/global-configuration.md"
  ]) assert.match(content, new RegExp(link.replaceAll(".", "\\."), "u"));
  for (const relativePath of REQUIRED_DOCUMENTS) {
    assert.match(content, new RegExp(relativePath.replaceAll(".", "\\."), "u"), relativePath);
  }
  const start = content.indexOf("## 三步开始");
  const end = content.indexOf("\n## ", start + 4);
  assert.notEqual(start, -1);
  const section = content.slice(start, end === -1 ? undefined : end);
  assert.deepEqual(
    [...section.matchAll(/^\d+\.\s+\*\*/gmu)].map((match) => match[0].slice(0, 2)),
    ["1.", "2.", "3."]
  );
});

test("公开文档中的本地 Markdown 链接均留在发行树内并可读取", () => {
  const packageManifest = JSON.parse(read("package.json"));
  const packaged = new Set(packageManifest.files);
  for (const sourcePath of ["README.md", ...REQUIRED_DOCUMENTS]) {
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
