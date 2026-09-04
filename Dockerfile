# The page, as static files behind static-web-server.
#
# SWS does not reverse proxy and is not going to
# (static-web-server/static-web-server#489), so the forwarder is not in here.
# That is the trade this image makes: it serves a page and nothing else, which
# is why it is a few megabytes and has no runtime.
#
# The page then needs either a registry that sends CORS headers -- tick
# "direct" -- or a forwarder somewhere it can reach, whose URL is typed into the
# page. See Dockerfile.forwarder and compose.yaml.

FROM node:24-alpine AS build
WORKDIR /src

# The lockfile pins oci-client to a commit; `npm ci` honours that, and the
# package builds itself through its `prepare` on install.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

FROM joseluisq/static-web-server:2.44.0
COPY --from=build /src/dist /public

# `page-fallback` is what makes a reload of any path land on the app rather than
# on a 404. There are no routes yet, and there is no reason to notice the day
# there are.
ENV SERVER_ROOT=/public \
    SERVER_PORT=8080 \
    SERVER_PAGE_FALLBACK=/public/index.html \
    SERVER_COMPRESSION=true \
    SERVER_HEALTH=true
EXPOSE 8080
