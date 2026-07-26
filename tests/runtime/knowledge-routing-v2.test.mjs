import assert from "node:assert/strict";
import test from "node:test";

import { buildDecisionPrompt } from "../../runtime/src/prompt.mjs";

test("数字分身按聊天方向检索企业知识库后再形成有证据的回复", () => {
  const prompt = buildDecisionPrompt({
    event_id: "evt-knowledge",
    source: "supplement",
    chat_id: "oc_internal",
    chat_type: "group",
    message_id: "om_knowledge",
    sender_open_id: "ou_member",
    text: "负责人，差旅报销现在按什么标准？"
  }, {
    config: {
      authority_rules: [
        "企业知识库：财务、人力招聘和渠道增长；space_id=space_enterprise"
      ]
    }
  });

  for (const required of [
    "## 企业知识库检索",
    "先判断聊天大致属于哪个业务方向",
    "从配置中的个性化规则读取知识空间名称和 `space_id`",
    "最多选择两个最相关的知识空间",
    "drive +search",
    "不得把搜索摘要直接当作正式答案",
    "最多读取 3 个候选",
    "drive +inspect",
    "不要把所有 Wiki 都假定为 DOCX",
    "`DOCX`",
    "BITABLE / Base",
    "原生 Markdown",
    "上传文件",
    "只使用实际读取到的正文或结构化数据形成回复",
    "当前接收者有权访问"
  ]) {
    assert.equal(prompt.includes(required), true, `missing knowledge-routing rule: ${required}`);
  }
});
