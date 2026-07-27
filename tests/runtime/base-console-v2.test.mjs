import assert from "node:assert/strict";
import test from "node:test";

import {
  createBaseConsoleRefresher,
  createBaseRuntimeSwitchRefresher,
  loadBaseConsole
} from "../../runtime/src/base-console.mjs";

test("local 模式只使用本机开关与规则且不读取 Base", async () => {
  let calls = 0;
  const config = await loadBaseConsole({
    profile: "example_profile",
    control: { mode: "local", enabled: true },
    allowed_lark_domains: ["im"],
    authority_rules: ["本机规则"],
    group_rules: [{ chat_id: "oc_local", rules: ["本机群规则"] }]
  }, {
    runner: async () => {
      calls += 1;
      throw new Error("local mode must not read Base");
    }
  });

  assert.equal(calls, 0);
  assert.equal(config.production_enabled, true);
  assert.deepEqual(config.authority_rules, ["本机规则"]);
  assert.deepEqual(config.group_rules, [{ chat_id: "oc_local", rules: ["本机群规则"] }]);
});

test("base 模式只使用 Base 开关与规则且不回退到本机规则", async () => {
  const config = await loadBaseConsole({
    profile: "example_profile",
    control: { mode: "base" },
    allowed_lark_domains: ["im"],
    authority_rules: ["不得回退的本机规则"],
    console: {
      base_token: "base_x",
      runtime_table: "运行配置",
      group_rules_table: "群级规则"
    }
  }, {
    runner: async (argv) => {
      const table = argv[argv.indexOf("--table-id") + 1];
      return {
        exit_code: 0,
        stdout: JSON.stringify(table === "运行配置"
          ? { ok: true, data: { fields: ["数字分身启用", "允许域", "个性化规则"], data: [[true, "继承", ""]] } }
          : { ok: true, data: { fields: ["启用", "群ID", "个性化规则"], data: [] } }),
        stderr: ""
      };
    }
  });

  assert.equal(config.production_enabled, true);
  assert.deepEqual(config.authority_rules, []);
  assert.deepEqual(config.group_rules, []);
});

test("base 模式分页读取超过 200 条群级规则", async () => {
  const groupRows = Array.from({ length: 201 }, (_, index) => [
    true,
    `oc_group_${index + 1}`,
    `规则 ${index + 1}`
  ]);
  const groupOffsets = [];
  const config = await loadBaseConsole({
    profile: "example_profile",
    control: { mode: "base" },
    allowed_lark_domains: ["im"],
    console: {
      base_token: "base_x",
      runtime_table: "运行配置",
      group_rules_table: "群级规则"
    }
  }, {
    runner: async (argv) => {
      const table = argv[argv.indexOf("--table-id") + 1];
      const offset = Number(argv[argv.indexOf("--offset") + 1]);
      if (table === "运行配置") {
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: {
              fields: ["数字分身启用", "允许域", "个性化规则"],
              data: [[true, "继承", ""]],
              has_more: false
            }
          }),
          stderr: ""
        };
      }
      groupOffsets.push(offset);
      const data = groupRows.slice(offset, offset + 200);
      return {
        exit_code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            fields: ["启用", "群ID", "个性化规则"],
            data,
            has_more: offset + data.length < groupRows.length
          }
        }),
        stderr: ""
      };
    }
  });

  assert.deepEqual(groupOffsets, [0, 200]);
  assert.equal(config.group_rules.length, 201);
  assert.deepEqual(config.group_rules.at(-1), {
    chat_id: "oc_group_201",
    rules: ["规则 201"]
  });
});

