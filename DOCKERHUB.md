# deepseek-harness (Docker Image)

Image (default): **`smanx/deepseek-harness:latest`** (Docker Hub)
Image (backup): **`ghcr.io/smanx/deepseek-harness:latest`** (GitHub Container Registry, GHCR; all tags are mirrored there)
Docker Hub project page: https://hub.docker.com/r/smanx/deepseek-harness
Github project page: https://github.com/smanx/deepseek-harness-docker


An out-of-the-box **DeepSeek Harness (DSH)** Docker image with a built-in Node reverse proxy. It solves the issue that DSH officially forbids `--host 0.0.0.0` (loopback-only listening) and makes DSH safely accessible over your LAN.

## Online Demo

- Demo URL: https://dsh.smanx.xx.kg
- Username / Password: `admin` / `admin`

> ⚠️ **Note:** This is a **public address**. If you fill in your own API key (e.g. DeepSeek), please be **very careful** — your key may be exposed.

## About the Project

- **DSH**: Installs the official npm package `@deepseek-ai/dsh` ([deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)) inside the container, listening on `127.0.0.1:3079` (source port) by default;
- **Node proxy**: `0.0.0.0:3080` (proxy port) → `127.0.0.1:3079`, providing HTTP + WebSocket forwarding to the outside;
- **Why a proxy is needed**:
  - DSH officially forbids `--host 0.0.0.0` (security restriction) and can only listen on the loopback address;
  - Pages loaded over a LAN IP are in a browser **non-secure context**, where the `crypto.randomUUID` used by the DSH frontend is unavailable. The proxy automatically injects a `getRandomValues`-based polyfill into served HTML; without it the realtime channel (WS) stays pending forever;
  - The proxy also provides optional **HTTP Basic Auth** to protect LAN access.

## Quick Start (pull & run)

```bash
# 1. Pull the image (default: Docker Hub)
docker pull smanx/deepseek-harness:latest

# 2. Run (defaults: proxy port 3080, data persisted to named volume dsh-data)
docker run -d \
  --name dsh-harness \
  -p 3080:3080 \
  -v dsh-data:/root/.dsh \
  --restart unless-stopped \
  smanx/deepseek-harness:latest

# 3. Access
#    Local machine: http://127.0.0.1:3080/
#    LAN:           http://<server-LAN-IP>:3080/
```

The WebSocket realtime channels (`/api/events.mux`, `/api/events.host`) are forwarded automatically by the proxy — no extra configuration needed.

### Differences between the tags

| Tag | Purpose | Included tools |
|---|---|---|
| `latest` | Slim runtime image | None (only Node runtime + DSH + reverse proxy) |
| `devtools-min-latest` | Minimal tools for common debugging | git, curl, wget, nano, jq, procps, ca-certificates, unzip; npm globals: pnpm; uv |
| `devtools-latest` | Full tools for developing/compiling inside the container | everything in Minimal + vim, openssh-client, zip, htop, tmux, tree, openssl, python3, build-essential (make/g++), bash-completion; npm globals: pnpm; uv |
| `admin-latest` | Admin variant: **latest DSH pre-installed**, works out of the box; admin page to pick/install/switch versions | same as Full Tools (pnpm, uv) + manager service; keeps python3/build-essential to compile node-pty at runtime |

> Each tag also has a matching **versioned tag**: `latest` ↔ `<version>`, `devtools-latest` ↔ `devtools-<version>`, `devtools-min-latest` ↔ `devtools-min-<version>`, `admin-latest` ↔ `admin-<version>` (admin pre-installs the latest DSH, so its version tag is the DSH version).

**A simple example:**

```bash
# Scenario 1: just run DSH in the browser with no debugging → use the slim `latest`
docker run -d \
  --name dsh-harness \
  -p 3080:3080 \
  -v dsh-data:/root/.dsh \
  --restart unless-stopped \
  smanx/deepseek-harness:latest

# Scenario 2: you need to get inside the container to troubleshoot
# (view logs, process JSON with jq, fetch things with wget) → use devtools-min-latest
docker run -d \
  --name dsh-harness \
  -p 3080:3080 \
  -v dsh-data:/root/.dsh \
  --restart unless-stopped \
  smanx/deepseek-harness:devtools-min-latest

# Scenario 3: develop/compile inside the container or do heavier ops
# (vim, python3, make, etc.) → use devtools-latest
docker run -d \
  --name dsh-harness \
  -p 3080:3080 \
  -v dsh-data:/root/.dsh \
  --restart unless-stopped \
  smanx/deepseek-harness:devtools-latest
```

The run command is identical across all three tags — only the image name (tag) changes. The tooled variants are a bit larger than the slim image, so pick what fits.

