#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/bin:/bin

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
container_id=""

cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm --force "$container_id" >/dev/null 2>&1 || true
  fi
  rm -f "$host_sentinel"
}
trap cleanup EXIT

container_id="$(docker create \
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
  "$oci_image" \
  /opt/aic/protected-worker-container-entrypoint.sh)"

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
  docker cp - "$container_id:/opt"
docker cp "$manifest" "$container_id:/opt/aic/manifest.sha256"
rm -f "$manifest"

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
  docker cp - "$container_id:/opt"
tar -C "$pr_source" \
  --owner=0 \
  --group=0 \
  --mode='u+rwX,go+rX' \
  --transform 's#^\./#pr-source/#' \
  -cf - . |
  docker cp - "$container_id:/opt"

docker start "$container_id" >/dev/null
ready_attempt=0
until docker exec --user 65534:65534 "$container_id" test -e /tmp/protected-ready; do
  ready_attempt=$((ready_attempt + 1))
  if [[ "$ready_attempt" -gt 120 ]] || [[ "$(docker inspect --format '{{.State.Running}}' "$container_id")" != "true" ]]; then
    docker logs "$container_id" >&2 || true
    echo "Protected container did not reach its base-owned observation gate." >&2
    exit 1
  fi
  sleep 0.25
done

[[ "$(docker inspect --format '{{.Config.User}}' "$container_id")" == "65534:65534" ]]
[[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container_id")" == "true" ]]
[[ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container_id")" == "none" ]]
[[ "$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$container_id")" == '["ALL"]' ]]
[[ "$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$container_id")" == '["no-new-privileges:true"]' ]]
[[ "$(docker inspect --format '{{json .HostConfig.Binds}}' "$container_id")" == "null" ]]
[[ "$(docker inspect --format '{{len .Mounts}}' "$container_id")" == "0" ]]

container_pid="$(docker inspect --format '{{.State.Pid}}' "$container_id")"
[[ "$container_pid" =~ ^[1-9][0-9]*$ ]]
status="/proc/$container_pid/status"
[[ "$(awk '/^Uid:/{print $2 ":" $3 ":" $4 ":" $5}' "$status")" == "65534:65534:65534:65534" ]]
[[ "$(awk '/^Gid:/{print $2 ":" $3 ":" $4 ":" $5}' "$status")" == "65534:65534:65534:65534" ]]
[[ "$(awk '/^Groups:/{sub(/^Groups:[[:space:]]*/, ""); print}' "$status")" == "65534" ]]
[[ "$(awk '/^CapEff:/{print $2}' "$status")" =~ ^0+$ ]]
[[ "$(awk '/^NoNewPrivs:/{print $2}' "$status")" == "1" ]]
[[ "$(readlink "/proc/$container_pid/ns/mnt")" != "$(readlink /proc/self/ns/mnt)" ]]
[[ "$(readlink "/proc/$container_pid/ns/net")" != "$(readlink /proc/self/ns/net)" ]]
[[ "$(readlink "/proc/$container_pid/ns/pid")" != "$(readlink /proc/self/ns/pid)" ]]
[[ "$(readlink "/proc/$container_pid/ns/ipc")" != "$(readlink /proc/self/ns/ipc)" ]]
[[ "$(readlink "/proc/$container_pid/ns/uts")" != "$(readlink /proc/self/ns/uts)" ]]
if grep -Fq "$runner_temp" "/proc/$container_pid/mountinfo"; then
  echo "RUNNER_TEMP is visible in the protected container mounts." >&2
  exit 1
fi
if grep -Fq "$GITHUB_WORKSPACE" "/proc/$container_pid/mountinfo"; then
  echo "GITHUB_WORKSPACE is visible in the protected container mounts." >&2
  exit 1
fi

docker exec --user 65534:65534 "$container_id" \
  /usr/local/bin/node /opt/aic/protected-worker-container-probe.mjs "$host_sentinel"
docker exec --user 65534:65534 "$container_id" touch /tmp/protected-release

set +e
container_exit="$(timeout --foreground 10m docker wait "$container_id")"
wait_status=$?
set -e
if [[ "$wait_status" -ne 0 ]] || [[ "$container_exit" != "0" ]]; then
  docker logs "$container_id" >&2 || true
  echo "Protected PR build/test exited with ${container_exit:-timeout}." >&2
  exit 1
fi
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$container_id")" == "0" ]]
docker logs "$container_id"
