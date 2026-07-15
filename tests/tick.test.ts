import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decideLockAction,
  hasActionableWork,
  isProjectDue,
  isWithinActiveHours,
  tick,
} from "../src/commands/tick.js";
import type { ProjectConfig } from "../src/lib/projects.js";
import type { ProjectState } from "../src/lib/project-state.js";
import type { TmuxClient } from "../src/lib/tmux.js";

const temporaryDirectories: string[] = [];
const NOW = new Date(2026, 6, 12, 10, 0, 0);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("due 判定", () => {
  it("interval_min 経過後かつ active_hours 内かつ lock なしなら due", () => {
    expect(
      isProjectDue(projectConfig(), { last_run: minutesBefore(30) }, NOW),
    ).toBe(true);
  });

  it("interval_min 経過前なら due ではない", () => {
    expect(
      isProjectDue(projectConfig(), { last_run: minutesBefore(29) }, NOW),
    ).toBe(false);
  });

  it("active_hours 外なら due ではない", () => {
    expect(
      isProjectDue(
        { ...projectConfig(), active_hours: "11-24" },
        { last_run: minutesBefore(30) },
        NOW,
      ),
    ).toBe(false);
  });

  it("lock があれば due ではない", () => {
    expect(
      isProjectDue(
        projectConfig(),
        { last_run: minutesBefore(30), lock: lock() },
        NOW,
      ),
    ).toBe(false);
  });

  it("日付をまたぐ active_hours を判定する", () => {
    expect(isWithinActiveHours("22-06", new Date(2026, 6, 12, 23))).toBe(true);
    expect(isWithinActiveHours("22-06", new Date(2026, 6, 12, 7))).toBe(false);
  });
});

describe("lock 判定", () => {
  it("tmux セッションがなければ crashed", () => {
    expect(decideLockAction(projectConfig(), { lock: lock() }, false, NOW)).toEqual({
      type: "crashed",
    });
  });

  it("checkpoint_done_at があれば done", () => {
    expect(
      decideLockAction(
        projectConfig(),
        { lock: lock(), checkpoint_done_at: NOW.toISOString() },
        true,
        NOW,
      ),
    ).toEqual({ type: "done" });
  });

  it("work_budget_min を超過し未 kick なら kick", () => {
    expect(
      decideLockAction(
        projectConfig(),
        { lock: lock(minutesBefore(21)) },
        true,
        NOW,
      ),
    ).toEqual({ type: "kick" });
  });

  it("kick から5分経過後も生きていれば killed", () => {
    expect(
      decideLockAction(
        projectConfig(),
        {
          lock: lock(minutesBefore(21)),
          wrapup_requested_at: minutesBefore(5),
        },
        true,
        NOW,
      ),
    ).toEqual({ type: "killed" });
  });
});

describe("着手可能な作業の判定", () => {
  it("未読の人間コメントがあれば着手可能", () => {
    expect(
      hasActionableWork(
        actionableIssue({ comments: [humanComment(minutesBefore(2))] }),
        minutesBefore(10),
      ),
    ).toBe(true);
  });

  it.each(["unstarted", "started"])(
    "%s の子イシューがあれば着手可能",
    (stateType) => {
      expect(
        hasActionableWork(
          actionableIssue({ children: [{ id: "child-id", stateType }] }),
          NOW.toISOString(),
        ),
      ).toBe(true);
    },
  );

  it.each(["backlog", "completed", "canceled"])(
    "%s の子イシューだけなら着手不可",
    (stateType) => {
      expect(
        hasActionableWork(
          actionableIssue({ children: [{ id: "child-id", stateType }] }),
          NOW.toISOString(),
        ),
      ).toBe(false);
    },
  );

  it("Chima の未読コメントだけなら着手不可", () => {
    expect(
      hasActionableWork(
        actionableIssue({
          comments: [
            { ...humanComment(minutesBefore(2)), userName: "CHIMA" },
          ],
        }),
        minutesBefore(10),
      ),
    ).toBe(false);
  });

  it("コメントも子イシューもなければ着手不可", () => {
    expect(
      hasActionableWork(actionableIssue(), minutesBefore(10)),
    ).toBe(false);
  });
});

