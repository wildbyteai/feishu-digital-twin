import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const skillPath = fileURLToPath(new URL(
  "../../skills/feishu-digital-twin/SKILL.md",
  import.meta.url
));
const skill = readFileSync(skillPath, "utf8");
const dailyMemorySkillPath = fileURLToPath(new URL(
  "../../skills/feishu-daily-work-memory/SKILL.md",
  import.meta.url
));
const dailyMemorySkill = readFileSync(dailyMemorySkillPath, "utf8");

export function buildDecisionPrompt(event, promptContext = {}) {
  const selectedSkills = event.intent === "daily_work_memory"
    ? [skill, dailyMemorySkill]
    : [skill];
  return [
    "你是一个临时运行的飞书数字分身决策器。",
    "只使用下面给出的项目 Skill、配置、当前消息、同源上下文和隔离 HOME 中已安装的官方 lark-* Skills。",
    "按需读取匹配的官方 lark-* SKILL.md 来选择准确命令；不要执行命令、访问网络或输出 Markdown。",
    "严格返回一个符合输出 Schema 的 JSON 对象。",
    "项目 Skills：",
    selectedSkills.join("\n\n"),
    "本次配置与运行状态：",
    JSON.stringify(promptContext, null, 2),
    "当前飞书事件：",
    JSON.stringify(event, null, 2)
  ].join("\n");
}
