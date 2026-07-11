import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { recordSession } from "./commands/session.js";
import { formatStatusText, getStatus } from "./commands/status.js";

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
    "commands (planned):",
    ...KNOWN_COMMANDS.map((name) => `  ${name}`),
  ].join("\n");
}

interface CliIo {
  stdin: AsyncIterable<string | Uint8Array>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

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
): Promise<number> {
  const command = argv[2];

  if (command === undefined || !KNOWN_COMMANDS.includes(command)) {
    io.writeStderr(`${usage()}\n`);
    return 1;
  }

  if (command === "session" && argv[3] === "record" && argv.length === 4) {
    const input = await readStdin(io.stdin);
    io.writeStdout(await recordSession(input, env));
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

  io.writeStderr(`${usage()}\n`);
  return 1;
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  process.exitCode = await runCli(process.argv);
}
