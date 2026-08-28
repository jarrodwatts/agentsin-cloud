#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/bin:/bin

fail_invariant() {
  printf 'Protected worker isolation invariant failed: %s\n' "$1" >&2
  exit 1
}

require_equal() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail_invariant "$message"
  fi
}

require_match() {
  local value="$1"
  local pattern="$2"
  local message="$3"
  if [[ ! "$value" =~ $pattern ]]; then
    fail_invariant "$message"
  fi
}

supplementary_groups_allowed() {
  local groups="$1"
  local group
  for group in $groups; do
    if [[ "$group" != "65534" ]]; then
      return 1
    fi
  done
  return 0
}

if (($# != 3)); then
  echo "usage: protected-worker-isolation.sh <protected-base> <pr-source> <oci-image>" >&2
  exit 1
fi

protected_base="$(realpath "$1")"
pr_source="$(realpath "$2")"
oci_image="$3"
runner_temp="$(realpath "${RUNNER_TEMP:?RUNNER_TEMP is required}")"

case "$protected_base" in
  "$GITHUB_WORKSPACE" | "$GITHUB_WORKSPACE"/*) ;;
  *) echo "Protected base is outside GITHUB_WORKSPACE." >&2; exit 1 ;;
esac
case "$pr_source" in
  "$runner_temp"/*) ;;
  *) echo "PR source is outside RUNNER_TEMP." >&2; exit 1 ;;
esac
if [[ ! "$oci_image" =~ ^node@sha256:[0-9a-f]{64}$ ]]; then
  echo "OCI image is not digest pinned." >&2
  exit 1
fi

host_sentinel="$(mktemp "$runner_temp/agentsin-host-sentinel.XXXXXX")"
chmod 0600 "$host_sentinel"
printf 'host-only\n' > "$host_sentinel"
manifest=""
staging_container_id=""
staged_image_id=""
final_container_id=""

cleanup() {
  if [[ -n "$final_container_id" ]]; then
    docker rm --force "$final_container_id" >/dev/null 2>&1 || true
  fi
  if [[ -n "$staging_container_id" ]]; then
    docker rm --force "$staging_container_id" >/dev/null 2>&1 || true
  fi
  if [[ -n "$staged_image_id" ]]; then
    docker image rm --force "$staged_image_id" >/dev/null 2>&1 || true
  fi
  rm -f "$host_sentinel" "$manifest"
}
trap cleanup EXIT

staging_container_id="$(docker create \
  --entrypoint /bin/false \
  "$oci_image")"

assert_staging_inert() {
  require_equal \
    "created" \
    "$(docker inspect --format '{{.State.Status}}' "$staging_container_id")" \
    "staging container was not inert"
  require_equal \
    "false" \
    "$(docker inspect --format '{{.State.Running}}' "$staging_container_id")" \
    "staging container unexpectedly ran"
  require_equal \
    "null" \
    "$(docker inspect --format '{{json .HostConfig.Binds}}' "$staging_container_id")" \
    "staging container has bind mounts"
  require_equal \
    "0" \
    "$(docker inspect --format '{{len .Mounts}}' "$staging_container_id")" \
    "staging container has runtime mounts"
}
assert_staging_inert

manifest="$(mktemp "$runner_temp/agentsin-protected-manifest.XXXXXX")"
(
  cd "$protected_base/.github/scripts"
  sha256sum \
    protected-worker-container-entrypoint.sh \
    protected-worker-container-probe.mjs |
    sed 's#  #  /opt/aic/#'
) > "$manifest"
chmod 0444 "$manifest"

tar -C "$protected_base/.github/scripts" \
  --owner=0 \
  --group=0 \
  --mode='u+rwX,go+rX' \
  --transform 's#^#aic/#' \
  -cf - \
  protected-worker-container-entrypoint.sh \
  protected-worker-container-probe.mjs |
  docker cp - "$staging_container_id:/opt"
docker cp "$manifest" "$staging_container_id:/opt/aic/manifest.sha256"
rm -f "$manifest"
manifest=""

tar -C "$protected_base" \
  --owner=0 \
  --group=0 \
  --mode='u+rwX,go+rX' \
  --transform 's#^#base/#' \
  -cf - \
  node_modules \
  apps/worker/node_modules \
  packages/contracts/node_modules \
  packages/shared/node_modules |
  docker cp - "$staging_container_id:/opt"
tar -C "$pr_source" \
  --owner=0 \
  --group=0 \
  --mode='u+rwX,go+rX' \
  --transform 's#^\./#pr-source/#' \
  -cf - . |
  docker cp - "$staging_container_id:/opt"

assert_staging_inert
staged_image_id="$(docker commit "$staging_container_id")"
require_match \
  "$staged_image_id" \
  '^sha256:[0-9a-f]{64}$' \
  "staged image does not have a content-addressed identifier"
docker rm "$staging_container_id" >/dev/null
staging_container_id=""

final_container_id="$(docker create \
  --read-only \
  --network none \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --user 65534:65534 \
  --pids-limit 256 \
  --memory 4g \
  --cpus 2 \
  --ulimit nofile=1024:1024 \
  --ulimit nproc=256:256 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
  --tmpfs /work:rw,noexec,nosuid,nodev,size=4g,mode=1777 \
  --env HOME=/tmp \
  --env XDG_CACHE_HOME=/tmp/cache \
  --env CI=true \
  --entrypoint /bin/sh \
  "$staged_image_id" \
  /opt/aic/protected-worker-container-entrypoint.sh)"

docker start "$final_container_id" >/dev/null
ready_attempt=0
until docker exec --user 65534:65534 "$final_container_id" test -e /tmp/protected-ready; do
  ready_attempt=$((ready_attempt + 1))
  if [[ "$ready_attempt" -gt 120 ]] || [[ "$(docker inspect --format '{{.State.Running}}' "$final_container_id")" != "true" ]]; then
    docker logs "$final_container_id" >&2 || true
    echo "Protected container did not reach its base-owned observation gate." >&2
    exit 1
  fi
  sleep 0.25
done

require_equal \
  "65534:65534" \
  "$(docker inspect --format '{{.Config.User}}' "$final_container_id")" \
  "final container user is not 65534:65534"
require_equal \
  "true" \
  "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$final_container_id")" \
  "final container root filesystem is writable"
require_equal \
  "none" \
  "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$final_container_id")" \
  "final container network is enabled"
require_equal \
  '["ALL"]' \
  "$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$final_container_id")" \
  "final container capabilities were not all dropped"
require_equal \
  '["no-new-privileges:true"]' \
  "$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$final_container_id")" \
  "final container no-new-privileges is disabled"
if ! docker inspect "$final_container_id" | \
  /usr/bin/jq --exit-status --from-file \
    "$protected_base/.github/scripts/protected-worker-mounts.jq" >/dev/null; then
  fail_invariant "final container mount validation failed"
fi

container_pid="$(docker inspect --format '{{.State.Pid}}' "$final_container_id")"
require_match "$container_pid" '^[1-9][0-9]*$' "final container PID is invalid"
status="/proc/$container_pid/status"
require_equal \
  "65534:65534:65534:65534" \
  "$(awk '/^Uid:/{print $2 ":" $3 ":" $4 ":" $5}' "$status")" \
  "final container process has an unexpected UID"
require_equal \
  "65534:65534:65534:65534" \
  "$(awk '/^Gid:/{print $2 ":" $3 ":" $4 ":" $5}' "$status")" \
  "final container process has an unexpected GID"
if ! supplementary_groups="$(awk '
  /^Groups:/ {
    found = 1
    sub(/^Groups:[[:space:]]*/, "")
    print
  }
  END { exit found ? 0 : 1 }
