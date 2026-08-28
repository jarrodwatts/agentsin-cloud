#!/usr/bin/env bash
set -euo pipefail

readonly worker_root="/opt/agentsin/worker"
readonly provider_root="/opt/agentsin/provider"
readonly provider_module="${provider_root}/provider-service.mjs"
readonly provider_digest_file="${provider_root}/provider-service.sha256"
readonly runtime_child="${worker_root}/ProviderRuntimeChild.mjs"
readonly bootstrap_ref="${1:-}"

case "${bootstrap_ref}" in
  /run/agentsin/bootstrap/*) ;;
  *)
    echo "A sealed bootstrap reference under /run/agentsin/bootstrap is required." >&2
    exit 64
    ;;
esac

test -f "${bootstrap_ref}"
test -f "${provider_module}"
test -f "${provider_digest_file}"
test "$(stat -c '%u' "${provider_root}")" = "0"
test "$(stat -c '%a' "${provider_root}")" = "755"
test "$(stat -c '%u' "${provider_module}")" = "0"
test "$(stat -c '%a' "${provider_module}")" = "555"
test "$(stat -c '%u' "${provider_digest_file}")" = "0"
test "$(stat -c '%a' "${provider_digest_file}")" = "444"

cd "${worker_root}"
sha256sum --check --strict SHA256SUMS

readonly provider_sha256="$(awk 'NR == 1 { print $1 }' "${provider_digest_file}")"
[[ "${provider_sha256}" =~ ^[0-9a-f]{64}$ ]]
printf '%s  %s\n' "${provider_sha256}" "${provider_module}" | sha256sum --check --strict -

readonly node_path="$(command -v node)"
readonly node_sha256="$(sha256sum "${node_path}" | awk '{ print $1 }')"
readonly runtime_child_sha256="$(sha256sum "${runtime_child}" | awk '{ print $1 }')"

export AGENTSIN_WORKER_MODE="hosted"
export AGENTSIN_WORKER_BOOTSTRAP_FILE="${bootstrap_ref}"
export AGENTSIN_WORKER_MTLS_DIRECTORY="/run/agentsin/mtls"
export AGENTSIN_WORKER_PROVIDER_CREDENTIAL_ROOT="/run/agentsin/provider-credentials"
export AGENTSIN_AGENT_UID="11001"
export AGENTSIN_AGENT_GID="11001"
export AGENTSIN_INSPECTOR_UID="11002"
export AGENTSIN_INSPECTOR_GID="11002"
export AGENTSIN_PROVIDER_RUNTIME_MODULE="${provider_module}"
export AGENTSIN_PROVIDER_RUNTIME_SHA256="${provider_sha256}"
export AGENTSIN_PROVIDER_RUNTIME_CHILD_MODULE="${runtime_child}"
export AGENTSIN_PROVIDER_RUNTIME_CHILD_SHA256="${runtime_child_sha256}"
export AGENTSIN_NODE_INTERPRETER_PATH="${node_path}"
export AGENTSIN_NODE_INTERPRETER_SHA256="${node_sha256}"
export AGENTSIN_AGENT_HOME="/home/agentsin-agent"
export AGENTSIN_AGENT_PATH="/usr/local/bin:/usr/bin:/bin"

exec "${node_path}" "${worker_root}/entrypoint.mjs"
