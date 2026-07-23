import { join } from "node:path";

import { getChimaPaths, readJsonFile } from "./state.js";

export interface ProjectConfig {
  name: string;
  repo: string;
  parent_issue: string;
  interval_min: number;
  work_budget_min: number;
  active_hours: string;
  worker: WorkerConfig;
  enabled: boolean;
}

export type WorkerConfig = ClaudeCodeWorkerConfig | CodexWorkerConfig;

export interface ClaudeCodeWorkerConfig {
  runtime: "claude-code";
  model: string;
  planner_model: string;
}

export interface CodexWorkerConfig {
  runtime: "codex";
  model: string;
  reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh";
}

interface ProjectsConfig {
  projects?: unknown;
}

export interface LaunchProjectConfig {
  name: string;
  repo: string;
  worker: WorkerConfig;
}

export async function readProjectsConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectConfig[]> {
  const paths = getChimaPaths(env);
  const config = await readJsonFile<ProjectsConfig>(
    join(paths.config, "projects.json"),
  );

  if (!Array.isArray(config?.projects)) {
    return [];
  }

  return config.projects.map((candidate, index) => {
    if (isProjectConfig(candidate)) {
      return candidate;
    }
    throw new Error(
      `projects.json のプロジェクト設定が不正です (${projectLabel(candidate, index)})。` +
        "worker フィールド (runtime/model に加えて claude-code なら planner_model、codex なら reasoning_effort) を設定してください。",
    );
  });
}

export async function findProjectConfig(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LaunchProjectConfig> {
  const paths = getChimaPaths(env);
  const config = await readJsonFile<ProjectsConfig>(
    join(paths.config, "projects.json"),
  );
  const candidate = Array.isArray(config?.projects)
    ? config.projects.find(
        (entry): entry is Record<string, unknown> =>
          isRecord(entry) && entry.name === name,
      )
    : undefined;
  if (candidate === undefined) {
    throw new Error(`プロジェクト設定がありません: ${name}`);
  }
  if (!isLaunchProjectConfig(candidate)) {
    throw new Error(
      `projects.json のプロジェクト設定が不正です (${name})。` +
        "worker フィールド (runtime/model に加えて claude-code なら planner_model、codex なら reasoning_effort) を設定してください。",
    );
  }
  return candidate;
}

function projectLabel(value: unknown, index: number): string {
  return isRecord(value) && typeof value.name === "string"
    ? value.name
    : `index ${index}`;
}

function isLaunchProjectConfig(value: unknown): value is LaunchProjectConfig {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.repo === "string" &&
    isWorkerConfig(value.worker)
  );
}

function isProjectConfig(value: unknown): value is ProjectConfig {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.name === "string" &&
    typeof value.repo === "string" &&
    typeof value.parent_issue === "string" &&
    isFiniteNumber(value.interval_min) &&
    isFiniteNumber(value.work_budget_min) &&
    typeof value.active_hours === "string" &&
    isWorkerConfig(value.worker) &&
    typeof value.enabled === "boolean"
  );
}

function isWorkerConfig(value: unknown): value is WorkerConfig {
  if (!isRecord(value) || typeof value.model !== "string") {
    return false;
  }

  if (value.runtime === "claude-code") {
    return typeof value.planner_model === "string";
  }

  return (
    value.runtime === "codex" &&
    typeof value.reasoning_effort === "string" &&
    ["minimal", "low", "medium", "high", "xhigh"].includes(
      value.reasoning_effort,
    )
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
