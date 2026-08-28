#!/usr/bin/env bash
set -euo pipefail

command -v bwrap >/dev/null
command -v curl >/dev/null
command -v git >/dev/null
command -v node >/dev/null
command -v setpriv >/dev/null
command -v sha256sum >/dev/null
test -x /usr/share/novnc/utils/novnc_proxy
test -x /opt/agentsin/start-worker.sh
test -x /opt/agentsin/worker/entrypoint.mjs
test -x /opt/agentsin/worker/ProviderRuntimeChild.mjs
test "$(id -u agentsin-agent)" = "11001"
test "$(id -g agentsin-agent)" = "11001"
test "$(id -u agentsin-inspector)" = "11002"
test "$(id -g agentsin-inspector)" = "11002"
test "$(stat -c '%u:%g' /workspace)" = "11001:11001"
getfacl --absolute-names --omit-header /workspace | grep -qx 'user:agentsin-inspector:rwx'
getfacl --absolute-names --omit-header /workspace | grep -qx 'default:user:agentsin-inspector:rwx'

cd /opt/agentsin/worker
sha256sum --check --strict SHA256SUMS
node -e 'const p=require("node-pty");if(typeof p.spawn!=="function")process.exit(1)'

test -z "${E2B_API_KEY:-}"
test -z "${OPENAI_API_KEY:-}"
test -z "${ANTHROPIC_API_KEY:-}"
test -z "${XAI_API_KEY:-}"
test -z "${OPENROUTER_API_KEY:-}"
test -z "${TURNKEY_API_PRIVATE_KEY:-}"
test -z "${WALLET_PRIVATE_KEY:-}"
test ! -e /home/agentsin-agent/.codex
test ! -e /home/agentsin-agent/.claude
test ! -e /home/agentsin-agent/.cursor
test ! -e /home/agentsin-agent/.config/opencode
test -z "$(find /run/agentsin -mindepth 1 -type f -print -quit)"

set +e
env -i HOME=/root PATH=/usr/local/bin:/usr/bin:/bin \
  timeout 5 /opt/agentsin/worker/entrypoint.mjs \
  >/tmp/agentsin-worker-verify.log 2>&1
readonly worker_status=$?
set -e
test "${worker_status}" -ne 0
test "${worker_status}" -ne 124
grep -q 'startup failed closed' /tmp/agentsin-worker-verify.log
rm -f /tmp/agentsin-worker-verify.log
