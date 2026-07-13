import { spawn } from "node:child_process";
import { symlink, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// child_process.execFile's promisified form is flaky with the `input`
// option (it can hang indefinitely instead of writing to stdin and
// closing it), so this test spawns the process directly and manages
// stdin/stdout/stderr itself.
function run(command: string, args: string[], options: {
  input?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env: options.env });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });

    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const binChima = join(repoRoot, "bin", "chima");
const fixturePath = join(repoRoot, "tests", "fixtures", "statusline.json");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

// bin/chima is installed as a symlink (see install.sh: `ln -sfn
// "${CHIMA_BIN}" "${LOCAL_BIN}/chima"`). process.argv[1] then points at the
// symlink while the loaded module resolves to the physical dist/cli.js
// path; the CLI must still run subcommands when invoked this way.
describe("chima entrypoint via symlink", () => {
  it("runs `session record` through a symlinked bin/chima", async () => {
    const home = await mkdtemp(join(tmpdir(), "chima-symlink-home-"));
    const binDir = await mkdtemp(join(tmpdir(), "chima-symlink-bin-"));
    temporaryDirectories.push(home, binDir);

    const symlinkedChima = join(binDir, "chima");
    await symlink(binChima, symlinkedChima);

    const fixture = await readFile(fixturePath, "utf8");
    const { code, stdout } = await run(symlinkedChima, ["session", "record"], {
      input: fixture,
      env: { ...process.env, CHIMA_HOME: home },
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(JSON.parse(fixture));

    const statePath = join(home, "state", "sessions", "session-123.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      used_pct: number;
      duration_ms: number;
    };
    expect(state.used_pct).toBe(42.5);
    expect(state.duration_ms).toBe(123456);
  });

  it("prints usage for an unknown command through a symlinked bin/chima", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "chima-symlink-bin-"));
    temporaryDirectories.push(binDir);

    const symlinkedChima = join(binDir, "chima");
    await symlink(binChima, symlinkedChima);

    const { code, stderr } = await run(symlinkedChima, ["not-a-real-command"], {});

    expect(code).toBe(1);
    expect(stderr).toContain("usage: chima <command>");
  });
});
