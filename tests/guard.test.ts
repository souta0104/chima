import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { guard, stopGate } from "../src/commands/guard.js";
import { runCli } from "../src/cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("guard", () => {
  it("context 使用率が閾値以上なら収束指示を返す", async () => {
    const home = await makeGuardHome();
    await writeSession(home, { used_pct: 40, duration_ms: 1 });

    const output = await guard(hookInput(), env(home));

    expect(JSON.parse(output)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: expect.stringContaining("収束プロトコル"),
      },
    });
  });

  it("経過時間が予算以上なら収束指示を返す", async () => {
    const home = await makeGuardHome();
    await writeSession(home, { used_pct: 1, duration_ms: 20 * 60 * 1000 });

    await expect(guard(hookInput(), env(home))).resolves.not.toBe("");
  });

  it("context 使用率と経過時間が両方とも閾値未満なら何も返さない", async () => {
    const home = await makeGuardHome();
    await writeSession(home, {
      used_pct: 39.9,
      duration_ms: 20 * 60 * 1000 - 1,
    });

    await expect(guard(hookInput(), env(home))).resolves.toBe("");
  });

  it("used_pct がなくても経過時間だけで収束指示を返す", async () => {
    const home = await makeGuardHome();
    await writeSession(home, {
      duration_ms: 20 * 60 * 1000,
    });

    await expect(guard(hookInput(), env(home))).resolves.not.toBe("");
  });

  it("初回と 2 分経過後だけ収束指示を返す", async () => {
    const home = await makeGuardHome();
    await writeSession(home, { used_pct: 50, duration_ms: 1 });

    await expect(
      guard(hookInput(), env(home), at("2026-07-11T00:00:00.000Z")),
    ).resolves.not.toBe("");
    await expect(
      guard(hookInput(), env(home), at("2026-07-11T00:01:59.999Z")),
    ).resolves.toBe("");
    await expect(
      guard(hookInput(), env(home), at("2026-07-11T00:02:00.000Z")),
    ).resolves.not.toBe("");

    await expect(readProjectState(home)).resolves.toMatchObject({
      wrapup_requested_at: "2026-07-11T00:02:00.000Z",
    });
  });

  it("CHIMA_PROJECT がなければ何も返さない", async () => {
    await expect(guard(hookInput(), {})).resolves.toBe("");
  });

  it("CLI から PostToolUse 用の処理を呼び出せる", async () => {
    const home = await makeGuardHome();
    await writeSession(home, { used_pct: 40, duration_ms: 1 });
    let stdout = "";

    await expect(
      runCli(["node", "chima", "guard"], env(home), {
        stdin: Readable.from([hookInput()]),
        writeStdout: (value) => {
          stdout += value;
        },
        writeStderr: () => undefined,
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput.hookEventName).toBe(
      "PostToolUse",
    );
  });
});

describe("guard --stop-gate", () => {
  it("wrapup_requested_at がなければブロックしない", async () => {
    const home = await makeGuardHome();
    await writeProjectState(home, { last_result: "done" });

    await expect(stopGate(hookInput(), env(home))).resolves.toBe("");
  });

  it("wrapup_requested_at があり checkpoint_done_at がなければブロックする", async () => {
    const home = await makeGuardHome();
    await writeProjectState(home, {
      wrapup_requested_at: "2026-07-11T00:00:00.000Z",
    });

    const output = await stopGate(
      hookInput(),
      env(home),
      at("2026-07-11T00:01:00.000Z"),
    );

    expect(JSON.parse(output)).toEqual({
      decision: "block",
      reason:
        "Linear へのチェックポイント記録が未完了。収束プロトコルを完了させてから終了してください",
    });
    await expect(readProjectState(home)).resolves.toMatchObject({
      stop_gate_blocked_at: "2026-07-11T00:01:00.000Z",
      stop_gate_blocked_session_id: "session-123",
    });
  });

  it("同じセッションを一度ブロックした後はブロックしない", async () => {
    const home = await makeGuardHome();
    await writeProjectState(home, {
      wrapup_requested_at: "2026-07-11T00:00:00.000Z",
    });

    await expect(stopGate(hookInput(), env(home))).resolves.not.toBe("");
    await expect(stopGate(hookInput(), env(home))).resolves.toBe("");
  });
});

async function makeGuardHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "chima-guard-test-"));
  temporaryDirectories.push(home);
  await mkdir(join(home, "config"), { recursive: true });
  await mkdir(join(home, "state", "sessions"), { recursive: true });
  await mkdir(join(home, "state", "projects"), { recursive: true });
  await writeJson(join(home, "config", "projects.json"), {
    projects: [
      {
        name: "magonote",
        context_threshold_pct: 40,
        work_budget_min: 20,
      },
    ],
  });
  return home;
}

async function writeSession(
  home: string,
  values: { used_pct?: number | null; duration_ms?: number | null },
): Promise<void> {
  await writeJson(join(home, "state", "sessions", "session-123.json"), {
    ...values,
    updated_at: "2026-07-11T00:00:00.000Z",
    project: "magonote",
  });
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
    await readFile(
      join(home, "state", "projects", "magonote.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), "utf8");
}

function hookInput(): string {
  return JSON.stringify({ session_id: "session-123" });
}

function env(home: string): NodeJS.ProcessEnv {
  return { CHIMA_HOME: home, CHIMA_PROJECT: "magonote" };
}

function at(value: string): () => Date {
  return () => new Date(value);
}
