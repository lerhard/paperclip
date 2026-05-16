# syntax=docker/dockerfile:1.20
FROM node:22-bookworm-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /paperclip node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/adapters/openrouter/package.json packages/adapters/openrouter/
COPY packages/adapters/deepseek-local/package.json packages/adapters/deepseek-local/
COPY packages/adapters/kimi-local/package.json packages/adapters/kimi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
# COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY patches/ patches/

RUN pnpm install --frozen-lockfile \
  && pnpm store prune \
  && npm cache clean --force

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/shared build
RUN pnpm --filter @paperclipai/adapter-utils build
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
# Build all adapters (includes OpenRouter, Codex, etc.)
RUN pnpm --filter './packages/adapters/*' build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)
# Verify OpenRouter adapter was built
RUN test -f packages/adapters/openrouter/dist/index.js || (echo "WARNING: OpenRouter adapter build output missing" && exit 0)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
# Strip devDependencies and build artifacts from all packages
RUN pnpm prune --prod \
  && pnpm store prune \
  && npm cache clean --force \
  && find /app -type d \( -name '.turbo' -o -name '.vite' -o -name 'tsconfig.tsbuildinfo' \) -exec rm -rf {} + 2>/dev/null || true \
  && rm -rf /app/**/node_modules/.cache /app/**/node_modules/.pnpm /app/**/node_modules/.modules.yaml

# Install .NET SDK 8 + 9, Java JDK 17 (includes JRE), and lightweight developer utilities
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl wget gnupg \
  && wget -qO- https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/microsoft-archive-keyring.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" > /etc/apt/sources.list.d/microsoft-prod.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    dotnet-sdk-8.0 \
    dotnet-sdk-9.0 \
    openjdk-17-jdk \
    openssh-client \
    jq \
    build-essential \
    cmake \
    unzip \
    zip \
    tree \
    vim-tiny \
    nano \
    sqlite3 \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/share/man /usr/share/doc /usr/share/info \
  && rm -rf /tmp/* /var/tmp/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai @google/gemini-cli \
  && npm cache clean --force \
  && rm -rf /root/.npm/_cacache /usr/local/lib/node_modules/.cache

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true

VOLUME ["/paperclip"]
EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
