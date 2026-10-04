FROM node:24-slim
LABEL org.opencontainers.image.source="https://github.com/ChrissyAFK/Solpouch" \
      org.opencontainers.image.description="Solpouch backend API"
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/
COPY packages/shared/package.json packages/shared/
# bufferutil/utf-8-validate have no arm64 prebuilds, so node-gyp compiles them; the tools go away in the same layer.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && pnpm install --frozen-lockfile --filter "@solpouch/backend..." \
 && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY tsconfig.base.json tsconfig.json ./
COPY apps/backend apps/backend
COPY packages/shared packages/shared
RUN chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=8787 BACKEND_PORT=8787
WORKDIR /app/apps/backend
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BACKEND_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "start"]
