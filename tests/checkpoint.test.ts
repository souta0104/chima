import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { completeCheckpoint } from "../src/commands/checkpoint.js";
import { runCli } from "../src/cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("checkpoint done", () => {
  it("既存フィールドを保持して checkpoint_done_at を更新する", async () => {
    const home = await makeTemporaryHome();
    const statePath = join(home, "state", "projects", "magonote.json");
    await mkdir(join(home, "state", "projects"), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        last_result: "done",
        wrapup_requested_at: "2026-07-11T00:00:00.000Z",
      }),
      "utf8",
    );

    await completeCheckpoint(
      "magonote",
      { CHIMA_HOME: home },
      () => new Date("2026-07-11T00:20:00.000Z"),
    );

    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      last_result: "done",
      wrapup_requested_at: "2026-07-11T00:00:00.000Z",
      checkpoint_done_at: "2026-07-11T00:20:00.000Z",
    });
  });

  it("CLI から checkpoint done を呼び出せる", async () => {
    const home = await makeTemporaryHome();

    await expect(
      runCli(
        ["node", "chima", "checkpoint", "done", "magonote"],
        { CHIMA_HOME: home },
        {
          stdin: Readable.from([]),
          writeStdout: () => undefined,
          writeStderr: () => undefined,
        },
      ),
    ).resolves.toBe(0);

    const state = JSON.parse(
      await readFile(
        join(home, "state", "projects", "magonote.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(state.checkpoint_done_at).toEqual(expect.any(String));
  });
});

async function makeTemporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "chima-checkpoint-test-"));
  temporaryDirectories.push(home);
  return home;
}
