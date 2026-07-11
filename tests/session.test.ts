import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { recordSession } from "../src/commands/session.js";
import { runCli } from "../src/cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("session record", () => {
  it("statusline JSON を state に記録して入力をそのまま返す", async () => {
    const home = await makeTemporaryHome();
    const fixture = await readFile(
      join(import.meta.dirname, "fixtures", "statusline.json"),
      "utf8",
    );
    const output = await recordSession(
      fixture,
      { CHIMA_HOME: home, CHIMA_PROJECT: "magonote" },
      () => new Date("2026-07-11T01:02:03.000Z"),
    );

    expect(output).toBe(fixture);
    await expect(
      readFile(join(home, "state", "sessions", "session-123.json"), "utf8"),
    ).resolves.toBe(
      `${JSON.stringify(
        {
          used_pct: 42.5,
          duration_ms: 123456,
          updated_at: "2026-07-11T01:02:03.000Z",
          project: "magonote",
        },
        null,
        2,
      )}\n`,
    );

    for (const directory of [
      "config",
      "state/sessions",
      "state/projects",
      "state/pending",
      "logs",
    ]) {
      await expect(stat(join(home, directory))).resolves.toMatchObject({});
    }
  });

  it("壊れた JSON でも入力をそのまま返す", async () => {
    const home = await makeTemporaryHome();
    const input = "{broken json\n";
    let stdout = "";

    await expect(
      runCli(
        ["node", "chima", "session", "record"],
        { CHIMA_HOME: home },
        {
          stdin: Readable.from([input]),
          writeStdout: (value) => {
            stdout += value;
          },
          writeStderr: vi.fn(),
        },
      ),
    ).resolves.toBe(0);
    expect(stdout).toBe(input);
  });

  it("書き込みに失敗しても入力をそのまま返す", async () => {
    const home = await makeTemporaryHome();
    const fixture = await readFile(
      join(import.meta.dirname, "fixtures", "statusline.json"),
      "utf8",
    );
    const fileHome = join(home, "file-home");
    await writeFile(fileHome, "not a directory", "utf8");

    await expect(recordSession(fixture, { CHIMA_HOME: fileHome })).resolves.toBe(
      fixture,
    );
  });
});

async function makeTemporaryHome(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "chima-session-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
