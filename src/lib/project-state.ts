import { join } from "node:path";

import {
  ensureChimaDirectories,
  getChimaPaths,
  readJsonFile,
  writeJsonFile,
} from "./state.js";

export interface ProjectLock {
  tmux_session: string;
  started_at: string;
}

export interface ProjectState extends Record<string, unknown> {
  last_run?: string;
  last_seen_comment_at?: string;
  lock?: ProjectLock | null;
  wrapup_requested_at?: string | null;
  checkpoint_done_at?: string | null;
  last_result?: "done" | "killed" | "crashed";
  restart_requested_at?: string | null;
}

export async function readProjectState(
  project: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectState> {
  const path = join(getChimaPaths(env).projects, `${project}.json`);
  const state = await readJsonFile<unknown>(path);
  return isRecord(state) ? state : {};
}

export async function writeProjectState(
  project: string,
  state: ProjectState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = await ensureChimaDirectories(env);
  await writeJsonFile(join(paths.projects, `${project}.json`), state);
}

function isRecord(value: unknown): value is ProjectState {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
