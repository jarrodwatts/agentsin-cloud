#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:0}"

Xvfb "$DISPLAY" -ac -screen 0 1440x1024x24 -nolisten tcp &
for _ in $(seq 1 50); do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  sleep 0.1
done
startxfce4 &
sleep 2
x11vnc -bg -display "$DISPLAY" -forever -shared -rfbport 5900 -nopw -noxdamage -repeat
/usr/share/novnc/utils/novnc_proxy \
  --vnc localhost:5900 \
  --listen 6080 \
  --web /usr/share/novnc \
  --heartbeat 30 &

wait
