import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { getStatus } from "../src/commands/status.js";
import { runCli } from "../src/cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("status --json", () => {
  it("config がない場合は空の projects を返す", async () => {
    const home = await makeTemporaryHome();
    let stdout = "";

    await expect(
      runCli(
        ["node", "chima", "status", "--json"],
        { CHIMA_HOME: home },
        {
          stdin: Readable.from([]),
          writeStdout: (value) => {
            stdout += value;
          },
          writeStderr: () => undefined,
        },
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(stdout)).toEqual({ projects: [] });
  });

  it("project state と lock 中の最新 session を返す", async () => {
    const home = await makeTemporaryHome();
    await mkdir(join(home, "config"), { recursive: true });
    await mkdir(join(home, "state", "projects"), { recursive: true });
    await mkdir(join(home, "state", "sessions"), { recursive: true });
    await writeJson(join(home, "config", "projects.json"), {
      projects: [
        { name: "alpha", enabled: true },
        { name: "beta", enabled: false },
      ],
    });
    await writeJson(join(home, "state", "projects", "alpha.json"), {
      last_run: "2026-07-11T00:00:00.000Z",
      last_result: "done",
      lock: { tmux_session: "chima-alpha", started_at: "2026-07-11T00:00:00.000Z" },
      wrapup_requested_at: null,
      checkpoint_done_at: "2026-07-11T00:20:00.000Z",
    });
    await writeJson(join(home, "state", "sessions", "older.json"), {
      used_pct: 10,
      duration_ms: 1000,
      updated_at: "2026-07-11T00:01:00.000Z",
      project: "alpha",
    });
    await writeJson(join(home, "state", "sessions", "newer.json"), {
      used_pct: 20,
      duration_ms: 2000,
      updated_at: "2026-07-11T00:02:00.000Z",
      project: "alpha",
    });

    await expect(getStatus({ CHIMA_HOME: home })).resolves.toEqual({
      projects: [
        {
          name: "alpha",
          enabled: true,
          last_run: "2026-07-11T00:00:00.000Z",
          last_result: "done",
          lock: {
            tmux_session: "chima-alpha",
            started_at: "2026-07-11T00:00:00.000Z",
          },
          wrapup_requested_at: null,
          checkpoint_done_at: "2026-07-11T00:20:00.000Z",
          session: {
            used_pct: 20,
            duration_ms: 2000,
            updated_at: "2026-07-11T00:02:00.000Z",
          },
        },
        {
          name: "beta",
          enabled: false,
          last_run: null,
          last_result: null,
          lock: null,
          wrapup_requested_at: null,
          checkpoint_done_at: null,
          session: null,
        },
      ],
    });
  });

  it("lock 中でも該当 session がなければ session は null", async () => {
    const home = await makeTemporaryHome();
    await mkdir(join(home, "config"), { recursive: true });
    await mkdir(join(home, "state", "projects"), { recursive: true });
    await writeJson(join(home, "config", "projects.json"), {
      projects: [{ name: "alpha", enabled: true }],
    });
    await writeJson(join(home, "state", "projects", "alpha.json"), {
      lock: { tmux_session: "chima-alpha", started_at: "2026-07-11T00:00:00.000Z" },
    });

    const status = await getStatus({ CHIMA_HOME: home });
    expect(status.projects[0]?.session).toBeNull();
  });
});

async function makeTemporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chima-status-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), "utf8");
}
