import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { kickProject } from "../src/commands/kick.js";
import { launchProject } from "../src/commands/launch.js";
import type { TmuxClient } from "../src/lib/tmux.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("launchProject", () => {
  it("tmux で worker-run を起動し既存 state を保持して lock と last_run を記録する", async () => {
    const home = await makeHome();
    await writeProjectState(home, {
      last_result: "crashed",
      retained: "value",
      wrapup_requested_at: "2026-07-11T00:00:00.000Z",
      checkpoint_done_at: "2026-07-11T00:01:00.000Z",
    });
    const tmux = mockTmux();

    await launchProject(
      "magonote",
      env(home),
      at("2026-07-12T01:00:00.000Z"),
      tmux,
    );

    expect(tmux.newSession).toHaveBeenCalledWith(
      "chima-magonote",
      "/repo/magonote",
      "claude",
      [
        "--permission-mode",
        "auto",
        "--model",
        "claude-sonnet-5",
        "/worker-run magonote",
      ],
      expect.objectContaining({ CHIMA_PROJECT: "magonote" }),
    );
    await expect(readProjectState(home)).resolves.toMatchObject({
      retained: "value",
      last_result: "crashed",
      last_run: "2026-07-12T01:00:00.000Z",
      lock: {
        tmux_session: "chima-magonote",
        started_at: "2026-07-12T01:00:00.000Z",
      },
      worker_ready_at: null,
      wrapup_requested_at: null,
      checkpoint_done_at: null,
    });
  });
});

describe("kickProject", () => {
  it("収束指示を送り既存 state を保持して wrapup_requested_at を記録する", async () => {
    const home = await makeHome();
    await writeProjectState(home, {
      retained: "value",
      lock: {
        tmux_session: "chima-magonote",
        started_at: "2026-07-12T00:00:00.000Z",
      },
    });
    const tmux = mockTmux();

    await kickProject(
      "magonote",
      "テスト理由",
      env(home),
      at("2026-07-12T01:00:00.000Z"),
      tmux,
    );

    expect(tmux.sendKeys).toHaveBeenCalledWith(
      "chima-magonote",
      "収束指示: テスト理由。新規作業を止めて worker-run の収束プロトコルを今すぐ実行して終了してください",
    );
    await expect(readProjectState(home)).resolves.toMatchObject({
      retained: "value",
      wrapup_requested_at: "2026-07-12T01:00:00.000Z",
      lock: { tmux_session: "chima-magonote" },
    });
  });
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "chima-launch-kick-test-"));
  temporaryDirectories.push(home);
  await mkdir(join(home, "config"), { recursive: true });
  await mkdir(join(home, "state", "projects"), { recursive: true });
  await writeJson(join(home, "config", "projects.json"), {
    projects: [projectConfig()],
  });
  return home;
}

function projectConfig(): Record<string, unknown> {
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

function mockTmux(): TmuxClient {
  return {
    newSession: vi.fn(async () => undefined),
    sendKeys: vi.fn(async () => undefined),
    hasSession: vi.fn(async () => true),
    killSession: vi.fn(async () => undefined),
  };
}

async function writeProjectState(
  home: string,
  value: Record<string, unknown>,
): Promise<void> {
  await writeJson(join(home, "state", "projects", "magonote.json"), value);
}

async function readProjectState(
  home: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(home, "state", "projects", "magonote.json"), "utf8"),
  ) as Record<string, unknown>;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), "utf8");
}

function env(home: string): NodeJS.ProcessEnv {
  return { CHIMA_HOME: home };
}

function at(value: string): () => Date {
  return () => new Date(value);
}
