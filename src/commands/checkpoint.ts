import { join } from "node:path";

import {
  ensureChimaDirectories,
  readJsonFile,
  writeJsonFile,
} from "../lib/state.js";

export async function completeCheckpoint(
  project: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): Promise<void> {
  const paths = await ensureChimaDirectories(env);
  const statePath = join(paths.projects, `${project}.json`);
  const state = (await readJsonFile<Record<string, unknown>>(statePath)) ?? {};

  await writeJsonFile(statePath, {
    ...state,
    checkpoint_done_at: now().toISOString(),
  });
}
