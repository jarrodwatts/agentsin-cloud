#!/usr/bin/env bash
set -euo pipefail

readonly supervisor_script="$1"
source "${supervisor_script}"

readonly harness_root="$(mktemp -d)"
tracked_pids=""
blocking_child_pid=""

track_pid() {
  tracked_pids="${tracked_pids} $1"
}

start_blocking_child() {
  local label="$1"
  local block_pipe="${harness_root}/${label}.block"
  local ready_pipe="${harness_root}/${label}.child-ready"
  mkfifo "${block_pipe}" "${ready_pipe}"
  (
    trap 'exit 0' INT TERM
    exec 9<>"${block_pipe}"
    printf 'ready\n' >"${ready_pipe}"
    read -r _ <&9
  ) &
  blocking_child_pid="$!"
  read -r _ <"${ready_pipe}"
}

harness_cleanup() {
  local pid
  trap - EXIT INT TERM
  for pid in ${tracked_pids}; do
    kill "${pid}" 2>/dev/null || true
  done
  for pid in ${tracked_pids}; do
    wait "${pid}" 2>/dev/null || true
  done
  rm -rf -- "${harness_root}"
}
trap harness_cleanup EXIT INT TERM

reset_supervisor_state() {
  supervisor_bootstrap_ref="${harness_root}/missing-bootstrap"
  supervisor_desktop_root="${harness_root}/desktop-runtime"
  supervisor_desktop_pid=""
  supervisor_worker_pid=""
  supervisor_cleanup_done=0
  mkdir -p "${supervisor_desktop_root}"
}

assert_status() {
  local expected="$1"
  local actual="$2"
  local scenario="$3"
  if [[ "${actual}" -ne "${expected}" ]]; then
    echo "${scenario}: expected ${expected}, received ${actual}" >&2
    exit 1
  fi
}

run_child_exit_case() {
  local desktop_exit="$1"
  local worker_exit="$2"
  local expected="$3"
  local scenario="$4"
  local status
  reset_supervisor_state
  (exit "${desktop_exit}") &
  supervisor_desktop_pid="$!"
  track_pid "${supervisor_desktop_pid}"
  if [[ "${worker_exit}" = "sleep" ]]; then
    start_blocking_child "${scenario}-worker"
    supervisor_worker_pid="${blocking_child_pid}"
  else
    (exit "${worker_exit}") &
    supervisor_worker_pid="$!"
  fi
  track_pid "${supervisor_worker_pid}"
  supervisor_wait_for_children
  status="${supervisor_observed_status}"
  supervisor_cleanup_once
  assert_status "${expected}" "${status}" "${scenario}"
}

run_child_exit_case 0 sleep 70 desktop-zero
run_child_exit_case 42 sleep 42 desktop-nonzero

reset_supervisor_state
start_blocking_child worker-shutdown-desktop
supervisor_desktop_pid="${blocking_child_pid}"
track_pid "${supervisor_desktop_pid}"
(exit 0) &
supervisor_worker_pid="$!"
track_pid "${supervisor_worker_pid}"
supervisor_wait_for_children
worker_status="${supervisor_observed_status}"
supervisor_cleanup_once
assert_status 0 "${worker_status}" worker-shutdown

run_signal_case() {
  local phase="$1"
  local ready_pipe="${harness_root}/${phase}.ready"
  local signal_status
  mkfifo "${ready_pipe}"
  (
    supervisor_bootstrap_ref="${harness_root}/${phase}.bootstrap"
    supervisor_desktop_root="${harness_root}/${phase}.desktop"
    supervisor_cleanup_done=0
    mkdir -p "${supervisor_desktop_root}"
    start_blocking_child "${phase}-desktop"
    supervisor_desktop_pid="${blocking_child_pid}"
    if [[ "${phase}" = "after-worker" ]]; then
      start_blocking_child "${phase}-worker"
      supervisor_worker_pid="${blocking_child_pid}"
    else
      supervisor_worker_pid=""
    fi
    supervisor_install_traps
    printf '%s %s\n' "${supervisor_desktop_pid}" "${supervisor_worker_pid:-none}" >"${ready_pipe}"
    if [[ "${phase}" = "after-worker" ]]; then
      supervisor_wait_for_children
    else
      supervisor_wait_for_bootstrap
    fi
  ) &
  local supervisor_pid="$!"
  track_pid "${supervisor_pid}"
  local desktop_child
  local worker_child
  read -r desktop_child worker_child <"${ready_pipe}"
  track_pid "${desktop_child}"
  if [[ "${worker_child}" != "none" ]]; then
    track_pid "${worker_child}"
  fi
  kill -TERM "${supervisor_pid}"
  set +e
  wait "${supervisor_pid}"
  signal_status=$?
  set -e
  assert_status 143 "${signal_status}" "SIGTERM-${phase}"
  if kill -0 "${desktop_child}" 2>/dev/null; then
    echo "SIGTERM-${phase}: desktop child survived cleanup" >&2
    exit 1
  fi
  if [[ "${worker_child}" != "none" ]] && kill -0 "${worker_child}" 2>/dev/null; then
    echo "SIGTERM-${phase}: worker child survived cleanup" >&2
    exit 1
  fi
}

run_signal_case before-bootstrap
run_signal_case after-worker

echo "sandbox supervisor harness passed"
