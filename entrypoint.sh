#!/bin/sh
set -e

# admin variant: when the /app/.admin-mode marker exists in the image, the manager service takes over
# (the manager handles: installing/switching DSH versions from the web page, configuring the npm registry, supervising the DSH process and reverse-proxying it;
#   when no DSH is installed, visiting / redirects to the admin page automatically)
if [ -f /app/.admin-mode ]; then
  echo "[admin] Detected admin variant, starting DSH manager service ..."
  exec node /app/manager/index.js
fi

# Port configuration (both can be overridden via environment variables)
#   DSH_PORT    source port (DSH listens on 127.0.0.1 inside the container), default 3079
#   PROXY_PORT  proxy port (the proxy's public listener), default 3080 (must differ from DSH_PORT)
DSH_PORT="${DSH_PORT:-3079}"
PROXY_PORT="${PROXY_PORT:-3080}"

# ── 1. Start DSH (listens on 127.0.0.1:3080 by default) ────────────────────────────
# DSH output must also be written to /app/.dsh-web.log: the proxy's upstream-token.js reads that file
# to recover the launch token (used to re-issue it for a session cookie on a 401 at the root path). Redirect straight to the file
# (written immediately, no pipe buffering delay), then tail -f forwards it to the container output to stay visible.
# Note: do not use a `| tee` pipe -- $! would then capture tee's PID and cleanup would kill the wrong process.
echo "[dsh] Starting DSH (dsh web --port $DSH_PORT) ..."
dsh web --no-open --port "$DSH_PORT" > /app/.dsh-web.log 2>&1 &
DSH_PID=$!
tail -f /app/.dsh-web.log &

# ── 2. Wait for DSH to be ready (up to 120 seconds) ─────────────────────────────────
echo "[dsh] Waiting for DSH to be ready (127.0.0.1:$DSH_PORT) ..."
ready=0
i=0
while [ "$i" -lt 120 ]; do
  if node -e "fetch('http://127.0.0.1:$DSH_PORT/').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$DSH_PID" 2>/dev/null; then
    echo "[dsh] Error: DSH process has exited"
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$ready" != "1" ]; then
  echo "[dsh] Error: DSH not ready within 120 seconds"
  exit 1
fi
echo "[dsh] DSH ready (pid $DSH_PID)"

# ── 3. Shut DSH down as well when the container stops ──────────────────────────────
cleanup() {
  echo "[proxy] Received exit signal, stopping DSH ..."
  kill "$DSH_PID" 2>/dev/null || true
  wait "$DSH_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── 4. Start the proxy (foreground, keeps the container alive) ──────────────────────
echo "[proxy] Starting proxy: 0.0.0.0:$PROXY_PORT -> 127.0.0.1:$DSH_PORT"
cd /app/proxy
exec node index.js
