#!/usr/bin/env bash
set -euo pipefail

command -v bwrap >/dev/null
command -v curl >/dev/null
command -v git >/dev/null
command -v mcookie >/dev/null
command -v node >/dev/null
command -v python3 >/dev/null
command -v setpriv >/dev/null
command -v sha256sum >/dev/null
command -v xauth >/dev/null
test -x /usr/share/novnc/utils/novnc_proxy
test -x /opt/agentsin/start-sandbox.sh
test -x /opt/agentsin/start-worker.sh
test -x /opt/agentsin/start-desktop.sh
test -x /opt/agentsin/desktop-session.sh
test -x /opt/agentsin/worker/entrypoint.mjs
test -x /opt/agentsin/worker/ProviderRuntimeChild.mjs
test "$(id -u agentsin-agent)" = "11001"
test "$(id -g agentsin-agent)" = "11001"
test "$(id -u agentsin-inspector)" = "11002"
test "$(id -g agentsin-inspector)" = "11002"
test "$(stat -c '%u:%g' /workspace)" = "11001:11001"
getfacl --absolute-names --omit-header /workspace | grep -qx 'user:agentsin-inspector:rwx'
getfacl --absolute-names --omit-header /workspace | grep -qx 'default:user:agentsin-inspector:rwx'
test "$(stat -c '%u:%g' /run/agentsin)" = "0:0"
test "$(stat -c '%a' /run/agentsin)" = "711"
test "$(stat -c '%a' /run/agentsin/bootstrap)" = "700"
test "$(stat -c '%a' /run/agentsin/mtls)" = "700"
test "$(stat -c '%a' /run/agentsin/provider-credentials)" = "711"
! setpriv --reuid=11001 --regid=11001 --clear-groups -- /bin/ls /run/agentsin >/dev/null 2>&1

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

/opt/agentsin/start-sandbox.sh >/tmp/agentsin-supervisor-verify.log 2>&1 &
readonly supervisor_pid=$!
cleanup_supervisor() {
  kill "${supervisor_pid}" 2>/dev/null || true
  wait "${supervisor_pid}" 2>/dev/null || true
}
trap cleanup_supervisor EXIT INT TERM

for _ in $(seq 1 200); do
  if [[ -s /run/agentsin/desktop/Xauthority ]] &&
    [[ -s /run/agentsin/desktop/vnc.passwd ]] &&
    [[ -s /run/agentsin/desktop/pids/Xvfb.pid ]] &&
    [[ -s /run/agentsin/desktop/pids/xfce4-session.pid ]] &&
    [[ -s /run/agentsin/desktop/pids/x11vnc.pid ]] &&
    [[ -s /run/agentsin/desktop/pids/novnc_proxy.pid ]] &&
    python3 - <<'PY'
import socket
with socket.create_connection(("127.0.0.1", 5900), timeout=0.1):
    pass
PY
  then
    break
  fi
  if ! kill -0 "${supervisor_pid}" 2>/dev/null; then
    cat /tmp/agentsin-supervisor-verify.log >&2
    exit 1
  fi
  sleep 0.05
done

test "$(stat -c '%u:%g' /run/agentsin/desktop)" = "11002:11002"
test "$(stat -c '%a' /run/agentsin/desktop)" = "700"
test "$(stat -c '%u:%g' /run/agentsin/desktop/Xauthority)" = "11002:11002"
test "$(stat -c '%a' /run/agentsin/desktop/Xauthority)" = "600"
test "$(stat -c '%u:%g' /run/agentsin/desktop/vnc.passwd)" = "11002:11002"
test "$(stat -c '%a' /run/agentsin/desktop/vnc.passwd)" = "600"
test "$(stat -c '%u:%g' /run/agentsin/desktop/pids)" = "11002:11002"
test "$(stat -c '%a' /run/agentsin/desktop/pids)" = "700"
! setpriv --reuid=11001 --regid=11001 --clear-groups -- /usr/bin/test -r /run/agentsin/desktop/Xauthority
! setpriv --reuid=11001 --regid=11001 --clear-groups -- /usr/bin/test -r /run/agentsin/desktop/vnc.passwd
! setpriv --reuid=11001 --regid=11001 --clear-groups -- \
  /usr/bin/test -r /run/agentsin/desktop/pids/Xvfb.pid
! setpriv --reuid=11001 --regid=11001 --clear-groups -- \
  env DISPLAY=:0 XAUTHORITY=/dev/null xdpyinfo -display :0 >/dev/null 2>&1

verify_inspector_process() {
  local name="$1"
  local expected_command="$2"
  local pid_file="/run/agentsin/desktop/pids/${name}.pid"
  local argument
  local command_found=0
  local pid
  test "$(stat -c '%u:%g' "${pid_file}")" = "11002:11002"
  test "$(stat -c '%a' "${pid_file}")" = "600"
  read -r pid <"${pid_file}"
  [[ "${pid}" =~ ^[1-9][0-9]*$ ]]
  test -r "/proc/${pid}/status"
  test -r "/proc/${pid}/cmdline"
  awk '$1 == "State:" { if ($2 == "Z") exit 1; state = 1 } $1 == "Uid:" && $2 == 11002 && $3 == 11002 && $4 == 11002 && $5 == 11002 { uid = 1 } END { exit !(state && uid) }' \
    "/proc/${pid}/status"
  while IFS= read -r -d '' argument; do
    if [[ "${argument}" = "${expected_command}" ]]; then
      command_found=1
    fi
  done <"/proc/${pid}/cmdline"
  test "${command_found}" -eq 1
}

verify_inspector_process Xvfb Xvfb
verify_inspector_process xfce4-session xfce4-session
verify_inspector_process x11vnc x11vnc
verify_inspector_process novnc_proxy /usr/share/novnc/utils/novnc_proxy

python3 - <<'PY'
import socket

with socket.create_connection(("127.0.0.1", 5900), timeout=1) as client:
    protocol = client.recv(12)
    if not protocol.startswith(b"RFB "):
        raise SystemExit("VNC protocol handshake is unavailable")
    client.sendall(protocol)
    count = client.recv(1)
    if len(count) != 1 or count[0] < 1:
        raise SystemExit("VNC security negotiation failed closed")
    security_types = client.recv(count[0])
    if 1 in security_types or 2 not in security_types:
        raise SystemExit("VNC allows an unauthenticated security type")
PY

cleanup_supervisor
trap - EXIT INT TERM
test ! -e /run/agentsin/desktop
rm -f /tmp/agentsin-supervisor-verify.log
node /opt/agentsin/verify-provenance.cjs
