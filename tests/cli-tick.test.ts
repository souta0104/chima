import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";

describe("tick / launch / kick CLI", () => {
  it("tick を引数なしで呼び出す", async () => {
    const commands = mockCommands();

    await expect(runCli(["node", "chima", "tick"], {}, io(), commands)).resolves.toBe(0);
    expect(commands.tick).toHaveBeenCalledOnce();
  });

  it("tick が 90 秒以内に終われば watchdog は発火しない", async () => {
    vi.useFakeTimers();
    try {
      const cliIo = io();
      const commands = mockCommands();
      commands.tick.mockImplementation(async () => {
        vi.advanceTimersByTime(1_000);
      });

      await expect(
        runCli(["node", "chima", "tick"], {}, cliIo, commands),
      ).resolves.toBe(0);
      expect(cliIo.exit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tick が 90 秒を超えてハングしたら watchdog が exit(1) を呼ぶ", async () => {
    vi.useFakeTimers();
    try {
      const cliIo = io();
      const commands = mockCommands();
      commands.tick.mockImplementation(() => new Promise(() => undefined));

      const resultPromise = runCli(["node", "chima", "tick"], {}, cliIo, commands);
      await vi.advanceTimersByTimeAsync(90_000);
      await expect(resultPromise).resolves.toBe(1);
      expect(cliIo.exit).toHaveBeenCalledWith(1);
      expect(cliIo.writeStderr).toHaveBeenCalledWith(
        expect.stringContaining("watchdog timeout"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("launch に project を渡す", async () => {
    const commands = mockCommands();

    await expect(
      runCli(["node", "chima", "launch", "magonote"], {}, io(), commands),
    ).resolves.toBe(0);
    expect(commands.launch).toHaveBeenCalledWith("magonote", {});
  });

  it("kick に project と reason を渡す", async () => {
    const commands = mockCommands();

    await expect(
      runCli(
        ["node", "chima", "kick", "magonote", "--reason", "緊急"],
        {},
        io(),
        commands,
      ),
    ).resolves.toBe(0);
    expect(commands.kick).toHaveBeenCalledWith("magonote", "緊急", {});
  });
});

function mockCommands() {
  return {
    tick: vi.fn(async () => undefined),
    launch: vi.fn(async () => undefined),
    kick: vi.fn(async () => undefined),
  };
}

function io() {
  return {
    stdin: Readable.from([]),
    writeStdout: vi.fn(),
    writeStderr: vi.fn(),
    exit: vi.fn(),
  };
}
