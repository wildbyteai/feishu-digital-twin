import { runLarkCommand } from "../../shared/lark-cli-transport.mjs";
import { authorityLabel, stripAuthorityLabel } from "../../shared/authority-labels.mjs";

function privateMessageArgv({
  larkBin,
  profile,
  principalOpenId,
  text,
  idempotencyKey
}) {
  return [
    larkBin,
    "--profile",
    profile,
    "im",
    "+messages-send",
    "--user-id",
    principalOpenId,
    "--text",
    text,
    "--idempotency-key",
    idempotencyKey,
    "--as",
    "bot",
    "--format",
    "json"
  ];
}

export async function sendPrivateNotification({
  larkBin = "lark-cli",
  profile,
  principalOpenId,
  principalName,
  text,
  idempotencyKey,
  productionEnabled,
  runner = runLarkCommand
}) {
  const message = `${authorityLabel("suggestion", principalName)}${stripAuthorityLabel(text)}`;
  const argv = privateMessageArgv({
    larkBin,
    profile,
    principalOpenId,
    text: message,
    idempotencyKey
  });
  if (!productionEnabled) return { status: "preview-only", argv };
  const result = await runner(argv);
  return {
    status: result.exit_code === 0 ? "complete" : "failed",
    exit_code: result.exit_code
  };
}

export async function sendPrivateConfirmation({
  larkBin = "lark-cli",
  profile,
  principalOpenId,
  principalName,
  confirmationId,
  reason,
  requiresYes = false,
  risk = null,
  preview = null,
  productionEnabled,
  runner = runLarkCommand
}) {
  const riskLine = requiresYes
    ? `飞书官方标记为高风险操作：${risk?.action ?? "请核对以下动作"}`
    : "这是数字分身提出的业务确认。";
  const previewLine = preview === null ? null : `官方预览：${JSON.stringify(preview)}`;
  const text = [
    `${authorityLabel("confirmation", principalName)}建议执行：${reason}`,
    riskLine,
    previewLine,
    `确认编号：${confirmationId}`,
    `请回复“确认 ${confirmationId}”或“拒绝 ${confirmationId}”。`
  ].filter(Boolean).join("\n");
  const argv = privateMessageArgv({
    larkBin,
    profile,
    principalOpenId,
    text,
    idempotencyKey: `twin-confirm-${confirmationId}`
  });
  if (!productionEnabled) return { status: "preview-only", argv };
  const result = await runner(argv);
  return {
    status: result.exit_code === 0 ? "complete" : "failed",
    exit_code: result.exit_code
  };
}