test("飞书 Base 规则保持自然语言，允许域只能收紧本机权限上限", async () => {
  const calls = [];
  const config = await loadBaseConsole({
    profile: "example_profile",
    allowed_lark_domains: ["im"],
    authority_rules: ["本地默认规则"],
    console: {
      base_token: "base_x",
      runtime_table: "运行配置",
      group_rules_table: "群级规则"
    }
  }, {
    runner: async (argv) => {
      calls.push(argv);
      const table = argv[argv.indexOf("--table-id") + 1];
      const fields = table === "运行配置"
        ? ["数字分身启用", "允许域", "个性化规则"]
        : ["启用", "群ID", "个性化规则"];
      const data = table === "运行配置" ? [[
        false,
        ["im"],
        "默认主动跟进阻塞事项\n所有权转让必须本人操作"
      ]] : [
        [true, "oc_group_1", "对客户承诺交期前先核实库存\n使用简洁语气"],
        [false, "oc_group_2", "不应生效"]
      ];
      return {
        exit_code: 0,
        stdout: JSON.stringify({ ok: true, data: { fields, data } }),
        stderr: ""
      };
    }
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(config.allowed_lark_domains, ["im"]);
  assert.deepEqual(config.group_rules, [{
    chat_id: "oc_group_1",
    rules: ["对客户承诺交期前先核实库存", "使用简洁语气"]
  }]);
  assert.equal(config.production_enabled, false);
  assert.equal(config.authority_rules.length, 2);
});

test("允许域只有明确写入“继承”时才继承本机权限上限", async () => {
  const config = await loadBaseConsole({
    profile: "example_profile",
    allowed_lark_domains: ["im", "task"],
    authority_rules: [],
    console: {
      base_token: "base_x",
      runtime_table: "运行配置",
      group_rules_table: "群级规则"
    }
  }, {
    runner: async (argv) => {
      const table = argv[argv.indexOf("--table-id") + 1];
      return {
        exit_code: 0,
        stdout: JSON.stringify(table === "运行配置"
          ? {
              ok: true,
              data: {
                fields: ["数字分身启用", "允许域", "个性化规则"],
                data: [[true, "继承", ""]]
              }
            }
          : {
              ok: true,
              data: { fields: ["启用", "群ID", "个性化规则"], data: [] }
            }),
        stderr: ""
      };
    }
  });

  assert.deepEqual(config.allowed_lark_domains, ["im", "task"]);
});

test("显式空允许域失败关闭而不是歧义继承", async () => {
  for (const emptyValue of ["", [], null]) {
    await assert.rejects(() => loadBaseConsole({
      profile: "example_profile",
      allowed_lark_domains: ["im", "task"],
      authority_rules: [],
      console: {
        base_token: "base_x",
        runtime_table: "运行配置",
        group_rules_table: "群级规则"
      }
    }, {
      runner: async (argv) => {
        const table = argv[argv.indexOf("--table-id") + 1];
        return {
          exit_code: 0,
          stdout: JSON.stringify(table === "运行配置"
            ? {
                ok: true,
                data: {
                  fields: ["数字分身启用", "允许域", "个性化规则"],
                  data: [[true, emptyValue, ""]]
                }
              }
            : {
                ok: true,
                data: { fields: ["启用", "群ID", "个性化规则"], data: [] }
              }),
          stderr: ""
        };
      }
    }), /Base console 允许域/u);
  }
});

test("允许域包含本机权限上限之外的值时整条配置失败关闭", async () => {
  await assert.rejects(() => loadBaseConsole({
    profile: "example_profile",
    allowed_lark_domains: ["im", "task"],
    authority_rules: [],
    console: {
      base_token: "base_x",
      runtime_table: "运行配置",
      group_rules_table: "群级规则"
    }
  }, {
    runner: async (argv) => {
      const table = argv[argv.indexOf("--table-id") + 1];
      return {
        exit_code: 0,
        stdout: JSON.stringify(table === "运行配置"
          ? {
              ok: true,
              data: {
                fields: ["数字分身启用", "允许域", "个性化规则"],
                data: [[true, ["im", "drive"], ""]]
              }
            }
          : {
              ok: true,
              data: { fields: ["启用", "群ID", "个性化规则"], data: [] }
            }),
        stderr: ""
      };
    }
  }), /Base console 允许域.*drive/u);
});

test("允许域的空项、重复项和混合继承都视为无效配置", async () => {
  for (const invalidValue of [["im", ""], ["im", "im"], ["继承", "im"], 42]) {
    await assert.rejects(() => loadBaseConsole({
      profile: "example_profile",
      allowed_lark_domains: ["im", "task"],
      authority_rules: [],
      console: {
        base_token: "base_x",
        runtime_table: "运行配置",
        group_rules_table: "群级规则"
      }
    }, {
      runner: async (argv) => {
        const table = argv[argv.indexOf("--table-id") + 1];
        return {
          exit_code: 0,
          stdout: JSON.stringify(table === "运行配置"
            ? {
                ok: true,
                data: {
                  fields: ["数字分身启用", "允许域", "个性化规则"],
                  data: [[true, invalidValue, ""]]
                }
              }
            : {
                ok: true,
                data: { fields: ["启用", "群ID", "个性化规则"], data: [] }
              }),
          stderr: ""
        };
      }
    }), /Base console 允许域/u);
  }
});

test("空的群级规则表是有效配置", async () => {
  const config = await loadBaseConsole({
    profile: "example_profile",
    allowed_lark_domains: ["im"],
    authority_rules: ["本地默认规则"],
    console: {
      base_token: "base_x",
      runtime_table: "运行配置",
      group_rules_table: "群级规则"
    }
  }, {
    runner: async (argv) => {
      const table = argv[argv.indexOf("--table-id") + 1];
      return {
        exit_code: 0,
        stdout: JSON.stringify(table === "运行配置"
          ? {
              ok: true,
              data: {
                fields: ["数字分身启用", "允许域", "个性化规则"],
                data: [[false, "继承", ""]]
              }
            }
          : { ok: true, data: { fields: ["启用", "群ID", "个性化规则"], data: [] } }),
        stderr: ""
      };
    }
  });

  assert.deepEqual(config.group_rules, []);
  assert.equal(config.production_enabled, false);
  assert.equal(Object.hasOwn(config, "startup_frozen"), false);
});

test("Base 控制台两张表即使无群规则也必须保留必要字段结构", async () => {
  const completeRuntimeFields = ["数字分身启用", "允许域", "个性化规则"];
  const completeGroupFields = ["启用", "群ID", "个性化规则"];
  const cases = [
    { table: "运行配置", fields: ["数字分身启用", "个性化规则"] },
    { table: "运行配置", fields: ["数字分身启用", "允许域"] },
    { table: "运行配置", fields: ["允许域", "个性化规则"] },
    { table: "群级规则", fields: ["群ID", "个性化规则"] },
    { table: "群级规则", fields: ["启用", "个性化规则"] },
    { table: "群级规则", fields: ["启用", "群ID"] }
  ];

  for (const fixture of cases) {
    await assert.rejects(() => loadBaseConsole({
      profile: "example_profile",
      control: { mode: "base" },
      allowed_lark_domains: ["im", "base"],
      console: {
        base_token: "base_x",
        runtime_table: "运行配置",
        group_rules_table: "群级规则"
      }
    }, {
      runner: async (argv) => {
        const table = argv[argv.indexOf("--table-id") + 1];
        const fields = table === fixture.table
          ? fixture.fields
          : table === "运行配置"
            ? completeRuntimeFields
            : completeGroupFields;
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: {
              fields,
              data: table === "运行配置"
                ? [[...fields].map((field) => ({
                    数字分身启用: true,
                    允许域: "继承",
                    个性化规则: ""
                  })[field])]
                : []
            }
          }),
          stderr: ""
        };
      }
    }), /required fields/u);
  }
});

