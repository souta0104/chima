import { findProjectConfig } from "../lib/projects.js";
import {
  readProjectState,
  writeProjectState,
} from "../lib/project-state.js";
import { tmuxClient, type TmuxClient } from "../lib/tmux.js";

export async function launchProject(
  projectName: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
  tmux: TmuxClient = tmuxClient,
): Promise<void> {
  const project = await findProjectConfig(projectName, env);
  const state = await readProjectState(projectName, env);
  const session = `chima-${projectName}`;
  const currentTime = now().toISOString();

  await tmux.newSession(
    session,
    project.repo,
    "claude",
    [
      "--permission-mode",
      "auto",
      "--model",
      project.orchestrator_model,
      `/worker-run ${projectName}`,
    ],
    { ...process.env, ...env, CHIMA_PROJECT: projectName },
  );

  await writeProjectState(
    projectName,
    {
      ...state,
      last_run: currentTime,
      lock: { tmux_session: session, started_at: currentTime },
      worker_ready_at: null,
      wrapup_requested_at: null,
      checkpoint_done_at: null,
      restart_requested_at: null,
    },
    env,
  );
}