describe("tick", () => {
  it("消えた tmux セッションを crashed として lock 解除する", async () => {
    const home = await makeHome({
      last_run: NOW.toISOString(),
      lock: lock(),
    });
    const dependencies = mockDependencies(false);

    await tick(env(home), dependencies);

    await expect(readState(home)).resolves.toMatchObject({
      lock: null,
      last_result: "crashed",
    });
  });

  it("checkpoint 済みの tmux セッションを kill して done とする", async () => {
    const home = await makeHome({
      last_run: NOW.toISOString(),
      lock: lock(),
      checkpoint_done_at: NOW.toISOString(),
    });
    const dependencies = mockDependencies(true);

    await tick(env(home), dependencies);

    expect(dependencies.tmux.killSession).toHaveBeenCalledWith("chima-magonote");
    await expect(readState(home)).resolves.toMatchObject({
      lock: null,
      last_result: "done",
    });
  });

  it("作業予算超過時に kick する", async () => {
    const home = await makeHome({
      last_run: NOW.toISOString(),
      lock: lock(minutesBefore(21)),
    });
    const dependencies = mockDependencies(true);

    await tick(env(home), dependencies);

    expect(dependencies.kick).toHaveBeenCalledWith("magonote", "作業予算超過");
  });

  it("kick 後5分経過時に tmux を kill して killed とする", async () => {
    const home = await makeHome({
      last_run: NOW.toISOString(),
      lock: lock(minutesBefore(21)),
      wrapup_requested_at: minutesBefore(5),
    });
    const dependencies = mockDependencies(true);

    await tick(env(home), dependencies);

    expect(dependencies.tmux.killSession).toHaveBeenCalledWith("chima-magonote");
    await expect(readState(home)).resolves.toMatchObject({
      lock: null,
      last_result: "killed",
    });
  });

  it("実行中に緊急コメントがあれば kick と再起動予約を行う", async () => {
    const home = await makeHome({
      last_run: NOW.toISOString(),
      last_seen_comment_at: minutesBefore(10),
      lock: lock(),
    });
    const dependencies = mockDependencies(true, issueWithEmergency());

    await tick(env(home), dependencies);

    expect(dependencies.kick).toHaveBeenCalledWith(
      "magonote",
      "https://linear.app/comment/1",
    );
    expect(dependencies.launch).not.toHaveBeenCalled();
    await expect(readState(home)).resolves.toMatchObject({
      last_seen_comment_at: NOW.toISOString(),
      restart_requested_at: NOW.toISOString(),
    });
  });

  it("非実行中に緊急コメントがあれば即 launch する", async () => {
    const home = await makeHome({
      last_run: NOW.toISOString(),
      last_seen_comment_at: minutesBefore(10),
      lock: null,
    });
    const dependencies = mockDependencies(true, issueWithEmergency());

    await tick(env(home), dependencies);

    expect(dependencies.launch).toHaveBeenCalledTimes(1);
    expect(dependencies.launch).toHaveBeenCalledWith("magonote");
    expect(dependencies.kick).not.toHaveBeenCalled();
    await expect(readState(home)).resolves.toMatchObject({
      last_seen_comment_at: NOW.toISOString(),
    });
  });

  it("緊急コメントがなければ launch も kick もせず last_seen_comment_at を更新する", async () => {
    const home = await makeHome({
      last_run: NOW.toISOString(),
      last_seen_comment_at: minutesBefore(10),
      lock: null,
    });
    const dependencies = mockDependencies(true, issueWithoutEmergency());

    await tick(env(home), dependencies);

    expect(dependencies.launch).not.toHaveBeenCalled();
    expect(dependencies.kick).not.toHaveBeenCalled();
    await expect(readState(home)).resolves.toMatchObject({
      last_seen_comment_at: NOW.toISOString(),
    });
  });

  it("サブイシューの緊急コメントも検知する", async () => {
    const home = await makeHome({
      last_run: NOW.toISOString(),
      last_seen_comment_at: minutesBefore(10),
      lock: null,
    });
    const dependencies = mockDependencies(true);
    dependencies.getIssue.mockImplementation(async (id) =>
      id === "DEV-10" ? issueWithChild() : issueWithEmergency(),
    );

    await tick(env(home), dependencies);

    expect(dependencies.getIssue).toHaveBeenCalledWith("child-id");
    expect(dependencies.launch).toHaveBeenCalledWith("magonote");
  });

  it("Chima の緊急コメントは検知対象から除外する", async () => {
    const home = await makeHome({
      last_run: NOW.toISOString(),
      last_seen_comment_at: minutesBefore(10),
      lock: null,
    });
    const issue = issueWithEmergency() as {
      comments: { nodes: Array<Record<string, unknown>> };
    };
    issue.comments.nodes[0]!.user = null;
    issue.comments.nodes[0]!.botActor = { id: "bot-1", name: "Chima" };
    const dependencies = mockDependencies(true, issue);

    await tick(env(home), dependencies);

    expect(dependencies.launch).not.toHaveBeenCalled();
    expect(dependencies.kick).not.toHaveBeenCalled();
  });

  it("restart 予約があり lock がなくなれば active_hours 外でも launch する", async () => {
    const home = await makeHome(
      {
        last_run: NOW.toISOString(),
        lock: null,
        restart_requested_at: minutesBefore(1),
      },
      { active_hours: "11-24" },
    );
    const dependencies = mockDependencies(true);

    await tick(env(home), dependencies);

    expect(dependencies.launch).toHaveBeenCalledWith("magonote");
  });

  it("各ステージの開始・完了をプロジェクト名付きで順番にログする", async () => {
    const home = await makeHome({
      last_run: NOW.toISOString(),
      lock: null,
    });
    const dependencies = mockDependencies(true);

    await tick(env(home), dependencies);

    expect(dependencies.logStage.mock.calls).toEqual([
      ["config読込", null, "start"],
      ["config読込", null, "done"],
      ["emergency-check", "magonote", "start"],
      ["emergency-check.fetch-comments", "magonote", "start"],
      ["emergency-check.fetch-comments", "magonote", "done"],
      ["emergency-check", "magonote", "done"],
      ["due判定・launch", null, "start"],
      ["due判定・launch", null, "done"],
    ]);
  });

  it("due な launch をプロジェクト名付きでログする", async () => {
    const home = await makeHome({
      last_run: minutesBefore(30),
      lock: null,
    });
    const dependencies = mockDependencies(true, issueWithActionableChild());

    await tick(env(home), dependencies);

    expect(dependencies.logStage.mock.calls).toEqual(
      expect.arrayContaining([
        ["due-launch", "magonote", "start"],
        ["due-launch", "magonote", "done"],
      ]),
    );
  });

  it("未読の人間コメントがあれば due-launch で launch する", async () => {
    const home = await makeHome({
      last_run: minutesBefore(30),
      last_seen_comment_at: minutesBefore(10),
      lock: null,
    });
    const dependencies = mockDependencies(true, issueWithoutEmergency());

    await tick(env(home), dependencies);

    expect(dependencies.launch).toHaveBeenCalledWith("magonote");
    expect(dependencies.logStage).toHaveBeenCalledWith(
      "due-launch",
      "magonote",
      "start",
    );
    expect(dependencies.logStage).toHaveBeenCalledWith(
      "due-launch",
      "magonote",
      "done",
    );
  });

  it("unstarted の子イシューがあれば due-launch で launch する", async () => {
    const home = await makeHome({
      last_run: minutesBefore(30),
      last_seen_comment_at: NOW.toISOString(),
      lock: null,
    });
    const dependencies = mockDependencies(true, issueWithActionableChild());

    await tick(env(home), dependencies);

    expect(dependencies.launch).toHaveBeenCalledWith("magonote");
  });

  it("着手可能な作業がなければ due-launch をスキップする", async () => {
    const home = await makeHome({
      last_run: minutesBefore(30),
      last_seen_comment_at: minutesBefore(10),
      lock: null,
    });
    const dependencies = mockDependencies(true);

    await tick(env(home), dependencies);

    expect(dependencies.launch).not.toHaveBeenCalled();
    expect(dependencies.logStage).toHaveBeenCalledWith(
      "due-launch",
      "magonote",
      "skipped",
    );
  });

  it("lock 超過時の kick をプロジェクト名付きでログする", async () => {
    const home = await makeHome({
      last_run: NOW.toISOString(),
      lock: lock(minutesBefore(21)),
    });
    const dependencies = mockDependencies(true);

    await tick(env(home), dependencies);

    expect(dependencies.logStage.mock.calls).toEqual(
      expect.arrayContaining([
        ["lock-check", "magonote", "start"],
        ["lock-check.kick", "magonote", "start"],
        ["lock-check.kick", "magonote", "done"],
        ["lock-check", "magonote", "done"],
      ]),
    );
  });
});

