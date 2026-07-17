import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { getChimaPaths, readJsonFile } from "../lib/state.js";
import type { SessionState } from "./session.js";

interface ProjectConfig {
  name: string;
  enabled: boolean;
}

interface ProjectsConfig {
  projects?: ProjectConfig[];
}

interface ProjectState {
  last_run?: unknown;
  last_result?: unknown;
  lock?: unknown;
  wrapup_requested_at?: unknown;
  checkpoint_done_at?: unknown;
}

interface StoredSessionState extends SessionState {
  project?: string;
}

export interface StatusProject {
  name: string;
  enabled: boolean;
  last_run: unknown | null;
  last_result: unknown | null;
  lock: unknown | null;
  wrapup_requested_at: unknown | null;
  checkpoint_done_at: unknown | null;
  session: SessionState | null;
}

export interface StatusOutput {
  projects: StatusProject[];
}

export async function getStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StatusOutput> {
  const paths = getChimaPaths(env);
  const config = await readJsonFile<ProjectsConfig>(
    join(paths.config, "projects.json"),
  );
  const projects = Array.isArray(config?.projects) ? config.projects : [];
  const sessions = await readSessions(paths.sessions);

  return {
    projects: await Promise.all(
      projects.map(async (project) => {
        const state =
          (await readJsonFile<ProjectState>(
            join(paths.projects, `${project.name}.json`),
          )) ?? {};
        const lock = state.lock ?? null;

        return {
          name: project.name,
          enabled: project.enabled,
          last_run: state.last_run ?? null,
          last_result: state.last_result ?? null,
          lock,
          wrapup_requested_at: state.wrapup_requested_at ?? null,
          checkpoint_done_at: state.checkpoint_done_at ?? null,
          session: lock === null ? null : latestSession(sessions, project.name),
        };
      }),
    ),
  };
}

export function formatStatusText(status: StatusOutput): string {
  return status.projects
    .map((project) => {
      const session = project.session;
      return [
        project.name,
        `enabled=${project.enabled}`,
        `last_run=${display(project.last_run)}`,
        `last_result=${display(project.last_result)}`,
        `lock=${project.lock === null ? "none" : "active"}`,
        `wrapup_requested_at=${display(project.wrapup_requested_at)}`,
        `checkpoint_done_at=${display(project.checkpoint_done_at)}`,
        `session=${
          session === null
            ? "none"
            : `${display(session.used_pct)}%/${display(session.duration_ms)}ms/${session.updated_at}/usage=${display(session.usage_source_status)}`
        }`,
      ].join(" ");
    })
    .join("\n");
}

async function readSessions(directory: string): Promise<StoredSessionState[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => readJsonFile<StoredSessionState>(join(directory, entry))),
  );
  return sessions.filter((session): session is StoredSessionState => session !== null);
}

function latestSession(
  sessions: StoredSessionState[],
  project: string,
): SessionState | null {
  const session = sessions
    .filter((candidate) => candidate.project === project)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];

  if (session === undefined) {
    return null;
  }

  const { project: _project, ...publicSession } = session;
  return publicSession;
}

function display(value: unknown): string {
  return value === null || value === undefined ? "-" : String(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
