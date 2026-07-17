#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [settingsPath, connectorDirectory] = process.argv.slice(2);

if (settingsPath === undefined || connectorDirectory === undefined) {
  process.stderr.write(
    "usage: merge-claude-settings.mjs <settings.json> <connector-directory>\n",
  );
  process.exitCode = 1;
} else {
  await mergeSettings(settingsPath, connectorDirectory);
}

async function mergeSettings(path, connector) {
  const settings = await readSettings(path);
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};

  addHook(
    hooks,
    "PostToolUse",
    shellQuote(join(connector, "hooks", "context-guard.sh")),
  );
  addHook(
    hooks,
    "Stop",
    shellQuote(join(connector, "hooks", "stop-gate.sh")),
  );
  settings.hooks = hooks;

  const wrapper = join(connector, "statusline-wrapper.sh");
  const currentCommand =
    isRecord(settings.statusLine) &&
    settings.statusLine.type === "command" &&
    typeof settings.statusLine.command === "string"
      ? settings.statusLine.command
      : null;

  if (currentCommand === null || !currentCommand.includes(wrapper)) {
    const original = currentCommand === null ? "" : currentCommand;
    const originalPrefix =
      original === ""
        ? ""
        : `CHIMA_STATUSLINE_ORIG=${shellQuote(original)} `;
    settings.statusLine = {
      type: "command",
      command: `${originalPrefix}${shellQuote(wrapper)}`,
    };
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function readSettings(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) {
      throw new Error("Claude Code の settings.json は JSON object である必要があります");
    }
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function addHook(hooks, event, command) {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
  const exists = entries.some(
    (entry) =>
      isRecord(entry) &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some(
        (hook) => isRecord(hook) && hook.command === command,
      ),
  );

  if (!exists) {
    entries.push({ hooks: [{ type: "command", command }] });
  }
  hooks[event] = entries;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}
