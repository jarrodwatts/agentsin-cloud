#!/usr/bin/env bash
set -euo pipefail

readonly desktop_root="/run/agentsin/desktop"
readonly vnc_password_file="${desktop_root}/vnc.passwd"
readonly xauthority_file="${desktop_root}/Xauthority"
readonly xdg_runtime_directory="${desktop_root}/xdg"
readonly pid_root="${desktop_root}/pids"

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
rm -rf -- "${pid_root}"
install -d -m 0700 "${pid_root}"
generation="$(mcookie)"
[[ "${generation}" =~ ^[0-9a-f]{32}$ ]]
pid_directory="${pid_root}/${generation}"
install -d -m 0700 "${pid_directory}"
printf '%s\n' "${generation}" >"${pid_root}/.current.${generation}"
mv -f -- "${pid_root}/.current.${generation}" "${pid_root}/current"
rm -f "${XAUTHORITY}"
xauth -f "${XAUTHORITY}" add "${DISPLAY}" MIT-MAGIC-COOKIE-1 "$(mcookie)"

record_pid() {
  local name="$1"
  local pid="$2"
  local record_path="${pid_directory}/${name}.record"
  local stat_line
  local stat_tail
  local -a stat_fields
  stat_line="$(<"/proc/${pid}/stat")"
  stat_tail="${stat_line##*) }"
  read -r -a stat_fields <<<"${stat_tail}"
  test "${#stat_fields[@]}" -ge 20
  [[ "${stat_fields[19]}" =~ ^[0-9]+$ ]]
  printf '%s\n%s\n%s\n' "${generation}" "${pid}" "${stat_fields[19]}" \
    >"${record_path}.tmp"
  mv -f -- "${record_path}.tmp" "${record_path}"
}

declare -a child_pids=()
child_pid=""
cleanup() {
  local pid
  for pid in "${child_pids[@]}"; do
    kill "${pid}" 2>/dev/null || true
  done
  for pid in "${child_pids[@]}"; do
    wait "${pid}" 2>/dev/null || true
  done
  rm -rf -- "${pid_root}"
}
trap cleanup EXIT INT TERM

/usr/bin/Xvfb "${DISPLAY}" -auth "${XAUTHORITY}" -screen 0 1440x1024x24 -nolisten tcp &
child_pid="$!"
child_pids+=("${child_pid}")
record_pid Xvfb "${child_pid}"
for _ in $(seq 1 100); do
  if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.05
done
xdpyinfo -display "${DISPLAY}" >/dev/null

/usr/bin/xfce4-session &
child_pid="$!"
child_pids+=("${child_pid}")
record_pid xfce4-session "${child_pid}"
/usr/bin/x11vnc \
  -display "${DISPLAY}" \
  -auth "${XAUTHORITY}" \
  -forever \
  -shared \
  -localhost \
  -rfbport 5900 \
  -rfbauth "${vnc_password_file}" \
  -noxdamage \
  -repeat &
child_pid="$!"
child_pids+=("${child_pid}")
record_pid x11vnc "${child_pid}"
/usr/bin/bash /usr/share/novnc/utils/novnc_proxy \
  --vnc localhost:5900 \
  --listen 6080 \
  --web /usr/share/novnc \
  --heartbeat 30 &
child_pid="$!"
child_pids+=("${child_pid}")
record_pid novnc_proxy "${child_pid}"

set +e
wait -n "${child_pids[@]}"
readonly child_status=$?
set -e
exit "${child_status}"
