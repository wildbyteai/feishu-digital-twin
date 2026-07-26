import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { createHash, createHmac, randomBytes } from "node:crypto";

const KEY_PATTERN = /^[a-f0-9]{64}\n?$/u;
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const COMPONENT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u;

function normalizeKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value ?? "", "utf8");
  if (key.byteLength < 32) throw new TypeError("privacy key must contain at least 32 bytes");
  return key;
}

function readProtectedKey(keyPath) {
  const descriptor = openSync(keyPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error("privacy key must be a regular file");
    if ((metadata.mode & 0o077) !== 0) throw new Error("privacy key permissions must be 0600");
    const encoded = readFileSync(descriptor, "utf8");
    if (!KEY_PATTERN.test(encoded)) throw new Error("privacy key file is invalid");
    return Buffer.from(encoded.trim(), "hex");
  } finally {
    closeSync(descriptor);
  }
}

export function loadOrCreatePrivacyKey(keyPath) {
  if (typeof keyPath !== "string" || keyPath.length === 0) {
    throw new TypeError("privacy key path is required");
  }
  try {
    return readProtectedKey(keyPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const encoded = `${randomBytes(32).toString("hex")}\n`;
  try {
    const descriptor = openSync(
      keyPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    try {
      writeFileSync(descriptor, encoded, "utf8");
    } finally {
      closeSync(descriptor);
    }
    chmodSync(keyPath, 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return readProtectedKey(keyPath);
}

export class PrivacyProjection {
  constructor(key) {
    this.key = normalizeKey(key);
  }

  identifier(kind, value) {
    if (!KIND_PATTERN.test(kind)) throw new TypeError("privacy identifier kind is invalid");
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError("privacy identifier value must be a non-empty string");
    }
    const digest = createHmac("sha256", this.key)
      .update(kind)
      .update("\0")
      .update(value)
      .digest("hex");
    return `${kind}_${digest}`;
  }

  fingerprint() {
    return createHash("sha256").update(this.key).digest("hex");
  }
}

export function projectRuntimeError({ component, code = "UNEXPECTED_FAILURE" }) {
  if (!COMPONENT_PATTERN.test(component)) throw new TypeError("error component is invalid");
  if (!ERROR_CODE_PATTERN.test(code)) throw new TypeError("error code is invalid");
  return { type: "error", component, code };
}
