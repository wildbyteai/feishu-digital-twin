import assert from "node:assert/strict";
import test from "node:test";

import { projectRuntimeError } from "../../runtime/src/privacy-projection.mjs";

test("运行错误只输出稳定组件和错误码，不携带异常正文或路径", () => {
  const privatePath = ["/", "Users", "/", "fixture-owner", "/config.json"].join("");
  const secretError = new Error(
    `failed for ${privatePath} with token secret-value`
  );
  const projected = projectRuntimeError({
    component: "runtime",
    code: "RUNTIME_COMMAND_FAILED",
    error: secretError
  });

  assert.deepEqual(projected, {
    type: "error",
    component: "runtime",
    code: "RUNTIME_COMMAND_FAILED"
  });
  assert.equal(JSON.stringify(projected).includes(privatePath), false);
  assert.equal(JSON.stringify(projected).includes("secret-value"), false);
});
