# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS toolchain
RUN corepack enable && corepack prepare pnpm@12.8.1 --activate
WORKDIR /src

FROM toolchain AS version-check
ARG APP_VERSION
# context 排除 Git，归档与 CI 必须显式提供完整提交号。
RUN node -e 'if (!/^[a-f0-9]{40}$/.test(process.argv[1] || "")) process.exit(1)' "$APP_VERSION"
RUN printf '%s' "$APP_VERSION" > /version

FROM toolchain AS source
COPY . .
RUN pnpm install --frozen-lockfile

FROM source AS build
COPY --from=version-check /version /version
# Debian 的 localhost 含 IPv4/IPv6；预渲染监听与 fetch 使用相同地址族。
RUN NODE_OPTIONS=--dns-result-order=ipv4first APP_VERSION="$(cat /version)" pnpm build:node
RUN pnpm --filter @saas/jobs deploy --legacy --prod /out/jobs
RUN pnpm --filter @saas/web deploy --legacy --prod /out/web

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
ENV NODE_ENV=production HOST=0.0.0.0
USER node
WORKDIR /app

FROM runtime AS web
ARG APP_VERSION
LABEL org.opencontainers.image.revision=$APP_VERSION
COPY --from=build --chown=node:node /out/web/node_modules/ ./node_modules/
COPY --from=build --chown=node:node /src/apps/web/.output/ ./
EXPOSE 3000
CMD ["node", "server/index.mjs"]

FROM runtime AS jobs
ARG APP_VERSION
LABEL org.opencontainers.image.revision=$APP_VERSION
COPY --from=build --chown=node:node /out/jobs/node_modules/ ./node_modules/
COPY --from=build --chown=node:node /src/apps/jobs/.output/ ./
ENV PORT=3001
EXPOSE 3001
CMD ["node", "server/index.mjs"]

# 迁移保留已锁定的 CLI、workspace TS 和 SQL，不接收应用/超级用户 secret。
FROM toolchain AS migrate
ARG APP_VERSION
LABEL org.opencontainers.image.revision=$APP_VERSION
COPY --from=source --chown=node:node /src/ /src/
COPY --from=version-check /version /version
USER node
CMD ["node", "deploy/selfhost/migrate.mjs"]

# 在同一 Debian/Node 运行层加载构建依赖自带的原生 .node，不加入生产依赖。
FROM runtime AS native-smoke
COPY --from=source /src/node_modules/.pnpm/ /native/
CMD ["node", "-e", "const fs=require('node:fs');const p=fs.readdirSync('/native').find(x=>x.startsWith('sharp@'));if(!p)throw Error('native module missing');require('/native/'+p+'/node_modules/sharp')({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer().then(()=>console.log('native sharp module loaded, uid='+process.getuid()))"]
