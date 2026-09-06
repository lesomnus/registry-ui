# Two images, because they are two different things -- see the README.
#
#   page    the page alone, behind static-web-server. No runtime, nothing held,
#           and correct for a registry that sends CORS headers.
#   server  the page and the forwarder, one Go binary. For a registry that does
#           not, where the page cannot reach it and something has to ask.
#
# `docker buildx bake` builds both. Neither is a stage of the other and neither
# is optional: which one a deployment wants is decided by the registry it is
# pointed at, not by this file.

variable "TAG" {
  default = "local"
}

variable "REPO" {
  # A user or organisation has to be in here. GHCR answers a path without one
  # with `400 Bad Request` on a blob HEAD, which says nothing about the missing
  # segment that caused it.
  default = "ghcr.io/lesomnus/registry-ui"
}

variable "BUILD_HASH" {
  default = "0000000000000000000000000000000000000000"
}

variable "BUILD_TIMESTAMP" {
  default = "${timestamp()}"
}

variable "BUILD_DATE" {
  default = "${formatdate("YYMMDD", BUILD_TIMESTAMP)}"
}

variable "BUILD_ID" {
  default = "r0"
}

variable "APP_VERSION" {
  default = "${BUILD_DATE}-${BUILD_ID}"
}

variable "PLATFORMS" {
  # arm64 because the fleet is arm64. Both stages of both images build on the
  # builder's own architecture and cross-compile, so the second platform is
  # a second link rather than a second run under emulation.
  default = ["linux/amd64", "linux/arm64"]
}

# What both images say about themselves.
#
# `source` is the one that is not decoration: GHCR reads it to attach the
# package to this repository, and without it the package is an orphan with no
# README and no link back.
target "_common" {
  platforms = PLATFORMS
  labels = {
    "org.opencontainers.image.source"      = "https://github.com/lesomnus/registry-ui"
    "org.opencontainers.image.url"         = "https://lesomnus.github.io/registry-ui/"
    "org.opencontainers.image.licenses"    = "Apache-2.0"
    "org.opencontainers.image.revision"    = "${BUILD_HASH}"
    "org.opencontainers.image.version"     = "${APP_VERSION}"
    "org.opencontainers.image.created"     = "${BUILD_TIMESTAMP}"
  }
}

# Four tags for one build, which is three more than a `docker push` gives you
# and each answers a different question.
#
#   :edge            what CI last pushed from main -- moves, and is the one a
#                    development deployment follows
#   :r<run>          which build this was, and nothing else has that number
#   :YYMMDD          the last build of that day, for saying "the one from
#                    Tuesday" without looking a run id up
#   :YYMMDD-r<run>   both, and the only one of the four that never moves --
#                    which is what a deployment that is meant to stay put pins
function "tags" {
  params = [name]
  result = [
    "${name}:${TAG}",
    "${name}:${BUILD_ID}",
    "${name}:${BUILD_DATE}",
    "${name}:${BUILD_DATE}-${BUILD_ID}",
  ]
}

target "page" {
  inherits   = ["_common"]
  dockerfile = "Dockerfile"
  tags       = tags(REPO)
  labels = {
    "org.opencontainers.image.title"       = "registry-ui"
    "org.opencontainers.image.description" = "A browser for any OCI registry that sends CORS headers"
  }
}

target "server" {
  inherits   = ["_common"]
  dockerfile = "Dockerfile.server"
  # Nested under the page rather than beside it: they are two artifacts of one
  # project, and `registry-ui-server` at the top level reads as a second one.
  tags = tags("${REPO}/server")
  labels = {
    "org.opencontainers.image.title"       = "registry-ui server"
    "org.opencontainers.image.description" = "The page, and a forwarder for a registry the browser cannot reach"
  }
}

group "default" {
  targets = ["page", "server"]
}
