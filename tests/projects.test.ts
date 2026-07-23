import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findProjectConfig, readProjectsConfig } from "../src/lib/projects.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("readProjectsConfig", () => {
  it("worker フィールドが無い旧スキーマの設定は、無音で除外せずエラーにする", async () => {
    const home = await makeConfigHome({
      projects: [
        {
          name: "legacy",
          repo: "/repo",
          parent_issue: "DEV-1",
          interval_min: 30,
          work_budget_min: 20,
          active_hours: "09-24",
          orchestrator_model: "claude-sonnet-5",
          enabled: true,
        },
      ],
    });

    await expect(readProjectsConfig({ CHIMA_HOME: home })).rejects.toThrow(
      /legacy.*worker/s,
    );
  });

  it("worker フィールドを持つ設定はそのまま読み込める", async () => {
    const home = await makeConfigHome({
      projects: [
        {
          name: "chima",
          repo: "/repo",
          parent_issue: "DEV-10",
          interval_min: 30,
          work_budget_min: 20,
          active_hours: "09-24",
          worker: {
            runtime: "claude-code",
            model: "claude-sonnet-5",
            planner_model: "claude-fable-5",
          },
          enabled: true,
        },
      ],
    });

    await expect(
      readProjectsConfig({ CHIMA_HOME: home }),
    ).resolves.toHaveLength(1);
  });
});

describe("findProjectConfig", () => {
  it("worker フィールドが無いプロジェクトは不正な設定としてエラーにする", async () => {
    const home = await makeConfigHome({
      projects: [
        { name: "legacy", repo: "/repo", orchestrator_model: "claude-sonnet-5" },
      ],
    });

    await expect(
      findProjectConfig("legacy", { CHIMA_HOME: home }),
    ).rejects.toThrow(/不正/);
  });

  it("該当プロジェクトが無ければ未登録としてエラーにする", async () => {
    const home = await makeConfigHome({ projects: [] });

    await expect(
      findProjectConfig("missing", { CHIMA_HOME: home }),
    ).rejects.toThrow("プロジェクト設定がありません: missing");
  });
});

async function makeConfigHome(config: unknown): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "chima-projects-test-"));
  temporaryDirectories.push(home);
  await mkdir(join(home, "config"), { recursive: true });
  await writeFile(
    join(home, "config", "projects.json"),
    JSON.stringify(config),
    "utf8",
  );
  return home;
}
