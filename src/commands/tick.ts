import { LinearClient } from "../lib/linear-client.js";
import type { ProjectConfig } from "../lib/projects.js";
import { readProjectsConfig } from "../lib/projects.js";
import type { ProjectState } from "../lib/project-state.js";
import {
  readProjectState,
  writeProjectState,
} from "../lib/project-state.js";
import { tmuxClient, type TmuxClient } from "../lib/tmux.js";
import { kickProject } from "./kick.js";
import { launchProject } from "./launch.js";

const WRAPUP_GRACE_MS = 5 * 60 * 1000;
const EMERGENCY_MARKER = "[今すぐ確認]";

interface LinearComment {
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  userName: string | null;
  botName: string | null;
}

interface LinearIssue {
  id: string;
  children: Array<{ id: string }>;
  comments: LinearComment[];
}

export interface EmergencyComment {
  body: string;
  url: string;
  timestamp: string;
}

export type LockAction =
  | { type: "none" }
  | { type: "crashed" }
  | { type: "done" }
  | { type: "kick" }
  | { type: "killed" };

export interface TickDependencies {
  now: () => Date;
  tmux: TmuxClient;
  getIssue(id: string): Promise<unknown>;
  launch(project: string): Promise<void>;
  kick(project: string, reason: string): Promise<void>;
  logStage(stage: string, event: "start" | "done"): void;
}

// tick の各ステージの開始・完了を stderr に記録する。launchd 環境では
// StandardErrorPath 経由で tick.log に落ちるため、実行がどのステージで
// 止まったかを次回起動を待たずに特定できる (DEV-28 follow-up: tick ハング調査)。
function defaultLogStage(stage: string, event: "start" | "done"): void {
  process.stderr.write(
    `[chima tick] ${new Date().toISOString()} ${stage} ${event}\n`,
  );
}

export async function tick(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: Partial<TickDependencies> = {},
): Promise<void> {
  const now = dependencies.now ?? (() => new Date());
  const tmux = dependencies.tmux ?? tmuxClient;
  const linear = new LinearClient(env);
  const getIssue = dependencies.getIssue ?? ((id: string) => linear.getIssue(id));
  const launch =
    dependencies.launch ??
    ((project: string) => launchProject(project, env, now, tmux));
  const kick =
    dependencies.kick ??
    ((project: string, reason: string) =>
      kickProject(project, reason, env, now, tmux));
  const logStage = dependencies.logStage ?? defaultLogStage;
  const currentTime = now();

  logStage("config読込", "start");
  const projects = await readProjectsConfig(env);
  const enabledProjects = projects.filter((project) => project.enabled);
  logStage("config読込", "done");

  logStage("Linearポーリング", "start");
  await detectEmergencies(
    enabledProjects,
    env,
    currentTime,
    getIssue,
    launch,
    kick,
  );
  logStage("Linearポーリング", "done");

  logStage("lock管理", "start");
  await manageLocks(projects, env, currentTime, tmux, kick);
  logStage("lock管理", "done");

  logStage("due判定・launch", "start");
  await launchDueProjects(enabledProjects, env, currentTime, launch);
  logStage("due判定・launch", "done");
}

export function isProjectDue(
  project: ProjectConfig,
  state: ProjectState,
  now: Date,
): boolean {
  if (
    !project.enabled ||
    state.lock != null ||
    !isWithinActiveHours(project.active_hours, now)
  ) {
    return false;
  }

  const lastRun = timestamp(state.last_run);
  return (
    lastRun === null ||
    now.getTime() - lastRun >= project.interval_min * 60 * 1000
  );
}

export function isWithinActiveHours(activeHours: string, now: Date): boolean {
  const match = /^(\d{2})-(\d{2})$/.exec(activeHours);
  if (match === null) {
    return false;
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 0 || start > 23 || end < 0 || end > 24 || start === end) {
    return false;
  }

  const hour = now.getHours();
  if (start < end) {
    return hour >= start && hour < end;
  }
  return hour >= start || hour < end;
}

export function decideLockAction(
  project: ProjectConfig,
  state: ProjectState,
  sessionExists: boolean,
  now: Date,
): LockAction {
  if (state.lock == null) {
    return { type: "none" };
  }
  if (!sessionExists) {
    return { type: "crashed" };
  }
  if (timestamp(state.checkpoint_done_at) !== null) {
    return { type: "done" };
  }

  const wrapupRequestedAt = timestamp(state.wrapup_requested_at);
  if (
    wrapupRequestedAt !== null &&
    now.getTime() - wrapupRequestedAt >= WRAPUP_GRACE_MS
  ) {
    return { type: "killed" };
  }

  const startedAt = timestamp(state.lock.started_at);
  if (
    wrapupRequestedAt === null &&
    startedAt !== null &&
    now.getTime() - startedAt >= project.work_budget_min * 60 * 1000
  ) {
    return { type: "kick" };
  }

  return { type: "none" };
}

