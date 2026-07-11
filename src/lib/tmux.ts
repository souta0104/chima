import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TmuxClient {
  newSession(
    session: string,
    workingDirectory: string,
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<void>;
  sendKeys(session: string, message: string): Promise<void>;
  hasSession(session: string): Promise<boolean>;
  killSession(session: string): Promise<void>;
}

export const tmuxClient: TmuxClient = {
  async newSession(session, workingDirectory, command, args, env) {
    await execFileAsync(
      "tmux",
      [
        "new-session",
        "-d",
        "-s",
        session,
        "-c",
        workingDirectory,
        command,
        ...args,
      ],
      { env },
    );
  },

  async sendKeys(session, message) {
    await execFileAsync("tmux", ["send-keys", "-t", session, message, "Enter"]);
  },

  async hasSession(session) {
    try {
      await execFileAsync("tmux", ["has-session", "-t", session]);
      return true;
    } catch (error) {
      if (isExitCode(error, 1)) {
        return false;
      }
      throw error;
    }
  },

  async killSession(session) {
    await execFileAsync("tmux", ["kill-session", "-t", session]);
  },
};

function isExitCode(error: unknown, code: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
