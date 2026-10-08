# Builds one backend service: apps/api or apps/worker.
#   docker build -f infra/docker/node-service.Dockerfile --build-arg APP=api    -t companybrain-api .
#   docker build -f infra/docker/node-service.Dockerfile --build-arg APP=worker -t companybrain-worker .
# Runtime config comes from env vars (DATABASE_PASSWORD, ANTHROPIC_API_KEY, ...), never from a baked .env.
# On AWS set COMPANY_BRAIN_AWS_PROFILE="" so the task role is used (the account is still verified).

ARG APP=api

FROM node:22-slim AS build
ARG APP
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/${APP}/package.json apps/${APP}/
RUN npm ci --include-workspace-root -w @companybrain/core -w @companybrain/${APP}
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/${APP} apps/${APP}
RUN npm run build -w @companybrain/${APP}

FROM node:22-slim
ARG APP
ENV NODE_ENV=production COMPANY_BRAIN_AWS_PROFILE="" API_HOST=0.0.0.0
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/${APP}/package.json apps/${APP}/
RUN npm ci --omit=dev -w @companybrain/core -w @companybrain/${APP} && npm cache clean --force
COPY --from=build /repo/apps/${APP}/dist apps/${APP}/dist
WORKDIR /repo/apps/${APP}
USER node
CMD ["npm", "start"]
