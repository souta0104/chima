#!/usr/bin/env bash

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
ORIGINAL_PATH="${PATH}"

cleanup() {
  rm -rf "${TEST_ROOT}"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

run_install() {
  local home="$1"
  shift
  HOME="${home}" PATH="${TEST_ROOT}/bin:${ORIGINAL_PATH}" \
    bash "${REPO_DIR}/install.sh" "$@"
}

mkdir -p "${TEST_ROOT}/bin"
cat >"${TEST_ROOT}/bin/launchctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${HOME}/launchctl.calls"
EOF
chmod +x "${TEST_ROOT}/bin/launchctl"

default_home="${TEST_ROOT}/default"
default_output="$(run_install "${default_home}" 2>&1)"
[[ ! -e "${default_home}/Library/LaunchAgents/com.chima.tick.plist" ]] || \
  fail 'フラグなしで plist が生成された'
[[ ! -e "${default_home}/launchctl.calls" ]] || \
  fail 'フラグなしで launchctl が呼び出された'
[[ -L "${default_home}/.claude/skills/worker-run" ]] || \
  fail 'worker-run skill の symlink が生成されなかった'
[[ "${default_output}" == *'launchd は有効化していません。'* ]] || \
  fail 'launchd を有効化していない旨が表示されなかった'

claude_home="${TEST_ROOT}/claude"
mkdir -p "${claude_home}/.claude"
cat >"${claude_home}/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {"type": "command", "command": "existing-hook"}
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "sh /existing/statusline.sh"
  }
}
EOF
run_install "${claude_home}" --enable-claude-code >/dev/null
run_install "${claude_home}" --enable-claude-code >/dev/null
settings="${claude_home}/.claude/settings.json"
[[ "$(jq -r '.hooks.UserPromptSubmit[0].hooks[0].command' "${settings}")" == \
  'existing-hook' ]] || fail '既存 hook が保持されなかった'
[[ "$(jq '[.hooks.PostToolUse[].hooks[] | select(.command | contains("context-guard.sh"))] | length' "${settings}")" == \
  '1' ]] || fail 'PostToolUse hook が1件になっていない'
[[ "$(jq '[.hooks.Stop[].hooks[] | select(.command | contains("stop-gate.sh"))] | length' "${settings}")" == \
  '1' ]] || fail 'Stop hook が1件になっていない'
[[ "$(jq -r '.statusLine.command' "${settings}")" == \
  *'CHIMA_STATUSLINE_ORIG='* ]] || fail '既存 statusline が引き継がれなかった'
[[ "$(jq -r '.statusLine.command' "${settings}")" == \
  *'statusline-wrapper.sh'* ]] || fail 'statusline wrapper が設定されなかった'

missing_home="${TEST_ROOT}/missing"
set +e
missing_output="$(run_install "${missing_home}" --enable-launchd 2>&1)"
missing_status=$?
set -e
[[ ${missing_status} -ne 0 ]] || fail 'projects.json なしで exit 0 になった'
[[ "${missing_output}" == *'projects.json が見つかりません。'* ]] || \
  fail 'projects.json なしのエラーメッセージが表示されなかった'

disabled_home="${TEST_ROOT}/disabled"
mkdir -p "${disabled_home}/.chima/config"
cat >"${disabled_home}/.chima/config/projects.json" <<'EOF'
{"projects":[{"name":"disabled-project","enabled":false}]}
EOF
set +e
disabled_output="$(run_install "${disabled_home}" --enable-launchd 2>&1)"
disabled_status=$?
set -e
[[ ${disabled_status} -ne 0 ]] || fail 'enabled なしで exit 0 になった'
[[ "${disabled_output}" == *'enabled なプロジェクトがありません。'* ]] || \
  fail 'enabled なしのエラーメッセージが表示されなかった'

enabled_home="${TEST_ROOT}/enabled"
mkdir -p "${enabled_home}/.chima/config"
cat >"${enabled_home}/.chima/config/projects.json" <<'EOF'
{"projects":[{"name":"enabled-project","enabled":true}]}
EOF
run_install "${enabled_home}" --enable-launchd >/dev/null
plist="${enabled_home}/Library/LaunchAgents/com.chima.tick.plist"
[[ -f "${plist}" ]] || fail 'enabled ありで plist が生成されなかった'
[[ "$(tail -n 1 "${enabled_home}/launchctl.calls")" == "load ${plist}" ]] || \
  fail 'launchctl load の呼び出しを確認できなかった'
[[ "$(plutil -extract EnvironmentVariables.PATH raw "${plist}")" == \
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${enabled_home}/.local/bin" ]] || \
  fail 'launchd の PATH が固定値になっていない'

printf 'PASS: install.sh の通常実行・Claude Code 連携・launchd 有効化\n'
