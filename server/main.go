// Command server serves the page, and forwards what the page cannot fetch
// itself.
//
// A registry answers `fetch` from a browser only if it sends
// `Access-Control-Allow-Origin`. zot does; Docker Hub, ghcr.io and the Worker
// in front of registry.hday.io do not -- the last one 401s the preflight, which
// a browser sends without credentials, so no token a person could hold would
// help. For those, the page asks here and this asks the registry.
//
// # One process, one origin
//
// It serves the page as well, which is not tidiness. If SSO sits in front of
// the page and the forwarder is a second deployment on a second port, then a
// process holding a registry credential is reachable without going through the
// SSO. One origin is one thing to put the SSO in front of.
//
// # Two shapes, and REGISTRY_UPSTREAM is the switch
//
// Without it: a forwarder for whatever the page asks for, holding nothing. The
// page carries the credential, and running this grants nobody anything they
// could not get by making the request themselves.
//
// With it: pinned to one registry, and allowed to hold the credential for it.
// See config.go, which will not start in a combination that is neither.
package main

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	config, err := Load()
	if err != nil {
		log.Fatalf("registry-ui: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle(forwardPath, NewForwarder(config))
	mux.HandleFunc("/-/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/config.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json; charset=utf-8")
		w.Header().Set("cache-control", "no-store")
		_, _ = w.Write(config.PageJSON())
	})
	mux.Handle("/", page(config.PageRoot))

	address := fmt.Sprintf(":%d", config.Port)
	log.Printf("registry-ui on http://localhost%s", address)
	if config.Upstream != nil {
		log.Printf("forwarding to %s only, as %s", config.Upstream, config.Credential.Describe())
	} else {
		log.Printf("forwarding to whatever is asked for, holding no credential")
		if config.AllowPrivate {
			log.Printf("including private addresses")
		}
	}

	if err := http.ListenAndServe(address, mux); err != nil {
		log.Fatalf("registry-ui: %v", err)
	}
}

// page serves what vite built.
//
// Not a single-page fallback: the app's routes live in the fragment, which
// never reaches a server, and answering an unknown path with index.html would
// hand a module script to a browser as text/html. A path that is not here is a
// 404, which is what it is.
func page(root string) http.Handler {
	files := http.FileServer(http.Dir(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// http.Dir already refuses to escape the root; this refuses earlier so
		// the reason is in one place.
		clean := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if clean == ".." || strings.HasPrefix(clean, "../") {
			http.NotFound(w, r)
			return
		}

		if _, err := os.Stat(filepath.Join(root, "index.html")); errors.Is(err, os.ErrNotExist) {
			http.Error(w, "the page is not here: build it, or point PAGE_ROOT at it\n", http.StatusNotFound)
			return
		}

		files.ServeHTTP(w, r)
	})
}