test("Base 运行表继续兼容旧总开关字段生产执行", async () => {
  const config = await loadBaseConsole({
    profile: "example_profile",
    control: { mode: "base" },
    allowed_lark_domains: ["im", "base"],
    console: {
      base_token: "base_x",
      runtime_table: "运行配置",
      group_rules_table: "群级规则"
    }
  }, {
    runner: async (argv) => {
      const table = argv[argv.indexOf("--table-id") + 1];
      return {
        exit_code: 0,
        stdout: JSON.stringify(table === "运行配置" ? {
          ok: true,
          data: {
            fields: ["生产执行", "允许域", "个性化规则"],
            data: [[true, "继承", ""]]
          }
        } : {
          ok: true,
          data: { fields: ["启用", "群ID", "个性化规则"], data: [] }
        }),
        stderr: ""
      };
    }
  });

  assert.equal(config.production_enabled, true);
  assert.deepEqual(config.allowed_lark_domains, ["im", "base"]);
});

test("总开关使用短缓存刷新，避免每条消息都读取两张 Base 表", async () => {
  let currentTime = 1_000;
  let enabled = false;
  let calls = 0;
  const refresh = createBaseRuntimeSwitchRefresher({
    profile: "example_profile",
    production_enabled: false,
    console: {
      base_token: "base_x",
      runtime_table: "运行配置",
      group_rules_table: "群级规则"
    }
  }, {
    ttlMs: 10_000,
    now: () => currentTime,
    runner: async () => {
      calls += 1;
      return {
        exit_code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            fields: ["数字分身启用", "允许域", "个性化规则"],
            data: [[enabled, "继承", ""]]
          }
        }),
        stderr: ""
      };
    }
  });

  assert.equal(await refresh(), false);
  assert.equal(calls, 0);
  enabled = true;
  currentTime += 10_000;
  assert.equal(await refresh(), true);
  assert.equal(calls, 1);
  currentTime += 1_000;
  assert.equal(await refresh(), true);
  assert.equal(calls, 1);
});

