import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const repoRoot = join(import.meta.dirname, "..");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("install.sh", () => {
  it(
    "既存 Codex hook を保持し、chima hook と共通 skill を重複なく配置する",
    async () => {
    const home = await mkdtemp(join(tmpdir(), "chima-install-test-"));
    temporaryDirectories.push(home);
    const codexHome = join(home, ".codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "hooks.json"),
      JSON.stringify({
        retained: "value",
        hooks: {
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "/existing/hook.sh" }],
            },
          ],
        },
      }),
      "utf8",
    );
    const environment = {
      ...process.env,
      HOME: home,
      CHIMA_HOME: join(home, ".chima"),
      CODEX_HOME: codexHome,
      CHIMA_SKIP_LAUNCHD: "1",
    };

    await execFileAsync("bash", [join(repoRoot, "install.sh")], { env: environment });
    await execFileAsync("bash", [join(repoRoot, "install.sh")], { env: environment });

    const config = JSON.parse(
      await readFile(join(codexHome, "hooks.json"), "utf8"),
    ) as {
      retained: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(config.retained).toBe("value");
    expect(commands(config, "PostToolUse")).toContain("/existing/hook.sh");
    expect(
      commands(config, "PostToolUse").filter((command) =>
        command.endsWith("context-guard.sh"),
      ),
    ).toHaveLength(1);
    expect(
      commands(config, "Stop").filter((command) =>
        command.endsWith("stop-gate.sh"),
      ),
    ).toHaveLength(1);

    const commonSkill = await readFile(
      join(repoRoot, "connectors", "common", "skills", "worker-run", "SKILL.md"),
      "utf8",
    );
    await expect(
      readFile(join(codexHome, "skills", "worker-run", "SKILL.md"), "utf8"),
    ).resolves.toBe(commonSkill);
    await expect(
      readFile(join(home, ".claude", "skills", "worker-run", "SKILL.md"), "utf8"),
    ).resolves.toBe(commonSkill);
    },
  );
});

function commands(
  config: { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> },
  event: string,
): string[] {
  return (config.hooks[event] ?? []).flatMap((group) =>
    group.hooks.map((hook) => hook.command),
  );
}
