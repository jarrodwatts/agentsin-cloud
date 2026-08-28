#!/usr/bin/env bash
set -euo pipefail

readonly desktop_root="/run/agentsin/desktop"
readonly desktop_session="/opt/agentsin/desktop-session.sh"
readonly vnc_password_file="${desktop_root}/vnc.passwd"

test "$(id -u)" = "0"
test -x "${desktop_session}"
test "$(stat -c '%u:%g' "${desktop_root}")" = "11002:11002"
test "$(stat -c '%a' "${desktop_root}")" = "700"
test "$(stat -c '%u:%g' "${vnc_password_file}")" = "11002:11002"
test "$(stat -c '%a' "${vnc_password_file}")" = "600"

exec /usr/bin/setpriv \
  --reuid=11002 \
  --regid=11002 \
  --clear-groups \
  --no-new-privs \
  -- /usr/bin/env -i \
  HOME=/home/agentsin-inspector \
  PATH=/usr/local/bin:/usr/bin:/bin \
  "${desktop_session}"