export function findEmergencyComments(
  comments: LinearComment[],
  lastSeenCommentAt: string | undefined,
): EmergencyComment[] {
  const lastSeen = timestamp(lastSeenCommentAt);
  return comments
    .filter((comment) => {
      const commentTime =
        timestamp(comment.updatedAt) ?? timestamp(comment.createdAt);
      return (
        commentTime !== null &&
        (lastSeen === null || commentTime > lastSeen) &&
        comment.botName?.toLowerCase() !== "chima" &&
        comment.userName?.toLowerCase() !== "chima" &&
        comment.body.includes(EMERGENCY_MARKER)
      );
    })
    .map((comment) => ({
      body: comment.body,
      url: comment.url,
      timestamp: comment.updatedAt || comment.createdAt,
    }));
}

async function detectEmergencies(
  projects: ProjectConfig[],
  env: NodeJS.ProcessEnv,
  now: Date,
  getIssue: (id: string) => Promise<unknown>,
  launch: (project: string) => Promise<void>,
  kick: (project: string, reason: string) => Promise<void>,
): Promise<void> {
  for (const project of projects) {
    const state = await readProjectState(project.name, env);
    const comments = await getProjectComments(project.parent_issue, getIssue);
    const emergencies = findEmergencyComments(
      comments,
      state.last_seen_comment_at,
    );
    const nextState: ProjectState = {
      ...state,
      last_seen_comment_at: now.toISOString(),
    };

    if (emergencies.length === 0) {
      await writeProjectState(project.name, nextState, env);
      continue;
    }

    const latest = emergencies.sort((a, b) =>
      b.timestamp.localeCompare(a.timestamp),
    )[0]!;
    if (state.lock != null) {
      await kick(project.name, latest.url);
      const kickedState = await readProjectState(project.name, env);
      await writeProjectState(
        project.name,
        {
          ...kickedState,
          last_seen_comment_at: now.toISOString(),
          restart_requested_at: now.toISOString(),
        },
        env,
      );
    } else {
      await launch(project.name);
      const launchedState = await readProjectState(project.name, env);
      await writeProjectState(
        project.name,
        { ...launchedState, last_seen_comment_at: now.toISOString() },
        env,
      );
    }
  }

  // TODO(DEV-16 follow-up): 関連 PR の review comment 検知を gh api で追加する。
}

async function manageLocks(
  projects: ProjectConfig[],
  env: NodeJS.ProcessEnv,
  now: Date,
  tmux: TmuxClient,
  kick: (project: string, reason: string) => Promise<void>,
): Promise<void> {
  for (const project of projects) {
    const state = await readProjectState(project.name, env);
    if (state.lock == null) {
      continue;
    }

    const exists = await tmux.hasSession(state.lock.tmux_session);
    const action = decideLockAction(project, state, exists, now);
    if (action.type === "none") {
      continue;
    }
    if (action.type === "kick") {
      await kick(project.name, "作業予算超過");
      continue;
    }
    if (action.type === "done" || action.type === "killed") {
      await tmux.killSession(state.lock.tmux_session);
    }
    await writeProjectState(
      project.name,
      { ...state, lock: null, last_result: action.type },
      env,
    );
  }
}

async function launchDueProjects(
  projects: ProjectConfig[],
  env: NodeJS.ProcessEnv,
  now: Date,
  launch: (project: string) => Promise<void>,
): Promise<void> {
  for (const project of projects) {
    const state = await readProjectState(project.name, env);
    const restartRequested = timestamp(state.restart_requested_at) !== null;
    if (
      state.lock == null &&
      (restartRequested || isProjectDue(project, state, now))
    ) {
      await launch(project.name);
    }
  }
}

async function getProjectComments(
  parentIssueId: string,
  getIssue: (id: string) => Promise<unknown>,
): Promise<LinearComment[]> {
  const parent = parseIssue(await getIssue(parentIssueId));
  const comments = [...parent.comments];
  for (const child of parent.children) {
    comments.push(...parseIssue(await getIssue(child.id)).comments);
  }
  return comments;
}

function parseIssue(value: unknown): LinearIssue {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("Linear issue の応答形式が不正です");
  }
  const children =
    isRecord(value.children) && Array.isArray(value.children.nodes)
      ? value.children.nodes
          .filter(isRecord)
          .filter((child) => typeof child.id === "string")
          .map((child) => ({ id: child.id as string }))
      : [];
  const comments =
    isRecord(value.comments) && Array.isArray(value.comments.nodes)
      ? value.comments.nodes.map(parseComment).filter(isPresent)
      : [];
  return { id: value.id, children, comments };
}

function parseComment(value: unknown): LinearComment | null {
  if (
    !isRecord(value) ||
    typeof value.body !== "string" ||
    typeof value.url !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    body: value.body,
    url: value.url,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    userName: nestedName(value.user),
    botName: nestedName(value.botActor),
  };
}

function nestedName(value: unknown): string | null {
  return isRecord(value) && typeof value.name === "string" ? value.name : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