async function makeHome(
  state: ProjectState,
  projectOverrides: Partial<ProjectConfig> = {},
): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "chima-tick-test-"));
  temporaryDirectories.push(home);
  await mkdir(join(home, "config"), { recursive: true });
  await mkdir(join(home, "state", "projects"), { recursive: true });
  await writeJson(join(home, "config", "projects.json"), {
    projects: [{ ...projectConfig(), ...projectOverrides }],
  });
  await writeJson(join(home, "state", "projects", "magonote.json"), state);
  return home;
}

function mockDependencies(sessionExists: boolean, issue: unknown = emptyIssue()) {
  const tmux: TmuxClient = {
    newSession: vi.fn(async () => undefined),
    sendKeys: vi.fn(async () => undefined),
    hasSession: vi.fn(async () => sessionExists),
    killSession: vi.fn(async () => undefined),
  };
  return {
    now: () => NOW,
    tmux,
    getIssue: vi.fn(async (_id: string) => issue),
    launch: vi.fn(async () => undefined),
    kick: vi.fn(async () => undefined),
    logStage: vi.fn(),
  };
}

function projectConfig(): ProjectConfig {
  return {
    name: "magonote",
    repo: "/repo/magonote",
    parent_issue: "DEV-10",
    interval_min: 30,
    work_budget_min: 20,
    active_hours: "09-24",
    orchestrator_model: "claude-sonnet-5",
    enabled: true,
  };
}

