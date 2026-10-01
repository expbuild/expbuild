FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/admin-api/package.json apps/admin-api/package.json
COPY apps/admin-web/package.json apps/admin-web/package.json
RUN npm ci
COPY apps/admin-api apps/admin-api
RUN npm run build --workspace @expbuild/admin-api && npm prune --omit=dev

FROM node:24.21.0-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/admin-api/package.json ./apps/admin-api/package.json
COPY --from=build --chown=node:node /app/apps/admin-api/dist ./apps/admin-api/dist
COPY --from=build --chown=node:node /app/apps/admin-api/migrations ./apps/admin-api/migrations
USER node
EXPOSE 3001
CMD ["node", "apps/admin-api/dist/main.js"]
