package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// forwardPath is where the page asks. It sends the whole target as `url`
// rather than a path, because token authentication sends a client to a second
// host -- the realm in a WWW-Authenticate challenge -- and a path prefix
// catches only the first.
const forwardPath = "/-/fetch"

// passThrough is what is worth carrying back: what the body is, how big, what
// it is called, and whatever the registry says about holding on to it.
//
// Dropping the caching headers made every answer uncacheable, which is a
// decision this has no business making on the registry's behalf: a manifest
// fetched by digest cannot go stale.
var passThrough = []string{
	"content-type",
	"content-length",
	"docker-content-digest",
	"link",
	"www-authenticate",
	"oci-filters-applied",
	"cache-control",
	"etag",
	"last-modified",
}

// carried is what is taken from the page's request and sent upstream.
//
// Authorization is here for the shape where the page holds the credential. When
// this process holds one instead, it replaces whatever arrived: a viewer must
// not be able to choose what this sends upstream.
var carried = []string{"authorization", "accept", "range", "if-none-match", "if-modified-since"}

type Forwarder struct {
	config Config
	client *http.Client
}

func NewForwarder(config Config) *Forwarder {
	return &Forwarder{
		config: config,
		client: &http.Client{
			Timeout: 60 * time.Second,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 10 {
					return fmt.Errorf("too many redirects")
				}

				// A registry commonly answers a blob with a redirect to
				// storage, and the credential is for the registry and nobody
				// else. Go strips Authorization across hosts of its own accord;
				// this does not depend on that.
				if req.URL.Host != via[len(via)-1].URL.Host {
					req.Header.Del("Authorization")
				}

				return nil
			},
		},
	}
}

func (f *Forwarder) cors() http.Header {
	header := http.Header{}
	header.Set("access-control-allow-origin", f.config.AllowedOrigin)
	header.Set("access-control-allow-methods", "GET, HEAD, OPTIONS")
	header.Set("access-control-allow-headers", "authorization, accept, range")
	// The one that is easy to leave out and expensive to leave out: without it
	// a browser hands the page a response whose Docker-Content-Digest and Link
	// read as absent. Nothing errors -- pages just paginate once and report a
	// digest of "-", which looks like a registry that does not send them.
	header.Set("access-control-expose-headers", strings.Join(passThrough, ", "))
	header.Set("access-control-max-age", "86400")
	header.Set("vary", "Origin")
	return header
}

func (f *Forwarder) refuse(w http.ResponseWriter, status int, message string) {
	for name, values := range f.cors() {
		w.Header()[name] = values
	}

	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"errors": []map[string]any{{"code": "FORWARDER", "message": message, "detail": nil}},
	})
}

// allowed says whether this target may be fetched, and it is the whole of the
// safety argument.
//
// With an upstream configured the answer is that one host and nothing else.
// That is not a defence in depth, it is the defence: this process may be
// holding a credential, and a credential plus an arbitrary target is a
// credential handed to whoever asked.
//
// Without one it holds nothing, so the question is only the ordinary
// server-side request forgery one, and the answer is the address rules below.
func (f *Forwarder) allowed(target *url.URL) error {
	if target.Scheme != "http" && target.Scheme != "https" {
		return fmt.Errorf("%s is not forwarded", target.Scheme)
	}

	if f.config.Upstream != nil {
		if !strings.EqualFold(target.Host, f.config.Upstream.Host) {
			return fmt.Errorf("this forwards to %s and nowhere else", f.config.Upstream.Host)
		}

		return nil
	}

	if !f.config.AllowPrivate && isPrivate(target.Hostname()) {
		return fmt.Errorf("that address is not forwarded; set ALLOW_PRIVATE_TARGETS=true to reach your own network")
	}

	return nil
}

// isPrivate says whether the host is a literal address in a range that is not
// the caller's to reach.
//
// By literal address: a name that resolves to a private address is not caught
// here, and a determined caller can arrange that. Which is why the README says
// not to put the open shape of this on the public internet, and why the pinned
// shape does not rely on this at all.
func isPrivate(host string) bool {
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}

	address, err := netip(host)
	if err != nil {
		// Not a literal address, so nothing here can say.
		return false
	}

	return address.IsLoopback() ||
		address.IsPrivate() ||
		address.IsLinkLocalUnicast() ||
		address.IsLinkLocalMulticast() ||
		address.IsUnspecified()
}

func netip(host string) (net.IP, error) {
	address := net.ParseIP(host)
	if address == nil {
		return nil, fmt.Errorf("%q is not an address", host)
	}

	return address, nil
}

func (f *Forwarder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		for name, values := range f.cors() {
			w.Header()[name] = values
		}

		w.WriteHeader(http.StatusNoContent)
		return
	}

	// GET and HEAD only, so nothing can be changed through this -- which is
	// also what the minted token asks for, and what a viewer needs.
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		f.refuse(w, http.StatusMethodNotAllowed, "only GET and HEAD are forwarded")
		return
	}

	raw := r.URL.Query().Get("url")
	if raw == "" {
		f.refuse(w, http.StatusBadRequest, "no url to fetch")
		return
	}

	target, err := url.Parse(raw)
	if err != nil || target.Host == "" {
		f.refuse(w, http.StatusBadRequest, "url is not a URL")
		return
	}

	if err := f.allowed(target); err != nil {
		status := http.StatusForbidden
		if strings.Contains(err.Error(), "not forwarded") && target.Scheme != "http" && target.Scheme != "https" {
			status = http.StatusBadRequest
		}

		f.refuse(w, status, err.Error())
		return
	}

	request, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), nil)
	if err != nil {
		f.refuse(w, http.StatusBadRequest, err.Error())
		return
	}

	for _, name := range carried {
		if value := r.Header.Get(name); value != "" {
			request.Header.Set(name, value)
		}
	}

	// Whatever this process holds replaces whatever arrived. A page that could
	// choose the Authorization sent upstream would be a page that could spend
	// this credential on requests this did not intend.
	authorization, err := f.config.Credential.Authorization()
	if err != nil {
		f.refuse(w, http.StatusInternalServerError, "could not mint a credential: "+err.Error())
		return
	}

	if authorization != "" {
		request.Header.Set("authorization", authorization)
	}

	upstream, err := f.client.Do(request)
	if err != nil {
		f.refuse(w, http.StatusBadGateway, fmt.Sprintf("could not reach %s: %v", target.Host, err))
		return
	}

	defer upstream.Body.Close()

	if declared := upstream.Header.Get("content-length"); declared != "" {
		if size, err := strconv.ParseInt(declared, 10, 64); err == nil && size > f.config.MaximumBody {
			f.refuse(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("%d bytes is more than this forwards", size))
			return
		}
	}

	out := w.Header()
	for name, values := range f.cors() {
		out[name] = values
	}

	for _, name := range passThrough {
		if value := upstream.Header.Get(name); value != "" {
			out.Set(name, value)
		}
	}

	w.WriteHeader(upstream.StatusCode)

	// Capped again while streaming: a registry that declares no length, or
	// declares one it then exceeds, must not be able to spend this process's
	// memory or the reader's patience.
	if _, err := io.Copy(w, io.LimitReader(upstream.Body, f.config.MaximumBody)); err != nil {
		return
	}
}
