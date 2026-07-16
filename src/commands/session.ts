import { join } from "node:path";

import {
  readProjectState,
  writeProjectState,
} from "../lib/project-state.js";
import { ensureChimaDirectories, writeJsonFile } from "../lib/state.js";

interface StatuslineInput {
  session_id?: unknown;
  context_window?: {
    used_percentage?: unknown;
  };
  cost?: {
    total_duration_ms?: unknown;
  };
}

export interface SessionState {
  used_pct: number | null;
  duration_ms: number | null;
  updated_at: string;
  project?: string;
}

export async function recordSession(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): Promise<string> {
  try {
    const parsed = JSON.parse(input) as StatuslineInput;
    if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) {
      return input;
    }

    const paths = await ensureChimaDirectories(env);
    const state: SessionState = {
      used_pct: numberOrNull(parsed.context_window?.used_percentage),
      duration_ms: numberOrNull(parsed.cost?.total_duration_ms),
      updated_at: now().toISOString(),
    };

    if (env.CHIMA_PROJECT !== undefined) {
      state.project = env.CHIMA_PROJECT;
    }

    await writeJsonFile(join(paths.sessions, `${parsed.session_id}.json`), state);
  } catch {
    // statusline must keep working even when parsing or state persistence fails.
  }

  return input;
}

export async function markWorkerReady(
  project: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): Promise<void> {
  const state = await readProjectState(project, env);
  if (state.lock == null) {
    throw new Error(`${project} に実行中のワーカーがありません`);
  }

  await writeProjectState(
    project,
    { ...state, worker_ready_at: now().toISOString() },
    env,
  );
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
