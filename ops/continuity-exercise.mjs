import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runControlledChange } from "./continuity-gate.mjs";

export async function runIsolatedContinuityExercise() {
  const root = await mkdtemp(path.join(tmpdir(), "twin-continuity-exercise-"));
  const runtimeRoot = path.join(root, ".runtime");
  const configPath = path.join(runtimeRoot, "config.json");
  const databasePath = path.join(runtimeRoot, "state.sqlite");
  try {
    await mkdir(runtimeRoot, { mode: 0o700 });
    await writeFile(configPath, JSON.stringify({ profile: "fake" }), { mode: 0o600 });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("CREATE TABLE exercise_state (version INTEGER NOT NULL)");
      database.prepare("INSERT INTO exercise_state (version) VALUES (1)").run();
    } finally {
      database.close();
    }
    await chmod(databasePath, 0o600);

    const fakeLarkAdapter = {
      callCount: 0,
      async dryRun() {
        this.callCount += 1;
        return { ok: true, dry_run: true };
      }
    };
    const fakeInferenceAdapter = {
      callCount: 0,
      async decide() {
        this.callCount += 1;
        return { outcome: "ignore" };
      }
    };
    const readVersion = () => {
      const state = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return state.prepare("SELECT version FROM exercise_state").get()?.version;
      } finally {
        state.close();
      }
    };
    const writeVersion = (version) => {
      const state = new DatabaseSync(databasePath);
      try {
        state.prepare("UPDATE exercise_state SET version = ?").run(version);
      } finally {
        state.close();
      }
    };
    const isolatedTest = async () => {
      const config = JSON.parse(await readFile(configPath, "utf8"));
      const [lark, inference] = await Promise.all([
        fakeLarkAdapter.dryRun(),
        fakeInferenceAdapter.decide()
      ]);
      if (
        config.profile !== "fake" ||
        readVersion() !== 1 ||
        lark.ok !== true ||
        lark.dry_run !== true ||
        inference.outcome !== "ignore"
      ) {
        throw new Error("isolated continuity fixture is invalid");
      }
    };

    const successScenario = await runControlledChange({
      serviceRole: "fake-realtime",
      precheck: async () => ({ healthy: readVersion() === 1 }),
      isolatedTest,
      applyChange: async () => { writeVersion(2); },
      switchService: async () => {},
      postcheck: async () => ({ healthy: readVersion() === 2 }),
      rollbackChange: async () => { writeVersion(1); },
      verifyRollback: async () => ({ healthy: readVersion() === 1 })
    });
    const successPersistedVersion = readVersion();
    writeVersion(1);

    const rollbackScenario = await runControlledChange({
      serviceRole: "fake-realtime",
      precheck: async () => ({ healthy: readVersion() === 1 }),
      isolatedTest,
      applyChange: async () => { writeVersion(2); },
      switchService: async () => {},
      postcheck: async () => ({ healthy: false }),
      rollbackChange: async () => { writeVersion(1); },
      verifyRollback: async () => ({ healthy: readVersion() === 1 })
    });
    const rollbackPersistedVersion = readVersion();

    return {
      schema_version: 1,
      healthy: successScenario.status === "complete" &&
        rollbackScenario.status === "rolled-back" &&
        successPersistedVersion === 2 &&
        rollbackPersistedVersion === 1 &&
        fakeLarkAdapter.callCount === 2 &&
        fakeInferenceAdapter.callCount === 2,
      isolation: {
        temporary_config: true,
        temporary_sqlite: true,
        fake_lark_adapter: true,
        fake_inference_adapter: true,
        fake_lark_call_count: fakeLarkAdapter.callCount,
        fake_inference_call_count: fakeInferenceAdapter.callCount
      },
      success_scenario: {
        ...successScenario,
        persisted_version: successPersistedVersion
      },
      rollback_scenario: {
        ...rollbackScenario,
        persisted_version: rollbackPersistedVersion
      },
      real_feishu_write_performed: false,
      real_service_reload_performed: false
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
