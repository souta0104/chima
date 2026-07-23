import type { WorkerConfig } from "./projects.js";

export interface WorkerCommand {
  command: string;
  args: string[];
}

export function buildWorkerCommand(
  project: string,
  worker: WorkerConfig,
  chimaHome: string,
): WorkerCommand {
  if (worker.runtime === "claude-code") {
    return {
      command: "claude",
      args: [
        "--permission-mode",
        "auto",
        "--model",
        worker.model,
        `/worker-run ${project}`,
      ],
    };
  }

  return {
    command: "codex",
    args: [
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      "--add-dir",
      chimaHome,
      "--model",
      worker.model,
      "--config",
      `model_reasoning_effort=${JSON.stringify(worker.reasoning_effort)}`,
      `$worker-run ${project}`,
    ],
  };
}
