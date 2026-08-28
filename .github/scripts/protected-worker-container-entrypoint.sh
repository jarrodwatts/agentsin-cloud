#!/bin/sh
set -eu
PATH=/usr/local/bin:/usr/bin:/bin
export PATH

/usr/bin/sha256sum --check /opt/aic/manifest.sha256
/usr/local/bin/node /opt/aic/protected-worker-container-probe.mjs /host/never-present
: > /tmp/protected-ready

release_attempt=0
while ! test -e /tmp/protected-release; do
  release_attempt=$((release_attempt + 1))
  if test "$release_attempt" -gt 240; then
    echo "Host isolation observer did not release the protected container." >&2
    exit 1
  fi
  sleep 0.25
done

mkdir -p /work/source
cp -R --no-preserve=ownership,mode /opt/pr-source/. /work/source/
rm -rf /work/source/node_modules \
  /work/source/apps/worker/node_modules \
  /work/source/packages/contracts/node_modules \
  /work/source/packages/shared/node_modules
ln -s /opt/base/node_modules /work/source/node_modules
cp -RP /opt/base/apps/worker/node_modules /work/source/apps/worker/node_modules
cp -RP /opt/base/packages/contracts/node_modules /work/source/packages/contracts/node_modules
cp -RP /opt/base/packages/shared/node_modules /work/source/packages/shared/node_modules

cd /work/source
./node_modules/.bin/vp run --filter @agentsin-cloud/worker build
./node_modules/.bin/vp run --filter @agentsin-cloud/worker typecheck
./node_modules/.bin/vp test run \
  apps/worker/src/ProviderCredentialExecutor.test.ts \
  apps/worker/src/ProviderRuntimeSupervisor.test.ts \
  apps/worker/src/ContainedWorkspace.test.ts \
  apps/worker/src/InspectorPtySandbox.test.ts \
  apps/worker/src/main.test.ts
