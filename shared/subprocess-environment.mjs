import process from "node:process";

const LARK_ENV_ALLOWLIST = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LARK_CLI_NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR"
]);

export function selectEnvironment(environment, allowlist) {
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) =>
    allowlist.has(name.toUpperCase()) && typeof value === "string" && value.length > 0
  ));
}

export function buildLarkEnvironment(environment = process.env) {
  return {
    ...selectEnvironment(environment, LARK_ENV_ALLOWLIST),
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
  };
}
