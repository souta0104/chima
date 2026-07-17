import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  calculateCodexUsedPct,
  recordCodexUsage,
} from "../src/lib/codex-usage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("calculateCodexUsedPct", () => {
  it("Codex TUI と同じ 12,000 token 控除と整数丸めを使う", () => {
    expect(calculateCodexUsedPct(12_000, 112_000)).toBe(0);
    expect(calculateCodexUsedPct(62_000, 112_000)).toBe(50);
    expect(calculateCodexUsedPct(112_000, 112_000)).toBe(100);
    expect(calculateCodexUsedPct(999_999, 112_000)).toBe(100);
  });

  it("有効な context window がなければ不明にする", () => {
    expect(calculateCodexUsedPct(1, 12_000)).toBeNull();
    expect(calculateCodexUsedPct(Number.NaN, 112_000)).toBeNull();
  });
});

describe("recordCodexUsage", () => {
  it("最新の last_token_usage だけを記録して累積利用量を無視する", async () => {
    const fixture = await makeFixture();
    await writeFile(
      fixture.transcript,
      `${tokenLine(62_000, 112_000, 999_999)}\n`,
      "utf8",
    );

    await recordCodexUsage(
      hookInput(fixture.transcript),
      fixture.env,
      at("2026-07-16T00:00:00.000Z"),
    );

    await expect(readState(fixture.home)).resolves.toMatchObject({
      used_pct: 50,
      token_count: 62_000,
      model_context_window: 112_000,
      usage_source_status: "ok",
      project: "magonote",
    });
  });

  it("増分だけを読み、末尾の未完了行は次回まで処理しない", async () => {
    const fixture = await makeFixture();
    const first = `${tokenLine(32_000, 112_000)}\n`;
    const second = tokenLine(72_000, 112_000);
    await writeFile(fixture.transcript, `${first}${second.slice(0, 20)}`, "utf8");

    await recordCodexUsage(hookInput(fixture.transcript), fixture.env);
    const firstState = await readState(fixture.home);
    expect(firstState).toMatchObject({ used_pct: 20, transcript_offset: Buffer.byteLength(first) });

    await appendFile(fixture.transcript, `${second.slice(20)}\n`, "utf8");
    await recordCodexUsage(hookInput(fixture.transcript), fixture.env);
    await expect(readState(fixture.home)).resolves.toMatchObject({
      used_pct: 60,
      token_count: 72_000,
    });
  });

  it("壊れた JSON 行を読み捨てて後続の token_count を取得する", async () => {
    const fixture = await makeFixture();
    await writeFile(
      fixture.transcript,
      `{broken json\n${tokenLine(42_000, 112_000)}\n`,
      "utf8",
    );

    await recordCodexUsage(hookInput(fixture.transcript), fixture.env);

    await expect(readState(fixture.home)).resolves.toMatchObject({
      used_pct: 30,
      usage_source_status: "ok",
    });
  });

  it("compact 後に last_token_usage が減ったら使用率も下げる", async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.transcript, `${tokenLine(82_000, 112_000)}\n`, "utf8");
    await recordCodexUsage(hookInput(fixture.transcript), fixture.env);
    expect((await readState(fixture.home)).used_pct).toBe(70);

    await appendFile(fixture.transcript, `${tokenLine(32_000, 112_000, 900_000)}\n`, "utf8");
    await recordCodexUsage(hookInput(fixture.transcript), fixture.env);

    expect((await readState(fixture.home)).used_pct).toBe(20);
  });

  it("transcript が短くなったら offset を先頭へ戻す", async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.transcript, `${tokenLine(82_000, 112_000)}\n`, "utf8");
    await recordCodexUsage(hookInput(fixture.transcript), fixture.env);
    await truncate(fixture.transcript, 0);
    await writeFile(fixture.transcript, `${tokenLine(2_000, 112_000)}\n`, "utf8");

    await recordCodexUsage(hookInput(fixture.transcript), fixture.env);

    expect((await readState(fixture.home)).used_pct).toBe(0);
  });

  it("token_count の形式変更を unsupported として記録する", async () => {
    const fixture = await makeFixture();
    await writeFile(
      fixture.transcript,
      `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {} } })}\n`,
      "utf8",
    );

    await recordCodexUsage(hookInput(fixture.transcript), fixture.env);

    await expect(readState(fixture.home)).resolves.toMatchObject({
      used_pct: null,
      token_count: null,
      usage_source_status: "unsupported",
    });
  });

  it("transcript を取得できなくても hook を失敗させない", async () => {
    const fixture = await makeFixture();

    await expect(
      recordCodexUsage(hookInput(join(fixture.home, "missing.jsonl")), fixture.env),
    ).resolves.toBeUndefined();
    await expect(readState(fixture.home)).resolves.toMatchObject({
      used_pct: null,
      usage_source_status: "unavailable",
    });
  });
});

function tokenLine(
  lastTotalTokens: number,
  modelContextWindow: number,
  cumulativeTotalTokens = lastTotalTokens,
): string {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: cumulativeTotalTokens },
        last_token_usage: { total_tokens: lastTotalTokens },
        model_context_window: modelContextWindow,
      },
    },
  });
}

async function makeFixture(): Promise<{
  home: string;
  transcript: string;
  env: NodeJS.ProcessEnv;
}> {
  const home = await mkdtemp(join(tmpdir(), "chima-codex-usage-test-"));
  temporaryDirectories.push(home);
  return {
    home,
    transcript: join(home, "transcript.jsonl"),
    env: { CHIMA_HOME: home, CHIMA_PROJECT: "magonote" },
  };
}

function hookInput(transcriptPath: string): string {
  return JSON.stringify({
    session_id: "session-123",
    transcript_path: transcriptPath,
  });
}

async function readState(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(home, "state", "sessions", "session-123.json"), "utf8"),
  ) as Record<string, unknown>;
}

function at(value: string): () => Date {
  return () => new Date(value);
}
