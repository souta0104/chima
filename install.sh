#!/usr/bin/env bash

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHIMA_BIN="${REPO_DIR}/bin/chima"
LOCAL_BIN="${HOME}/.local/bin"
CHIMA_HOME="${CHIMA_HOME:-${HOME}/.chima}"
LAUNCH_AGENTS="${HOME}/Library/LaunchAgents"
PLIST="${LAUNCH_AGENTS}/com.chima.tick.plist"
CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"
CLAUDE_HOME="${HOME}/.claude"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  printf '%s' "${value}"
}

mkdir -p \
  "${LOCAL_BIN}" \
  "${CHIMA_HOME}/config" \
  "${CHIMA_HOME}/state/sessions" \
  "${CHIMA_HOME}/state/projects" \
  "${CHIMA_HOME}/state/pending" \
  "${CHIMA_HOME}/logs" \
  "${CODEX_HOME}/skills/worker-run" \
  "${CLAUDE_HOME}/skills/worker-run" \
  "${LAUNCH_AGENTS}"

ln -sfn "${CHIMA_BIN}" "${LOCAL_BIN}/chima"
cp "${REPO_DIR}/connectors/common/skills/worker-run/SKILL.md" \
  "${CODEX_HOME}/skills/worker-run/SKILL.md"
cp "${REPO_DIR}/connectors/common/skills/worker-run/SKILL.md" \
  "${CLAUDE_HOME}/skills/worker-run/SKILL.md"
chmod +x \
  "${REPO_DIR}/connectors/codex/hooks/context-guard.sh" \
  "${REPO_DIR}/connectors/codex/hooks/stop-gate.sh"
node "${REPO_DIR}/scripts/install-codex-hooks.mjs" \
  "${CODEX_HOME}/hooks.json" \
  "${REPO_DIR}/connectors/codex"

ESCAPED_BIN="$(xml_escape "${CHIMA_BIN}")"
ESCAPED_REPO="$(xml_escape "${REPO_DIR}")"
ESCAPED_HOME="$(xml_escape "${CHIMA_HOME}")"
ESCAPED_PATH="$(xml_escape "${PATH}")"
ESCAPED_LOG="$(xml_escape "${CHIMA_HOME}/logs/tick.log")"

cat >"${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.chima.tick</string>
  <key>ProgramArguments</key>
  <array>
    <string>${ESCAPED_BIN}</string>
    <string>tick</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ESCAPED_REPO}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CHIMA_HOME</key>
    <string>${ESCAPED_HOME}</string>
    <key>PATH</key>
    <string>${ESCAPED_PATH}</string>
  </dict>
  <key>StartInterval</key>
  <integer>120</integer>
  <key>StandardOutPath</key>
  <string>${ESCAPED_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ESCAPED_LOG}</string>
</dict>
</plist>
EOF

if [[ "${CHIMA_SKIP_LAUNCHD:-0}" != "1" ]]; then
  launchctl unload "${PLIST}" 2>/dev/null || true
  launchctl load "${PLIST}"
fi

printf 'chima を %s に配置しました。\n' "${LOCAL_BIN}/chima"
printf '%s が PATH にない場合は、シェル設定へ追加してください。\n' "${LOCAL_BIN}"
printf 'worker-run skill を Claude Code と Codex に配置しました。\n'
printf 'Codex hooks を既存の %s を保持して追加しました。\n' \
  "${CODEX_HOME}/hooks.json"
printf 'Codex の /hooks で追加した hook を確認し、信頼してください。\n'
printf 'Claude Code の hooks と statusline は自動変更していません。\n'
printf '%s の内容を ~/.claude/settings.json に手動でマージしてください。\n' \
  "${REPO_DIR}/connectors/claude-code/settings.snippet.json"
