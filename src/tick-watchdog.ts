import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const TICK_WATCHDOG_TIMEOUT_MS = 90_000;

interface TickWatchdogOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  writeStderr?: (value: string) => void;
}

export function runTickWatchdog(
  options: TickWatchdogOptions = {},
): Promise<number> {
  const command = options.command ?? process.execPath;
  const args =
    options.args ??
    [fileURLToPath(new URL("./cli.js", import.meta.url)), "tick"];
  const timeoutMs = options.timeoutMs ?? TICK_WATCHDOG_TIMEOUT_MS;
  const writeStderr =
    options.writeStderr ?? ((value: string) => process.stderr.write(value));

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: "inherit",
      detached: true,
    });
    let finished = false;

    const finish = (code: number): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      process.off("SIGTERM", handleSigterm);
      process.off("SIGINT", handleSigint);
      resolve(code);
    };

    const killChildProcessGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        writeStderr(
          `[chima tick watchdog] failed to signal child process group: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        child.kill(signal);
      }
    };

    const handleSigterm = (): void => {
      killChildProcessGroup("SIGTERM");
      finish(143);
    };
    const handleSigint = (): void => {
      killChildProcessGroup("SIGINT");
      finish(130);
    };

    const timeout = setTimeout(() => {
      writeStderr(
        `[chima tick watchdog] ${new Date().toISOString()} timeout after ${timeoutMs}ms; killing child process group ${child.pid ?? "unknown"}\n`,
      );
      killChildProcessGroup("SIGKILL");
      finish(1);
    }, timeoutMs);

    process.once("SIGTERM", handleSigterm);
    process.once("SIGINT", handleSigint);
    child.once("error", (error) => {
      writeStderr(`[chima tick watchdog] failed to start tick: ${error.message}\n`);
      finish(1);
    });
    child.once("exit", (code) => finish(code ?? 1));
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  process.exitCode = await runTickWatchdog();
}