test("统一短缓存到期后刷新总开关、权限上限内的允许域和自然语言规则", async () => {
  let currentTime = 1_000;
  let calls = 0;
  const staticConfig = {
    profile: "example_profile",
    production_enabled: false,
    allowed_lark_domains: ["im", "task"],
    authority_rules: ["本机默认规则"],
    group_rules: [],
    console: {
      base_token: "base_x",
      runtime_table: "运行配置",
      group_rules_table: "群级规则"
    }
  };
  const refresh = createBaseConsoleRefresher(staticConfig, {
    initialConfig: {
      ...staticConfig,
      authority_rules: ["旧规则"],
      group_rules: [{ chat_id: "oc_old", rules: ["旧群规则"] }]
    },
    ttlMs: 10_000,
    now: () => currentTime,
    runner: async (argv) => {
      calls += 1;
      const table = argv[argv.indexOf("--table-id") + 1];
      return {
        exit_code: 0,
        stdout: JSON.stringify(table === "运行配置" ? {
          ok: true,
          data: {
            fields: ["数字分身启用", "允许域", "个性化规则"],
            data: [[true, ["im"], "新规则\n企业知识库：产品；space_id=space_product"]]
          }
        } : {
          ok: true,
          data: {
            fields: ["启用", "群ID", "个性化规则"],
            data: [[true, "oc_new", "新群规则"]]
          }
        }),
        stderr: ""
      };
    }
  });

  assert.deepEqual(await refresh(), {
    ...staticConfig,
    authority_rules: ["旧规则"],
    group_rules: [{ chat_id: "oc_old", rules: ["旧群规则"] }]
  });
  assert.equal(calls, 0);

  currentTime += 10_000;
  const refreshed = await refresh();
  assert.equal(calls, 2);
  assert.equal(refreshed.production_enabled, true);
  assert.deepEqual(refreshed.allowed_lark_domains, ["im"]);
  assert.deepEqual(refreshed.authority_rules, [
    "新规则",
    "企业知识库：产品；space_id=space_product"
  ]);
  assert.deepEqual(refreshed.group_rules, [{ chat_id: "oc_new", rules: ["新群规则"] }]);

  currentTime += 1_000;
  assert.deepEqual(await refresh(), refreshed);
  assert.equal(calls, 2);
});
