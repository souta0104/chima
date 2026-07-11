import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ChimaPaths {
  home: string;
  config: string;
  sessions: string;
  projects: string;
  pending: string;
  logs: string;
}

export function getChimaPaths(env: NodeJS.ProcessEnv = process.env): ChimaPaths {
  const home = env.CHIMA_HOME ?? join(homedir(), ".chima");

  return {
    home,
    config: join(home, "config"),
    sessions: join(home, "state", "sessions"),
    projects: join(home, "state", "projects"),
    pending: join(home, "state", "pending"),
    logs: join(home, "logs"),
  };
}

export async function ensureChimaDirectories(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChimaPaths> {
  const paths = getChimaPaths(env);

  await Promise.all(
    [paths.config, paths.sessions, paths.projects, paths.pending, paths.logs].map(
      (directory) => mkdir(directory, { recursive: true }),
    ),
  );

  return paths;
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
