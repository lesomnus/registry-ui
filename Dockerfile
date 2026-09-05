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

# The alpine variant rather than the scratch one, because the entrypoint needs a
# shell to turn the environment into config.json. That is the only reason; the
# server is the same binary.
FROM joseluisq/static-web-server:2.44.0-alpine

# Owned by the uid the image runs as, so the entrypoint can write config.json
# into it at startup.
COPY --from=build --chown=1000:1000 /src/dist /public
COPY --chown=1000:1000 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# No fallback page, on purpose, and it is worth saying why: SWS has one
# (`--page-fallback`, `SERVER_FALLBACK_PAGE`) and turning it on breaks this
# build rather than helping it.
#
# The app is built with a relative asset base so one image serves from any mount
# point. At `/some/route`, `./assets/app.js` resolves to `/some/route/assets/...`
# -- which the fallback answers with index.html and a 200. A module script
# arriving as text/html does not run, and `config.json` arriving as text/html
# takes this deployment's own settings with it. Every one of those is a 200, so
# nothing says a word.
#
# Nothing needs it: the app's routes live in the fragment, which never reaches a
# server. See src/route.ts. A path that is not here is a 404, which is what it
# is.
ENV SERVER_ROOT=/public \
    SERVER_PORT=8080 \
    SERVER_COMPRESSION=true \
    SERVER_HEALTH=true
EXPOSE 8080

# What the page starts pointed at. All optional; unset means an empty form.
#   REGISTRY_DOMAIN     e.g. registry.example, or localhost:5000
#   REGISTRY_FORWARDER  where the forwarder is, if it is not this origin
#   REGISTRY_INSECURE   "true" for a registry with no TLS
#   REGISTRY_DIRECT     "true" for a registry that sends CORS headers
#   REGISTRY_LOCKED     "true" to fix the connection: no box to type another
#                       registry into. Presentation, not enforcement -- see the
#                       README.
#   REGISTRY_ANONYMOUS  "true" to drop the credential fields as well
#   REGISTRY_LOGO       an image for the corner: a URL, a `data:` URI, or a path
#                       to something mounted alongside the page
#   REGISTRY_TITLE      what to call this deployment, beside the logo and in the
#                       browser tab
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
