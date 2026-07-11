#!/bin/sh

statusline_orig=${CHIMA_STATUSLINE_ORIG:-"$HOME/.claude/statusline-command.sh"}

if command -v chima >/dev/null 2>&1; then
  chima session record | sh "$statusline_orig"
else
  sh "$statusline_orig"
fi
