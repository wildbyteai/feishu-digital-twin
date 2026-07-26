import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";

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

export async function createIsolatedTestEnvironment({
  root,
  nodePath,
  baseEnvironment = process.env
}) {
  if (typeof root !== "string" || typeof nodePath !== "string") {
    throw new TypeError("root and nodePath are required");
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
  await symlink(nodePath, path.join(directories.bin, "node"));
  return {
    ...safeHostEnvironment(baseEnvironment),
    TWIN_TEST_MODE: "1",
    HOME: directories.home,
    TMPDIR: directories.tmp,
    TMP: directories.tmp,
    TEMP: directories.tmp,
    XDG_CONFIG_HOME: directories.config,
    XDG_CACHE_HOME: directories.cache,
    PATH: `${directories.bin}:/usr/bin:/bin`
  };
}
