#!/usr/bin/env bash

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHIMA_BIN="${REPO_DIR}/bin/chima"
LOCAL_BIN="${HOME}/.local/bin"
CHIMA_HOME="${CHIMA_HOME:-${HOME}/.chima}"
LAUNCH_AGENTS="${HOME}/Library/LaunchAgents"
PLIST="${LAUNCH_AGENTS}/com.chima.tick.plist"
CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"
WORKER_SKILL="${REPO_DIR}/connectors/common/skills/worker-run"
OLD_WORKER_SKILL="${REPO_DIR}/connectors/claude-code/skills/worker-run"
CLAUDE_HOME="${HOME}/.claude"
CLAUDE_SKILLS="${CLAUDE_HOME}/skills"
WORKER_SKILL_LINK="${CLAUDE_SKILLS}/worker-run"
ENABLE_LAUNCHD=false
ENABLE_CLAUDE_CODE=false

for arg in "$@"; do
  case "${arg}" in
  --enable-launchd)
    ENABLE_LAUNCHD=true
    ;;
  --enable-claude-code)
    ENABLE_CLAUDE_CODE=true
    ;;
  *)
    printf '不明なオプションです: %s\n' "${arg}" >&2
    exit 1
    ;;
  esac
done

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
  "${CLAUDE_SKILLS}"

ln -sfn "${CHIMA_BIN}" "${LOCAL_BIN}/chima"
cp "${REPO_DIR}/connectors/common/skills/worker-run/SKILL.md" \
  "${CODEX_HOME}/skills/worker-run/SKILL.md"
chmod +x \
  "${REPO_DIR}/connectors/codex/hooks/context-guard.sh" \
  "${REPO_DIR}/connectors/codex/hooks/stop-gate.sh"
node "${REPO_DIR}/scripts/install-codex-hooks.mjs" \
  "${CODEX_HOME}/hooks.json" \
  "${REPO_DIR}/connectors/codex"

if [[ -L "${WORKER_SKILL_LINK}" && -e "${WORKER_SKILL_LINK}" && \
  "${WORKER_SKILL_LINK}" -ef "${WORKER_SKILL}" ]]; then
  :
elif [[ -L "${WORKER_SKILL_LINK}" && \
  "$(readlink "${WORKER_SKILL_LINK}")" == "${OLD_WORKER_SKILL}" ]]; then
  ln -sfn "${WORKER_SKILL}" "${WORKER_SKILL_LINK}"
elif [[ -e "${WORKER_SKILL_LINK}" || -L "${WORKER_SKILL_LINK}" ]]; then
  printf '%s は本リポジトリの worker-run skill への symlink ではないため、上書きしません。\n' \
    "${WORKER_SKILL_LINK}" >&2
  exit 1
else
  ln -s "${WORKER_SKILL}" "${WORKER_SKILL_LINK}"
fi

if [[ "${ENABLE_CLAUDE_CODE}" == true ]]; then
  node "${REPO_DIR}/scripts/merge-claude-settings.mjs" \
    "${CLAUDE_HOME}/settings.json" \
    "${REPO_DIR}/connectors/claude-code"
fi

if [[ "${ENABLE_LAUNCHD}" == true ]]; then
  PROJECTS_JSON="${CHIMA_HOME}/config/projects.json"
  NODE_BIN="$(command -v node)"

  if [[ ! -f "${PROJECTS_JSON}" ]]; then
    printf 'projects.json が見つかりません。先にプロジェクトを登録してください。\n' >&2
    exit 1
  fi

  if ! jq -e 'any(.projects[]?; .enabled == true)' "${PROJECTS_JSON}" >/dev/null; then
    printf 'enabled なプロジェクトがありません。先にプロジェクトを有効化してください。\n' >&2
    exit 1
  fi

  if [[ ! -f "${REPO_DIR}/dist/cli.js" ]]; then
    printf 'dist/cli.js が見つかりません。先に pnpm build を実行してください。\n' >&2
    exit 1
  fi

  mkdir -p "${LAUNCH_AGENTS}"

  ESCAPED_NODE="$(xml_escape "${NODE_BIN}")"
  ESCAPED_CLI="$(xml_escape "${REPO_DIR}/dist/cli.js")"
  ESCAPED_REPO="$(xml_escape "${REPO_DIR}")"
  ESCAPED_HOME="$(xml_escape "${CHIMA_HOME}")"
  ESCAPED_PATH="$(xml_escape "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${LOCAL_BIN}")"
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
    <string>${ESCAPED_NODE}</string>
    <string>${ESCAPED_CLI}</string>
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

  launchctl unload "${PLIST}" 2>/dev/null || true
  launchctl load "${PLIST}"
fi

printf 'chima を %s に配置しました。\n' "${LOCAL_BIN}/chima"
printf '%s が PATH にない場合は、シェル設定へ追加してください。\n' "${LOCAL_BIN}"
printf 'worker-run skill を Claude Code と Codex に配置しました。\n'
printf 'Codex hooks を既存の %s を保持して追加しました。\n' \
  "${CODEX_HOME}/hooks.json"
printf 'Codex の /hooks で追加した hook を確認し、信頼してください。\n'

if [[ "${ENABLE_CLAUDE_CODE}" == true ]]; then
  printf 'Claude Code の hooks と statusline を有効化しました。\n'
else
  printf 'Claude Code の hooks と statusline は有効化していません。\n'
  printf '有効化する場合は ./install.sh --enable-claude-code を実行してください。\n'
fi

if [[ "${ENABLE_LAUNCHD}" == true ]]; then
  printf 'launchd を有効化しました。\n'
else
  printf 'launchd は有効化していません。\n'
  printf '有効化する場合は ./install.sh --enable-launchd を実行してください。\n'
fi
