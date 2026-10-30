# DSH (DeepSeek Harness) requires Node.js; the official npm package @deepseek-ai/dsh has been verified to run on Node 24
# (officially built/verified with Node 24.19.0)
#
# Key point: the native module node-pty (terminal) that @deepseek-ai/dsh depends on ships only with
# prebuilt binaries for macOS/Windows in the npm package (prebuilds/ contains only darwin-arm64/darwin-x64/win32-arm64/win32-x64),
# there are no prebuilt binaries for Linux, so installation always falls back to node-gyp compiling from source, which needs
# python3 + make + g++. node:24-slim does not include these tools, so running `npm install -g @deepseek-ai/dsh`
# directly reports:
#   gyp ERR! find Python ... Could not find any Python installation to use
# Therefore a multi-stage build is used: DSH is installed in a stage that has the build tools (compiling node-pty along the way),
# then /usr/local (Node + DSH + build artifacts) is copied into the slim runtime image, which keeps no build tools.

# ── Stage 1: install DSH and compile native modules ────────────────────────────────
# The admin variant preinstalls the latest DSH (@next) into /opt/dsh (the manager service's install dir; auto-populated when an empty volume is mounted, works out of the box)
FROM node:24-slim AS dsh-builder
ARG DEV_TOOLS=none
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && if [ "$DEV_TOOLS" = "admin" ]; then \
         npm install -g --prefix /opt/dsh --no-audit --no-fund @deepseek-ai/dsh@next; \
       else \
         npm install -g --no-audit --no-fund @deepseek-ai/dsh@next; \
       fi \
    && mkdir -p /opt/dsh

# ── Stage 2: slim runtime image ───────────────────────────────────────────
FROM node:24-slim
WORKDIR /app

# Dev-tools variant switch: none (default, install nothing) | <tag prefix> (e.g. devtools / devtools-min)
# Enabled at build time via --build-arg DEV_TOOLS=<prefix>; the tools installed for each prefix are
# defined per prefix in the .build-variants file; edit that file directly to add or remove tools
ARG DEV_TOOLS=none

# Copy the Node runtime + DSH (including the compiled node-pty). Both stages use node:24-slim, so
# /usr/local contents are identical except for the npm-globally-installed @deepseek-ai/dsh
COPY --from=dsh-builder /usr/local/ /usr/local/

# admin variant: copy the preinstalled latest DSH from the build stage into the manager install dir /opt/dsh
# (Docker auto-populates the directory when an empty volume is first mounted; the manager detects it on startup and auto-launches DSH)
COPY --from=dsh-builder /opt/dsh/ /opt/dsh/

# Generate a version file so CI (docker-build/.github/workflows/projects.yml) can extract APP_VERSION via docker cp to tag images;
# if the file is missing, CI falls back to a date tag; the admin variant is preinstalled in /opt/dsh, other variants in /usr/local
RUN if [ "$DEV_TOOLS" = "admin" ]; then \
      node -p "'APP_VERSION=' + require('/opt/dsh/lib/node_modules/@deepseek-ai/dsh/package.json').version" > /tmp/app_version.env; \
    else \
      node -p "'APP_VERSION=' + require('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json').version" > /tmp/app_version.env; \
    fi

# Proxy code and its dependency (http-proxy)
COPY proxy/ /app/proxy/
RUN cd /app/proxy && npm install --omit=dev --no-audit --no-fund

# Manager service (admin variant only): install/switch DSH versions from the web page, configure the npm registry, supervise the DSH process and reverse-proxy it
COPY manager/ /app/manager/
RUN cd /app/manager && npm install --omit=dev --no-audit --no-fund

# Entrypoint script (default flow: start DSH first, wait until ready, then start the proxy)
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# admin variant marker: when /app/.admin-mode exists in the image, entrypoint.sh switches to the manager service
# (latest DSH preinstalled; the admin console can still install/switch versions and configure the npm registry)
RUN if [ "$DEV_TOOLS" = "admin" ]; then touch /app/.admin-mode; fi

# ── Dev tools (tool list read from .build-variants by DEV_TOOLS prefix and installed) ──
# Each .build-variants line: <tag prefix>|<apt tool list>|<npm global package list (may be empty)>|<uv install flag (1=install/empty=skip)>; DEV_TOOLS takes the prefix value from column 1
# The base image (DEV_TOOLS=none) installs no tools
COPY .build-variants /app/.build-variants
RUN if [ -n "$DEV_TOOLS" ] && [ "$DEV_TOOLS" != "none" ]; then \
      PACKAGES="$(awk -F'|' -v p="$DEV_TOOLS" '$1==p {print $2}' /app/.build-variants)"; \
      NPM_PKGS="$(awk -F'|' -v p="$DEV_TOOLS" '$1==p {print $3}' /app/.build-variants)"; \
      UV_FLAG="$(awk -F'|' -v p="$DEV_TOOLS" '$1==p {print $4}' /app/.build-variants)"; \
      if [ -n "$PACKAGES" ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends $PACKAGES \
        && rm -rf /var/lib/apt/lists/*; \
      fi; \
      if [ -n "$NPM_PKGS" ]; then \
        npm install -g --no-audit --no-fund $NPM_PKGS; \
      fi; \
      if [ "$UV_FLAG" = "1" ]; then \
        curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh; \
      fi; \
    fi

# ── Special test tag (DEV_TOOLS=test): install extra plugins after DSH is installed ────────
RUN if [ "$DEV_TOOLS" = "test" ]; then \
      dsh plugin --profile web add github:smanx/dsh-fixed-providers#master; \
    fi

# Tools for docker install
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
            ca-certificates \
            curl \
            gnupg \
    && rm -rf /var/lib/apt/lists/*


# Add Docker's official GPG key and repository
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list

# Install only the Docker CLI
RUN apt-get update && apt-get install -y \
    docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

#add node to docker groups
#ARG DOCKER_GID=138
#RUN groupadd -g ${DOCKER_GID} docker
#RUN usermod -aG docker node


# Exposed port: the proxy/manager both listen on 3080 by default (DSH listens on 127.0.0.1:<DSH_PORT> inside the container and is not exposed directly)
EXPOSE 3080

ENTRYPOINT ["/app/entrypoint.sh"]
