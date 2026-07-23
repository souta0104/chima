import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [hooksPath, connectorRoot] = process.argv.slice(2);
if (hooksPath === undefined || connectorRoot === undefined) {
  throw new Error("usage: install-codex-hooks.mjs <hooks.json> <connector-root>");
}

const hooks = await readHooks(hooksPath);
addCommandHook(
  hooks,
  "PostToolUse",
  resolve(connectorRoot, "hooks", "context-guard.sh"),
);
addCommandHook(
  hooks,
  "Stop",
  resolve(connectorRoot, "hooks", "stop-gate.sh"),
);

await mkdir(dirname(hooksPath), { recursive: true });
await writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, "utf8");

async function readHooks(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${path} のルートは JSON object である必要があります`);
    }
    if (value.hooks === undefined) {
      value.hooks = {};
    }
    if (
      typeof value.hooks !== "object" ||
      value.hooks === null ||
      Array.isArray(value.hooks)
    ) {
      throw new Error(`${path} の hooks は JSON object である必要があります`);
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { hooks: {} };
    }
    throw error;
  }
}

function addCommandHook(config, event, command) {
  const existing = config.hooks[event];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error(`hooks.${event} は array である必要があります`);
  }

  const groups = existing ?? [];
  const alreadyInstalled = groups.some(
    (group) =>
      typeof group === "object" &&
      group !== null &&
      Array.isArray(group.hooks) &&
      group.hooks.some(
        (hook) =>
          typeof hook === "object" &&
          hook !== null &&
          hook.type === "command" &&
          hook.command === command,
      ),
  );
  if (!alreadyInstalled) {
    groups.push({
      hooks: [{ type: "command", command, timeout: 30 }],
    });
  }
  config.hooks[event] = groups;
}
