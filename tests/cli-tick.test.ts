import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";

describe("tick / launch / kick CLI", () => {
  it("tick を引数なしで呼び出す", async () => {
    const commands = mockCommands();

    await expect(runCli(["node", "chima", "tick"], {}, io(), commands)).resolves.toBe(0);
    expect(commands.tick).toHaveBeenCalledOnce();
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
  };
}
