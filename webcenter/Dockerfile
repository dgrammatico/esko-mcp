# Remote (HTTP) edition of the Esko WebCenter MCP server, for Azure Container Apps or any container host.
# Build:  docker build -t esko-webcenter-mcp ./webcenter
# Run:    docker run -p 8080:8080 -e WEBCENTER_BASE_URL=mock -e MCP_AUTH_MODE=service -e MCP_API_KEY=... esko-webcenter-mcp

# Official Node.js image. Override with --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-alpine (a mirror) if Docker Hub rate-limits you.
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY mock ./mock
RUN npm run build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
COPY --from=build /src/server/http.js ./http.js
USER node
EXPOSE 8080
CMD ["node", "http.js"]
