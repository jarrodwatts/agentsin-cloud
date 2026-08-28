#!/usr/bin/env bash
set -euo pipefail

readonly supervisor_desktop_failure_status=70
supervisor_bootstrap_ref=""
supervisor_desktop_root=""
supervisor_desktop_pid=""
supervisor_worker_pid=""
supervisor_cleanup_done=0
supervisor_observed_status=0

supervisor_cleanup_once() {
  if [[ "${supervisor_cleanup_done}" -eq 1 ]]; then
    return
  fi
  supervisor_cleanup_done=1
  if [[ -n "${supervisor_worker_pid}" ]]; then
    kill "${supervisor_worker_pid}" 2>/dev/null || true
  fi
  if [[ -n "${supervisor_desktop_pid}" ]]; then
    kill "${supervisor_desktop_pid}" 2>/dev/null || true
  fi
  if [[ -n "${supervisor_worker_pid}" ]]; then
    wait "${supervisor_worker_pid}" 2>/dev/null || true
  fi
  if [[ -n "${supervisor_desktop_pid}" ]]; then
    wait "${supervisor_desktop_pid}" 2>/dev/null || true
  fi
  if [[ -n "${supervisor_desktop_root}" ]]; then
    rm -rf -- "${supervisor_desktop_root}"
  fi
}

supervisor_handle_signal() {
  local signal_status="$1"
  trap - EXIT INT TERM
  supervisor_cleanup_once
  exit "${signal_status}"
}

supervisor_install_traps() {
  trap supervisor_cleanup_once EXIT
  trap 'supervisor_handle_signal 130' INT
  trap 'supervisor_handle_signal 143' TERM
}

supervisor_wait_for_bootstrap() {
  local desktop_status
  supervisor_observed_status=0
  while [[ ! -f "${supervisor_bootstrap_ref}" ]]; do
    if ! kill -0 "${supervisor_desktop_pid}" 2>/dev/null; then
      if wait "${supervisor_desktop_pid}"; then
        desktop_status=0
      else
        desktop_status=$?
      fi
      if [[ "${desktop_status}" -eq 0 ]]; then
        supervisor_observed_status="${supervisor_desktop_failure_status}"
      else
        supervisor_observed_status="${desktop_status}"
      fi
      return 0
    fi
    sleep 0.05
  done
}

supervisor_wait_for_children() {
  local desktop_status
  local worker_status
  supervisor_observed_status=0
  while true; do
    if ! kill -0 "${supervisor_desktop_pid}" 2>/dev/null; then
      if wait "${supervisor_desktop_pid}"; then
        desktop_status=0
      else
        desktop_status=$?
      fi
      if [[ "${desktop_status}" -eq 0 ]]; then
        supervisor_observed_status="${supervisor_desktop_failure_status}"
      else
        supervisor_observed_status="${desktop_status}"
      fi
      return 0
    fi
    if ! kill -0 "${supervisor_worker_pid}" 2>/dev/null; then
      if wait "${supervisor_worker_pid}"; then
        worker_status=0
      else
        worker_status=$?
      fi
      supervisor_observed_status="${worker_status}"
      return 0
    fi
    sleep 0.05
  done
}

supervisor_main() {
  local bootstrap_status
  local child_status
  local vnc_password
  local vnc_password_file
  supervisor_bootstrap_ref="/run/agentsin/bootstrap/sealed.json"
  supervisor_desktop_root="/run/agentsin/desktop"
  supervisor_desktop_pid=""
  supervisor_worker_pid=""
  supervisor_cleanup_done=0
  supervisor_observed_status=0
  vnc_password_file="${supervisor_desktop_root}/vnc.passwd"

  supervisor_install_traps
  test "$(id -u)" = "0"
  install -d -o agentsin-inspector -g agentsin-inspector -m 0700 "${supervisor_desktop_root}"
  vnc_password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("base64url"))')"
  printf '%s\n%s\ny\n' "${vnc_password}" "${vnc_password}" | \
    x11vnc -storepasswd "${vnc_password_file}" >/dev/null
  unset vnc_password
  chown agentsin-inspector:agentsin-inspector "${vnc_password_file}"
  chmod 0600 "${vnc_password_file}"

  /opt/agentsin/start-desktop.sh &
  supervisor_desktop_pid="$!"

  supervisor_wait_for_bootstrap
  bootstrap_status="${supervisor_observed_status}"
  if [[ "${bootstrap_status}" -ne 0 ]]; then
    return "${bootstrap_status}"
  fi

  /opt/agentsin/start-worker.sh "${supervisor_bootstrap_ref}" &
  supervisor_worker_pid="$!"

  supervisor_wait_for_children
  child_status="${supervisor_observed_status}"
  return "${child_status}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  supervisor_main
fi
