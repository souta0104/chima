import { describe, expect, it, vi } from "vitest";

import { runTickWatchdog } from "../src/tick-watchdog.js";

describe("tick watchdog", () => {
  it("子プロセスが正常終了したら終了コードを引き継ぐ", async () => {
    await expect(
      runTickWatchdog({
        command: process.execPath,
        args: ["--eval", "process.exit(0)"],
        timeoutMs: 5_000,
      }),
    ).resolves.toBe(0);
  });

  it("子プロセスのモジュール読込相当処理がハングしても外側から終了する", async () => {
    const writeStderr = vi.fn();

    await expect(
      runTickWatchdog({
        command: process.execPath,
        args: ["--eval", "setInterval(() => undefined, 1_000)"],
        timeoutMs: 50,
        writeStderr,
      }),
    ).resolves.toBe(1);
    expect(writeStderr).toHaveBeenCalledWith(
      expect.stringContaining("timeout after 50ms"),
    );
  });

  it("子プロセスを起動できなければ異常終了する", async () => {
    const writeStderr = vi.fn();

    await expect(
      runTickWatchdog({
        command: "/path/that/does/not/exist",
        timeoutMs: 5_000,
        writeStderr,
      }),
    ).resolves.toBe(1);
    expect(writeStderr).toHaveBeenCalledWith(
      expect.stringContaining("failed to start tick"),
    );
  });
});
