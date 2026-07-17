#!/bin/sh

run_statusline() {
  if [ -n "${CHIMA_STATUSLINE_ORIG:-}" ]; then
    sh -c "${CHIMA_STATUSLINE_ORIG}"
  elif [ -f "$HOME/.claude/statusline-command.sh" ]; then
    sh "$HOME/.claude/statusline-command.sh"
  else
    cat >/dev/null
  fi
}

if command -v chima >/dev/null 2>&1; then
  chima session record | run_statusline
else
  run_statusline
fi
