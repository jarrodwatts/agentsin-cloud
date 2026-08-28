#!/usr/bin/env bash
set -euo pipefail

readonly bootstrap_ref="/run/agentsin/bootstrap/sealed.json"
readonly desktop_root="/run/agentsin/desktop"
readonly vnc_password_file="${desktop_root}/vnc.passwd"
desktop_pid=""
worker_pid=""

cleanup() {
  if [[ -n "${worker_pid}" ]]; then
    kill "${worker_pid}" 2>/dev/null || true
  fi
  if [[ -n "${desktop_pid}" ]]; then
    kill "${desktop_pid}" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  rm -rf -- "${desktop_root}"
}
trap cleanup EXIT INT TERM

test "$(id -u)" = "0"
install -d -o agentsin-inspector -g agentsin-inspector -m 0700 "${desktop_root}"
vnc_password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("base64url"))')"
printf '%s\n%s\ny\n' "${vnc_password}" "${vnc_password}" | \
  x11vnc -storepasswd "${vnc_password_file}" >/dev/null
unset vnc_password
chown agentsin-inspector:agentsin-inspector "${vnc_password_file}"
chmod 0600 "${vnc_password_file}"

/opt/agentsin/start-desktop.sh &
desktop_pid="$!"

while [[ ! -f "${bootstrap_ref}" ]]; do
  if ! kill -0 "${desktop_pid}" 2>/dev/null; then
    set +e
    wait "${desktop_pid}"
    desktop_status=$?
    set -e
    if [[ "${desktop_status}" -eq 0 ]]; then
      exit 1
    fi
    exit "${desktop_status}"
  fi
  sleep 0.1
done

/opt/agentsin/start-worker.sh "${bootstrap_ref}" &
worker_pid="$!"

set +e
wait -n "${desktop_pid}" "${worker_pid}"
child_status=$?
set -e
exit "${child_status}"
