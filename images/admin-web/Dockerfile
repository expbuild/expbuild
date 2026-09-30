FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/admin-api/package.json apps/admin-api/package.json
COPY apps/admin-web/package.json apps/admin-web/package.json
RUN npm ci
COPY apps/admin-web apps/admin-web
RUN npm run build --workspace @expbuild/admin-web

FROM nginx:1.28-alpine
COPY images/admin-web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/apps/admin-web/dist /usr/share/nginx/html
USER 101:101
EXPOSE 8080
ENTRYPOINT ["nginx", "-g", "daemon off;"]