function lock(startedAt = minutesBefore(1)) {
  return { tmux_session: "chima-magonote", started_at: startedAt };
}

function emptyIssue(): unknown {
  return { id: "parent", children: { nodes: [] }, comments: { nodes: [] } };
}

function issueWithEmergency(): unknown {
  return {
    id: "parent",
    children: { nodes: [] },
    comments: {
      nodes: [
        {
          body: "[今すぐ確認] 状態を確認してください",
          url: "https://linear.app/comment/1",
          createdAt: minutesBefore(2),
          updatedAt: minutesBefore(2),
          user: { id: "user-1", name: "Sota" },
          botActor: null,
        },
      ],
    },
  };
}

function issueWithoutEmergency(): unknown {
  return {
    id: "parent",
    children: { nodes: [] },
    comments: {
      nodes: [
        {
          body: "通常コメントです",
          url: "https://linear.app/comment/2",
          createdAt: minutesBefore(2),
          updatedAt: minutesBefore(2),
          user: { id: "user-1", name: "Sota" },
          botActor: null,
        },
      ],
    },
  };
}

function issueWithChild(): unknown {
  return {
    id: "parent",
    children: { nodes: [{ id: "child-id" }] },
    comments: { nodes: [] },
  };
}

function issueWithActionableChild(): unknown {
  return {
    id: "parent",
    children: {
      nodes: [
        { id: "child-id", state: { id: "state-1", type: "unstarted" } },
      ],
    },
    comments: { nodes: [] },
  };
}

function actionableIssue(
  overrides: {
    children?: Array<{ id: string; stateType: string | null }>;
    comments?: Array<ReturnType<typeof humanComment>>;
  } = {},
) {
  return {
    id: "parent",
    children: overrides.children ?? [],
    comments: overrides.comments ?? [],
  };
}

function humanComment(timestamp: string) {
  return {
    body: "通常コメントです",
    url: "https://linear.app/comment/human",
    createdAt: timestamp,
    updatedAt: timestamp,
    userName: "Sota" as string | null,
    botName: null as string | null,
  };
}

async function readState(home: string): Promise<ProjectState> {
  return JSON.parse(
    await readFile(join(home, "state", "projects", "magonote.json"), "utf8"),
  ) as ProjectState;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), "utf8");
}

function env(home: string): NodeJS.ProcessEnv {
  return { CHIMA_HOME: home };
}

function minutesBefore(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60 * 1000).toISOString();
}
