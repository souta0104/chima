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

function main(argv: string[]): void {
  const command = argv[2];

  if (command === undefined || !KNOWN_COMMANDS.includes(command)) {
    console.error(usage());
    process.exit(1);
  }
}

main(process.argv);