> The tooled variants (`devtools` / `devtools-min` / `test`) ship with **pnpm** (installed via npm globally). DSH's `dsh plugin` command relies on pnpm to manage plugins,
> and the community plugin market [dsh-market](https://github.com/dsh-market/dsh-market) (`dsh plugin --profile web add dshmarket`) needs it too.
> The slim `latest` does not bundle it — on first plugin use, dsh-market detects the missing pnpm and offers one-click automatic setup.
>
> They also ship **uv** (Python package manager, static binary, no system Python required). Many community MCP servers launch via
> `uvx` / `uv run` (commonly seen in DSH MCP client configs as `"command": "uvx"`) — without uv those MCPs cannot run.

#### Admin variant (latest DSH pre-installed)

The `admin` variant **pre-installs the latest DSH (@next)**. After the container starts, the manager service detects and starts DSH automatically, so `/` serves the DSH UI directly; visiting `/__admin/` opens the admin page, where you can:

- Browse available versions of `@deepseek-ai/dsh` (dist-tags like `latest`/`next` plus the full list) and **install / switch** versions, with live install logs;
- Configure the **npm registry (NPM_CONFIG_REGISTRY)** manually: the input field **auto-fills the default** (env `NPM_CONFIG_REGISTRY` or the official registry) and the **last-saved value**, and shows the effective value; you can restore the default or clear it with one click. Priority: **page config > env `NPM_CONFIG_REGISTRY` > default**;
- **Restart** DSH with one click. After install it starts automatically, and a floating "⚙ Admin" button stays in the bottom-right corner of the DSH page so you can always get back to the admin page.

```bash
# Admin variant: use two named volumes (dsh-data for DSH config/sessions, dsh-install for the
# installed DSH files and config state, so upgrades/registry survive container recreation)
docker run -d \
  --name dsh-harness \
  -p 3080:3080 \
  -v dsh-data:/root/.dsh \
  -v dsh-install:/opt/dsh \
  --restart unless-stopped \
  smanx/deepseek-harness:admin-latest
```

> The admin variant keeps `python3` + `build-essential` (node-pty has no Linux prebuilds, so installing other DSH versions from the page needs to compile the native module from source in-container), making the image a bit larger than the slim one.

### Backup Image (GHCR)

If pulling from Docker Hub is restricted (e.g. network issues), you can use the backup image (GitHub Container Registry; tags are identical to Docker Hub):

```bash
# Pull the image from GHCR
docker pull ghcr.io/smanx/deepseek-harness:latest

# Same run command as the default image — just swap the image name
docker run -d \
  --name dsh-harness \
  -p 3080:3080 \
  -v dsh-data:/root/.dsh \
  --restart unless-stopped \
  ghcr.io/smanx/deepseek-harness:latest
```

> The two images are identical in configuration and usage — only the registry differs, so they are interchangeable.

## Configuration (Environment Variables)

| Variable | Meaning | Default |
|---|---|---|
| `DSH_PORT` | Source port: where DSH listens inside the container (`127.0.0.1`) | `3079` |
| `PROXY_PORT` | Proxy port: where the proxy listens (LAN entry point) | `3080` |
| `PROXY_USERNAME` | Basic Auth username (optional) | unset |
| `PROXY_PASSWORD` | Basic Auth password (optional) | unset |
| `NPM_CONFIG_REGISTRY` | Default npm registry on the admin page (lower priority than the page config) | `https://registry.npmjs.org/` |
| `DSH_INSTALL_DIR` | DSH install directory in the admin variant (installed DSH and config state live here; mount a named volume) | `/opt/dsh` |

> `DSH_PORT` and `PROXY_PORT` must differ (a port can only be bound by one process).
> If you change `PROXY_PORT`, remember to update the port mapping accordingly: `-p <host-port>:<new-proxy-port>`.

### Enabling Basic Auth

```bash
docker run -d \
  --name dsh-harness \
  -p 3080:3080 \
  -v dsh-data:/root/.dsh \
  -e PROXY_USERNAME=yourname \
  -e PROXY_PASSWORD=yourpass \
  --restart unless-stopped \
  smanx/deepseek-harness:latest
```

- Auth is enabled **only when both** username and password are set; if either (or both) is missing, access is completely open;
- Auth applies to both HTTP and WebSocket. Unauthenticated requests get `401` + `WWW-Authenticate`, and the browser shows a credential prompt;
- Public static assets `/manifest.webmanifest`, `/favicon.svg`, and `/favicon.ico` are exempt from authentication (they contain only non-sensitive data such as the app name and icons). When the browser fetches `<link rel="manifest">` it does not send Basic Auth credentials, so if authentication were enforced there, the console would keep reporting `401` for `/manifest.webmanifest`.

### Changing the proxy port

```bash
# e.g. expose the proxy on port 3088
docker run -d \
  --name dsh-harness \
  -p 3088:3088 \
  -v dsh-data:/root/.dsh \
  -e PROXY_PORT=3088 \
  --restart unless-stopped \
  smanx/deepseek-harness:latest
```

## Data Persistence

DSH session/configuration data lives in `/root/.dsh` inside the container; the commands above persist it via the named volume `dsh-data`:

- Data survives `docker stop/start` and container removal;
- To wipe it completely: `docker volume rm dsh-data` (stop the container first).

## Stop / Restart / Remove

```bash
docker stop dsh-harness     # stop
docker start dsh-harness    # start again
docker logs -f dsh-harness  # view logs
docker rm -f dsh-harness    # remove the container (volume data is kept)
```

## Contact & Feedback

- Discussion & bug feedback: https://github.com/deepseek-ai/deepseek-harness/discussions/1762
