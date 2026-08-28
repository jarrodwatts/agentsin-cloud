#!/usr/bin/env bash
set -euo pipefail

readonly desktop_root="/run/agentsin/desktop"
readonly vnc_password_file="${desktop_root}/vnc.passwd"
readonly xauthority_file="${desktop_root}/Xauthority"
readonly xdg_runtime_directory="${desktop_root}/xdg"

test "$(id -u)" = "11002"
test "$(id -g)" = "11002"
test "$(stat -c '%a' "${desktop_root}")" = "700"
test "$(stat -c '%a' "${vnc_password_file}")" = "600"

export DISPLAY=":0"
export HOME="/home/agentsin-inspector"
export USER="agentsin-inspector"
export LOGNAME="agentsin-inspector"
export XAUTHORITY="${xauthority_file}"
export XDG_RUNTIME_DIR="${xdg_runtime_directory}"
export PATH="/usr/local/bin:/usr/bin:/bin"

umask 077
install -d -m 0700 "${XDG_RUNTIME_DIR}"
rm -f "${XAUTHORITY}"
xauth -f "${XAUTHORITY}" add "${DISPLAY}" MIT-MAGIC-COOKIE-1 "$(mcookie)"

declare -a child_pids=()
cleanup() {
  local pid
  for pid in "${child_pids[@]:-}"; do
    kill "${pid}" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

Xvfb "${DISPLAY}" -auth "${XAUTHORITY}" -screen 0 1440x1024x24 -nolisten tcp &
child_pids+=("$!")
for _ in $(seq 1 100); do
  if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.05
done
xdpyinfo -display "${DISPLAY}" >/dev/null

startxfce4 &
child_pids+=("$!")
x11vnc \
  -display "${DISPLAY}" \
  -auth "${XAUTHORITY}" \
  -forever \
  -shared \
  -localhost \
  -rfbport 5900 \
  -rfbauth "${vnc_password_file}" \
  -noxdamage \
  -repeat &
child_pids+=("$!")
/usr/share/novnc/utils/novnc_proxy \
  --vnc localhost:5900 \
  --listen 6080 \
  --web /usr/share/novnc \
  --heartbeat 30 &
child_pids+=("$!")

set +e
wait -n "${child_pids[@]}"
readonly child_status=$?
set -e
exit "${child_status}"
