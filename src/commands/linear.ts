import { LinearClient, type IssueUpdateInput } from "../lib/linear-client.js";
import { authenticateLinear } from "../lib/linear-auth.js";

interface LinearCommandIo {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export async function runLinearCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  io: LinearCommandIo,
): Promise<number> {
  try {
    if (args.length === 1 && args[0] === "auth") {
      await authenticateLinear(env, io.writeStdout);
      return 0;
    }

    const client = new LinearClient(env);

    if (args.length === 3 && args[0] === "issue" && args[1] === "get") {
      writeJson(io, await client.getIssue(args[2]!));
      return 0;
    }

    if (
      args.length >= 4 &&
      args[0] === "comment" &&
      args[1] === "create"
    ) {
      const issueId = args[2]!;
      const body = args[3]!;
      const options = parseOptions(args.slice(4), new Set(["parent"]));
      writeJson(io, await client.createComment(issueId, body, options.parent));
      return 0;
    }

    if (args.length >= 3 && args[0] === "issue" && args[1] === "update") {
      const id = args[2]!;
      const options = parseOptions(
        args.slice(3),
        new Set(["state", "assignee", "description", "blocker"]),
      );
      const input: IssueUpdateInput = {};
      if (options.state !== undefined) input.stateId = options.state;
      if (options.assignee !== undefined) input.assigneeId = options.assignee;
      if (options.description !== undefined) input.description = options.description;

      if (Object.keys(input).length === 0 && options.blocker === undefined) {
        throw new Error("issue update には更新オプションが必要です");
      }

      const result: Record<string, unknown> = {};
      if (Object.keys(input).length > 0) {
        result.issueUpdate = await client.updateIssue(id, input);
      }
      if (options.blocker !== undefined) {
        result.blockerCreate = await client.addBlocker(id, options.blocker);
      }
      writeJson(io, result);
      return 0;
    }

    if (args.length >= 4 && args[0] === "issue" && args[1] === "create") {
      const teamId = args[2]!;
      const title = args[3]!;
      const options = parseOptions(args.slice(4), new Set(["description"]));
      writeJson(
        io,
        await client.createIssue({
          teamId,
          title,
          ...(options.description === undefined
            ? {}
            : { description: options.description }),
        }),
      );
      return 0;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.writeStderr(`${message}\n`);
    return 1;
  }

  io.writeStderr(`${linearUsage()}\n`);
  return 1;
}

function parseOptions(
  args: string[],
  allowed: ReadonlySet<string>,
): Record<string, string> {
  const options: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      option === undefined ||
      !option.startsWith("--") ||
      !allowed.has(option.slice(2)) ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(`不正なオプションです: ${option ?? ""}`);
    }
    options[option.slice(2)] = value;
  }

  return options;
}

function writeJson(io: LinearCommandIo, value: unknown): void {
  io.writeStdout(`${JSON.stringify(value)}\n`);
}

function linearUsage(): string {
  return [
    "usage:",
    "  chima linear auth",
    "  chima linear issue get <id>",
    "  chima linear comment create <issueId> <body> [--parent <commentId>]",
    "  chima linear issue update <id> [--state <stateId>] [--assignee <userId>] [--description <text>] [--blocker <issueId>]",
    "  chima linear issue create <teamId> <title> [--description <text>]",
  ].join("\n");
}
