#!/bin/sh
# Writes what the page should start pointed at, then hands over to the server.
#
# A static build has no configuration of its own, and baking one in would mean an
# image per registry. So the environment is turned into a file the page fetches
# on load. It is written on every start, so changing the variable and restarting
# is the whole of changing it.
#
# There is deliberately no variable for a password. A credential in a container's
# environment is a credential in `docker inspect`, in the orchestrator's API and
# in anything that reads either; the page asks for one instead.

set -eu

config="${SERVER_ROOT:-/public}/config.json"

# JSON is not shell, and a registry name with a quote in it is not a reason to
# emit a broken file.
escape() {
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037'
}

entries=""
add_string() {
	[ -n "$2" ] || return 0
	[ -z "$entries" ] || entries="$entries,"
	entries="$entries\"$1\":\"$(escape "$2")\""
}
add_bool() {
	case "$2" in
	true | TRUE | 1 | yes) ;;
	*) return 0 ;;
	esac
	[ -z "$entries" ] || entries="$entries,"
	entries="$entries\"$1\":true"
}

add_string domain "${REGISTRY_DOMAIN:-}"
add_string forwarder "${REGISTRY_FORWARDER:-}"
add_bool insecure "${REGISTRY_INSECURE:-}"
add_bool direct "${REGISTRY_DIRECT:-}"

# `direct` defaults to on in the page, so there is nothing to write for the
# usual case. Turning it *off* has to be written down, which a plain "true"
# check cannot express.
case "${REGISTRY_DIRECT:-}" in
false | FALSE | 0 | no)
	[ -z "$entries" ] || entries="$entries,"
	entries="$entries\"direct\":false"
	;;
esac

printf '{%s}\n' "$entries" >"$config"

if [ -n "$entries" ]; then
	echo "registry-ui: $(cat "$config")"
fi

exec /usr/local/bin/static-web-server "$@"
