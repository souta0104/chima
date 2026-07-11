import {
  readProjectState,
  writeProjectState,
} from "../lib/project-state.js";
import { tmuxClient, type TmuxClient } from "../lib/tmux.js";

const DEFAULT_REASON = "予算超過";

export async function kickProject(
  projectName: string,
  reason = DEFAULT_REASON,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
  tmux: TmuxClient = tmuxClient,
): Promise<void> {
  const state = await readProjectState(projectName, env);
  const session = state.lock?.tmux_session ?? `chima-${projectName}`;
  const message = `収束指示: ${reason}。新規作業を止めて worker-run の収束プロトコルを今すぐ実行して終了してください`;

  await tmux.sendKeys(session, message);
  await writeProjectState(
    projectName,
    { ...state, wrapup_requested_at: now().toISOString() },
    env,
  );
}
