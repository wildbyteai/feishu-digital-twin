import { constants } from "node:fs";
import { access, mkdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const SQLITE_EXPERIMENTAL_WARNING = "SQLite is an experimental feature and might change at any time";

function warningFilterSource() {
  return `const sqliteExperimentalWarning = ${JSON.stringify(SQLITE_EXPERIMENTAL_WARNING)};
const originalEmitWarning = process.emitWarning;

function warningType(warning, typeOrOptions) {
  if (typeof typeOrOptions === "string") return typeOrOptions;
  if (typeOrOptions && typeof typeOrOptions === "object") return typeOrOptions.type;
  if (warning instanceof Error) return warning.name;
  return undefined;
}

process.emitWarning = function filteredEmitWarning(...argumentsList) {
  const [warning, typeOrOptions] = argumentsList;
  const message = typeof warning === "string" ? warning : warning?.message;
  if (
    message === sqliteExperimentalWarning
    && warningType(warning, typeOrOptions) === "ExperimentalWarning"
  ) return;
  return Reflect.apply(originalEmitWarning, this, argumentsList);
};
`;
}

function quoteShellArgument(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function gitWrapperSource(gitPath) {
  return `#!/bin/sh
exec ${quoteShellArgument(gitPath)} "$@"
`;
}

function safeHostEnvironment(baseEnvironment) {
  const allowed = new Set([
    "CI",
    "COLORTERM",
    "FORCE_COLOR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "NO_COLOR",
    "TERM",
    "TZ"
  ]);
  return Object.fromEntries(Object.entries(baseEnvironment).filter(([name]) => (
    allowed.has(name) || name.startsWith("LC_")
  )));
}

async function resolveExecutableFile(candidate) {
  const resolved = await realpath(candidate);
  if (!(await stat(resolved)).isFile()) {
    throw new Error("executable target is not a file");
  }
  await access(resolved, constants.X_OK);
  return resolved;
}

async function resolveGitPath(pathValue) {
  if (typeof pathValue !== "string") {
    throw new TypeError("baseEnvironment.PATH is required");
  }
  for (const directory of pathValue.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "git");
    try {
      return await resolveExecutableFile(candidate);
    } catch {
      // Continue searching the trusted host PATH.
    }
  }
  throw new Error("git executable not found");
}

export async function createIsolatedTestEnvironment({
  root,
  nodePath,
  gitPath,
  baseEnvironment = process.env
}) {
  if (typeof root !== "string" || typeof nodePath !== "string") {
    throw new TypeError("root and nodePath are required");
  }
  if (gitPath !== undefined && (typeof gitPath !== "string" || !path.isAbsolute(gitPath))) {
    throw new TypeError("gitPath must be an absolute path");
  }
  let resolvedGitPath;
  try {
    resolvedGitPath = gitPath === undefined
      ? await resolveGitPath(baseEnvironment.PATH)
      : await resolveExecutableFile(gitPath);
  } catch (error) {
    if (gitPath === undefined) throw error;
    throw new Error("gitPath must resolve to an executable file", { cause: error });
  }
  const directories = Object.fromEntries([
    "home",
    "tmp",
    "config",
    "cache",
    "bin"
  ].map((name) => [name, path.join(root, name)]));
  for (const directory of Object.values(directories)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const warningFilterPath = path.join(root, "node-sqlite-warning-filter.cjs");
  await writeFile(warningFilterPath, warningFilterSource(), { mode: 0o600 });
  await symlink(nodePath, path.join(directories.bin, "node"));
  await writeFile(
    path.join(directories.bin, "git"),
    gitWrapperSource(resolvedGitPath),
    { mode: 0o700 }
  );
  return {
    ...safeHostEnvironment(baseEnvironment),
    TWIN_TEST_MODE: "1",
    NODE_OPTIONS: `--require=${JSON.stringify(warningFilterPath)}`,
    HOME: directories.home,
    TMPDIR: directories.tmp,
    TMP: directories.tmp,
    TEMP: directories.tmp,
    XDG_CONFIG_HOME: directories.config,
    XDG_CACHE_HOME: directories.cache,
    PATH: `${directories.bin}:/usr/bin:/bin`
  };
}
