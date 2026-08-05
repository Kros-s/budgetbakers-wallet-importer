# BudgetBakers wallet importer — batch runner + optional Telegram bot.
# The pipeline shells out to the Claude Code CLI, which is installed in-image;
# auth comes from CLAUDE_CODE_OAUTH_TOKEN (create it once with `claude setup-token`).

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    TZ=America/Mexico_City

RUN corepack enable \
 && npm install -g @anthropic-ai/claude-code \
 && apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist

# State lives in /app/data (bind mount). Secrets in /app/.env.local (bind mount).
VOLUME ["/app/data"]

# One-shot by default: the batch run. Override args for --remind, --dry-run, etc.
ENTRYPOINT ["node", "dist/cli/process-window.js"]
