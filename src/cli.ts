import { completeCheckpoint } from "./commands/checkpoint.js";
import { guard, stopGate } from "./commands/guard.js";
import { kickProject } from "./commands/kick.js";
import { launchProject } from "./commands/launch.js";
import { runLinearCommand } from "./commands/linear.js";
import { recordSession } from "./commands/session.js";
import { formatStatusText, getStatus } from "./commands/status.js";
import { tick } from "./commands/tick.js";

const KNOWN_COMMANDS = [
  "tick",
  "launch",
  "kick",
  "session",
  "guard",
  "checkpoint",
  "status",
  "linear",
];

function usage(): string {
  return [
    "usage: chima <command> [...args]",
    "",
    "commands:",
    ...KNOWN_COMMANDS.map((name) => `  ${name}`),
  ].join("\n");
}

interface CliIo {
  stdin: AsyncIterable<string | Uint8Array>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

interface CliCommands {
  tick(env: NodeJS.ProcessEnv): Promise<void>;
  launch(project: string, env: NodeJS.ProcessEnv): Promise<void>;
  kick(
    project: string,
    reason: string | undefined,
    env: NodeJS.ProcessEnv,
  ): Promise<void>;
}

const defaultCommands: CliCommands = {
  tick: (env) => tick(env),
  launch: (project, env) => launchProject(project, env),
  kick: (project, reason, env) => kickProject(project, reason, env),
};

const processIo: CliIo = {
  stdin: process.stdin,
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
};

async function readStdin(stdin: CliIo["stdin"]): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = processIo,
  commands: CliCommands = defaultCommands,
): Promise<number> {
  const command = argv[2];

  if (command === undefined || !KNOWN_COMMANDS.includes(command)) {
    io.writeStderr(`${usage()}\n`);
    return 1;
  }

  if (command === "tick" && argv.length === 3) {
    return runCommand(() => commands.tick(env), io);
  }

  if (command === "launch" && argv[3] !== undefined && argv.length === 4) {
    return runCommand(() => commands.launch(argv[3]!, env), io);
  }

  if (command === "kick" && argv[3] !== undefined) {
    const reason = parseKickReason(argv.slice(4));
    if (reason.valid) {
      return runCommand(() => commands.kick(argv[3]!, reason.value, env), io);
    }
  }

  if (command === "session" && argv[3] === "record" && argv.length === 4) {
    const input = await readStdinSafely(io.stdin);
    if (input === null) {
      return 0;
    }
    io.writeStdout(await recordSession(input, env));
    return 0;
  }

  if (
    command === "guard" &&
    (argv.length === 3 || (argv.length === 4 && argv[3] === "--stop-gate"))
  ) {
    const input = await readStdinSafely(io.stdin);
    if (input === null) {
      return 0;
    }
    const output =
      argv[3] === "--stop-gate"
        ? await stopGate(input, env)
        : await guard(input, env);
    io.writeStdout(output);
    return 0;
  }

  if (
    command === "checkpoint" &&
    argv[3] === "done" &&
    argv[4] !== undefined &&
    argv.length === 5
  ) {
    await completeCheckpoint(argv[4], env);
    return 0;
  }

  if (
    command === "status" &&
    (argv.length === 3 || (argv.length === 4 && argv[3] === "--json"))
  ) {
    const status = await getStatus(env);
    if (argv[3] === "--json") {
      io.writeStdout(`${JSON.stringify(status)}\n`);
    } else {
      const output = formatStatusText(status);
      io.writeStdout(output.length === 0 ? "" : `${output}\n`);
    }
    return 0;
  }

  if (command === "linear") {
    return runLinearCommand(argv.slice(3), env, io);
  }

  io.writeStderr(`${usage()}\n`);
  return 1;
}

async function runCommand(
  command: () => Promise<void>,
  io: CliIo,
): Promise<number> {
  try {
    await command();
    return 0;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseKickReason(args: string[]):
  | { valid: true; value: string | undefined }
  | { valid: false } {
  if (args.length === 0) {
    return { valid: true, value: undefined };
  }
  if (args.length === 2 && args[0] === "--reason" && args[1] !== undefined) {
    return { valid: true, value: args[1] };
  }
  return { valid: false };
}

async function readStdinSafely(
  stdin: CliIo["stdin"],
): Promise<string | null> {
  try {
    return await readStdin(stdin);
  } catch {
    return null;
  }
}

// cli.ts is only ever loaded via bin/chima's `import "../dist/cli.js"`
// (see tests/*.test.ts, which import { runCli } directly instead of
// executing this file), so the module can always run the CLI on load.
// A "was this module executed directly" guard based on comparing
// process.argv[1] to import.meta.url was removed here because it breaks
// when bin/chima is invoked through a symlink (e.g. `~/.local/bin/chima`
// installed by install.sh): process.argv[1] keeps the symlink path while
// import.meta.url resolves to the physical dist/cli.js path, so the
// comparison never matched and no subcommand ever ran.
process.exitCode = await runCli(process.argv);