' "$status")"; then
  fail_invariant "final container supplementary-group status is unavailable"
fi
if ! supplementary_groups_allowed "$supplementary_groups"; then
  fail_invariant "final container process has an unauthorized supplementary group"
fi
require_match \
  "$(awk '/^CapEff:/{print $2}' "$status")" \
  '^0+$' \
  "final container process has effective capabilities"
require_equal \
  "1" \
  "$(awk '/^NoNewPrivs:/{print $2}' "$status")" \
  "final container process does not enforce no-new-privileges"
for namespace in mnt net pid ipc uts; do
  if [[ "$(readlink "/proc/$container_pid/ns/$namespace")" == "$(readlink "/proc/self/ns/$namespace")" ]]; then
    fail_invariant "final container shares the host $namespace namespace"
  fi
done
if grep -Fq "$runner_temp" "/proc/$container_pid/mountinfo"; then
  echo "RUNNER_TEMP is visible in the protected container mounts." >&2
  exit 1
fi
if grep -Fq "$GITHUB_WORKSPACE" "/proc/$container_pid/mountinfo"; then
  echo "GITHUB_WORKSPACE is visible in the protected container mounts." >&2
  exit 1
fi

docker exec --user 65534:65534 "$final_container_id" \
  /usr/local/bin/node /opt/aic/protected-worker-container-probe.mjs "$host_sentinel"
docker exec --user 65534:65534 "$final_container_id" touch /tmp/protected-release

set +e
container_exit="$(timeout --foreground 10m docker wait "$final_container_id")"
wait_status=$?
set -e
if [[ "$wait_status" -ne 0 ]] || [[ "$container_exit" != "0" ]]; then
  docker logs "$final_container_id" >&2 || true
  echo "Protected PR build/test exited with ${container_exit:-timeout}." >&2
  exit 1
fi
require_equal \
  "0" \
  "$(docker inspect --format '{{.State.ExitCode}}' "$final_container_id")" \
  "final container inspection reported a nonzero exit"
docker logs "$final_container_id"
