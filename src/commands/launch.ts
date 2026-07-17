import { findProjectConfig } from "../lib/projects.js";
import {
  readProjectState,
  writeProjectState,
} from "../lib/project-state.js";
import { tmuxClient, type TmuxClient } from "../lib/tmux.js";
import { getChimaPaths } from "../lib/state.js";
import { buildWorkerCommand } from "../lib/runtime.js";

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
  const workerCommand = buildWorkerCommand(
    projectName,
    project.worker,
    getChimaPaths(env).home,
  );

  await tmux.newSession(
    session,
    project.repo,
    workerCommand.command,
    workerCommand.args,
    { ...process.env, ...env, CHIMA_PROJECT: projectName },
  );

  await writeProjectState(
    projectName,
    {
      ...state,
      last_run: currentTime,
      lock: { tmux_session: session, started_at: currentTime },
      wrapup_requested_at: null,
      checkpoint_done_at: null,
      restart_requested_at: null,
    },
    env,
  );
}
