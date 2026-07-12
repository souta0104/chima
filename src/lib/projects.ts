import { join } from "node:path";

import { getChimaPaths, readJsonFile } from "./state.js";

export interface ProjectConfig {
  name: string;
  repo: string;
  parent_issue: string;
  interval_min: number;
  work_budget_min: number;
  active_hours: string;
  orchestrator_model: string;
  enabled: boolean;
}

interface ProjectsConfig {
  projects?: unknown;
}

export interface LaunchProjectConfig {
  name: string;
  repo: string;
  orchestrator_model: string;
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

  return config.projects.filter(isProjectConfig);
}

export async function findProjectConfig(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LaunchProjectConfig> {
  const paths = getChimaPaths(env);
  const config = await readJsonFile<ProjectsConfig>(
    join(paths.config, "projects.json"),
  );
  const project = Array.isArray(config?.projects)
    ? config.projects.find(
        (candidate): candidate is LaunchProjectConfig =>
          isLaunchProjectConfig(candidate) && candidate.name === name,
      )
    : undefined;
  if (project === undefined) {
    throw new Error(`プロジェクト設定がありません: ${name}`);
  }
  return project;
}

function isLaunchProjectConfig(value: unknown): value is LaunchProjectConfig {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.repo === "string" &&
    typeof value.orchestrator_model === "string"
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
    typeof value.orchestrator_model === "string" &&
    typeof value.enabled === "boolean"
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
