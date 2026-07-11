import { join } from "node:path";

import {
  ensureChimaDirectories,
  getChimaPaths,
  readJsonFile,
  writeJsonFile,
} from "../lib/state.js";
import type { SessionState } from "./session.js";

const THROTTLE_MS = 2 * 60 * 1000;

interface HookInput {
  session_id?: unknown;
}

interface ProjectConfig {
  name?: unknown;
  context_threshold_pct?: unknown;
  work_budget_min?: unknown;
}

interface ProjectsConfig {
  projects?: unknown;
}

interface ProjectState extends Record<string, unknown> {
  wrapup_requested_at?: unknown;
  checkpoint_done_at?: unknown;
  stop_gate_blocked_at?: unknown;
  stop_gate_blocked_session_id?: unknown;
}

export async function guard(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): Promise<string> {
  try {
    const projectName = env.CHIMA_PROJECT;
    if (projectName === undefined || projectName.length === 0) {
      return "";
    }

    const sessionId = getSessionId(input);
    if (sessionId === null) {
      return "";
    }

    const paths = getChimaPaths(env);
    const config = await readJsonFile<ProjectsConfig>(
      join(paths.config, "projects.json"),
    );
    const project = findProject(config, projectName);
    if (project === null) {
      return "";
    }

    const session = await readSessionSafely(
      join(paths.sessions, `${sessionId}.json`),
    );
    if (!thresholdExceeded(session, project)) {
      return "";
    }

    const statePath = join(paths.projects, `${projectName}.json`);
    const state = (await readProjectStateSafely(statePath)) ?? {};
    const currentTime = now();
    if (isThrottled(state.wrapup_requested_at, currentTime)) {
      return "";
    }

    await ensureChimaDirectories(env);
    await writeJsonFile(statePath, {
      ...state,
      wrapup_requested_at: currentTime.toISOString(),
    });

    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          "作業時間またはコンテキスト使用率が閾値に達しました。新規作業を止めて、収束プロトコルを開始してください。",
      },
    })}\n`;
  } catch {
    // Hooks must not interfere with the Claude Code session on failure.
    return "";
  }
}

export async function stopGate(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): Promise<string> {
  try {
    const projectName = env.CHIMA_PROJECT;
    if (projectName === undefined || projectName.length === 0) {
      return "";
    }

    const sessionId = getSessionId(input);
    if (sessionId === null) {
      return "";
    }

    const paths = getChimaPaths(env);
    const statePath = join(paths.projects, `${projectName}.json`);
    const state = await readProjectStateSafely(statePath);
    if (
      state === null ||
      !isPresent(state.wrapup_requested_at) ||
      isPresent(state.checkpoint_done_at) ||
      state.stop_gate_blocked_session_id === sessionId
    ) {
      return "";
    }

    await ensureChimaDirectories(env);
    await writeJsonFile(statePath, {
      ...state,
      stop_gate_blocked_at: now().toISOString(),
      stop_gate_blocked_session_id: sessionId,
    });

    return `${JSON.stringify({
      decision: "block",
      reason:
        "Linear へのチェックポイント記録が未完了。収束プロトコルを完了させてから終了してください",
    })}\n`;
  } catch {
    // Hooks must not interfere with the Claude Code session on failure.
    return "";
  }
}

function getSessionId(input: string): string | null {
  const parsed = JSON.parse(input) as HookInput;
  return typeof parsed.session_id === "string" && parsed.session_id.length > 0
    ? parsed.session_id
    : null;
}

function findProject(
  config: ProjectsConfig | null,
  projectName: string,
): ProjectConfig | null {
  if (!Array.isArray(config?.projects)) {
    return null;
  }

  const project = config.projects.find(
    (candidate): candidate is ProjectConfig =>
      isRecord(candidate) && candidate.name === projectName,
  );
  return project ?? null;
}

function thresholdExceeded(
  session: SessionState | null,
  project: ProjectConfig,
): boolean {
  if (session === null) {
    return false;
  }

  const contextThreshold = finiteNumber(project.context_threshold_pct);
  const workBudgetMinutes = finiteNumber(project.work_budget_min);
  const usedPct = finiteNumber(session.used_pct);
  const durationMs = finiteNumber(session.duration_ms);

  return (
    (contextThreshold !== null &&
      usedPct !== null &&
      usedPct >= contextThreshold) ||
    (workBudgetMinutes !== null &&
      durationMs !== null &&
      durationMs >= workBudgetMinutes * 60 * 1000)
  );
}

async function readSessionSafely(path: string): Promise<SessionState | null> {
  try {
    return await readJsonFile<SessionState>(path);
  } catch {
    return null;
  }
}

async function readProjectStateSafely(
  path: string,
): Promise<ProjectState | null> {
  try {
    const state = await readJsonFile<unknown>(path);
    return isRecord(state) ? state : null;
  } catch {
    return null;
  }
}

function isThrottled(value: unknown, now: Date): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && now.getTime() - timestamp < THROTTLE_MS;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isPresent(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
