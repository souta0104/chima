import { open, stat } from "node:fs/promises";
import { join } from "node:path";

import type { SessionState } from "../commands/session.js";
import {
  ensureChimaDirectories,
  readJsonFile,
  writeJsonFile,
} from "./state.js";

const BASELINE_TOKENS = 12_000;

interface CodexHookInput {
  session_id?: unknown;
  transcript_path?: unknown;
}

interface TokenUsage {
  totalTokens: number;
  modelContextWindow: number;
}

export function calculateCodexUsedPct(
  totalTokens: number,
  modelContextWindow: number,
): number | null {
  const effectiveWindow = modelContextWindow - BASELINE_TOKENS;
  if (
    !Number.isFinite(totalTokens) ||
    !Number.isFinite(modelContextWindow) ||
    effectiveWindow <= 0
  ) {
    return null;
  }

  const used = Math.max(totalTokens - BASELINE_TOKENS, 0);
  const remainingPct = Math.round(
    (Math.max(effectiveWindow - used, 0) / effectiveWindow) * 100,
  );
  return 100 - remainingPct;
}

export async function recordCodexUsage(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): Promise<void> {
  let hook: CodexHookInput;
  try {
    hook = JSON.parse(input) as CodexHookInput;
  } catch {
    return;
  }

  if (typeof hook.session_id !== "string" || hook.session_id.length === 0) {
    return;
  }

  const paths = await ensureChimaDirectories(env);
  const statePath = join(paths.sessions, `${hook.session_id}.json`);
  const previous = (await readSessionSafely(statePath)) ?? emptyState(now, env);

  if (
    typeof hook.transcript_path !== "string" ||
    hook.transcript_path.length === 0
  ) {
    await writeJsonFile(statePath, unavailableState(previous, now, env));
    return;
  }

  try {
    const fileSize = (await stat(hook.transcript_path)).size;
    const previousOffset = finiteNonNegative(previous.transcript_offset) ?? 0;
    const offset = previousOffset > fileSize ? 0 : previousOffset;
    const chunk = await readBytes(hook.transcript_path, offset, fileSize - offset);
    const lastNewline = chunk.lastIndexOf(0x0a);

    if (lastNewline < 0) {
      await writeJsonFile(statePath, {
        ...withProject(previous, env),
        transcript_offset: offset,
        updated_at: now().toISOString(),
      });
      return;
    }

    const completeChunk = chunk.subarray(0, lastNewline).toString("utf8");
    const result = parseLatestTokenUsage(completeChunk);
    const nextOffset = offset + lastNewline + 1;

    if (result.status === "unsupported") {
      await writeJsonFile(statePath, {
        ...withProject(previous, env),
        used_pct: null,
        token_count: null,
        model_context_window: null,
        transcript_offset: nextOffset,
        usage_source_status: "unsupported",
        updated_at: now().toISOString(),
      });
      return;
    }

    if (result.usage === null) {
      await writeJsonFile(statePath, {
        ...withProject(previous, env),
        transcript_offset: nextOffset,
        updated_at: now().toISOString(),
      });
      return;
    }

    const usedPct = calculateCodexUsedPct(
      result.usage.totalTokens,
      result.usage.modelContextWindow,
    );
    await writeJsonFile(statePath, {
      ...withProject(previous, env),
      used_pct: usedPct,
      duration_ms: null,
      token_count: result.usage.totalTokens,
      model_context_window: result.usage.modelContextWindow,
      transcript_offset: nextOffset,
      usage_source_status: usedPct === null ? "unsupported" : "ok",
      updated_at: now().toISOString(),
    });
  } catch {
    await writeJsonFile(statePath, unavailableState(previous, now, env));
  }
}

async function readBytes(
  path: string,
  offset: number,
  length: number,
): Promise<Buffer> {
  if (length === 0) {
    return Buffer.alloc(0);
  }

  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function parseLatestTokenUsage(chunk: string): {
  status: "ok" | "unsupported";
  usage: TokenUsage | null;
} {
  let latest: TokenUsage | "unsupported" | null = null;

  for (const line of chunk.split("\n")) {
    if (line.length === 0) {
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    if (!isRecord(value) || value.type !== "event_msg") {
      continue;
    }
    const payload = value.payload;
    if (!isRecord(payload) || payload.type !== "token_count") {
      continue;
    }
    const info = payload.info;
    const lastTokenUsage = isRecord(info) ? info.last_token_usage : null;
    const totalTokens = isRecord(lastTokenUsage)
      ? finiteNumber(lastTokenUsage.total_tokens)
      : null;
    const modelContextWindow = isRecord(info)
      ? finiteNumber(info.model_context_window)
      : null;

    if (totalTokens === null || modelContextWindow === null) {
      latest = "unsupported";
      continue;
    }
    latest = { totalTokens, modelContextWindow };
  }

  if (latest === "unsupported") {
    return { status: "unsupported", usage: null };
  }
  return { status: "ok", usage: latest };
}

function unavailableState(
  previous: SessionState,
  now: () => Date,
  env: NodeJS.ProcessEnv,
): SessionState {
  return {
    ...withProject(previous, env),
    used_pct: null,
    token_count: null,
    model_context_window: null,
    usage_source_status: "unavailable",
    updated_at: now().toISOString(),
  };
}

function emptyState(now: () => Date, env: NodeJS.ProcessEnv): SessionState {
  return withProject(
    { used_pct: null, duration_ms: null, updated_at: now().toISOString() },
    env,
  );
}

function withProject(
  state: SessionState,
  env: NodeJS.ProcessEnv,
): SessionState {
  return env.CHIMA_PROJECT === undefined
    ? state
    : { ...state, project: env.CHIMA_PROJECT };
}

async function readSessionSafely(path: string): Promise<SessionState | null> {
  try {
    return await readJsonFile<SessionState>(path);
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteNonNegative(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
