package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// Config is everything this process is told, read once at startup.
//
// The shape of it turns on one variable. Without REGISTRY_UPSTREAM this is a
// forwarder for whatever a page asks it to fetch, holding nothing, and the page
// carries whatever credential there is. With it, the forwarder is pinned to one
// registry and may hold the credential for it -- which is the only arrangement
// that works against a registry sending no CORS headers, since then the page
// cannot reach it at all and has nowhere to keep a token that is not a viewer's
// devtools.
//
// Credentials narrow it. That is the rule the rest of this file exists to keep:
// a forwarder that holds a credential and takes an arbitrary target is not a
// forwarder with an SSRF problem, it is a forwarder that gives its credential
// to whoever asks.
type Config struct {
	Port     int
	PageRoot string

	// Upstream pins the forwarder. nil means the open, credential-less shape.
	Upstream *url.URL

	// Credential is what goes upstream, and is never nil -- "none" is a value.
	Credential Credential

	AllowedOrigin string
	AllowPrivate  bool
	MaximumBody   int64

	// Page is what /config.json answers, derived from the above where the
	// deployment has already decided it. See PageConfig.
	Page PageConfig
}

// PageConfig is the page's own settings, which it fetches on load.
//
// Derived rather than configured separately wherever the answer is already
// known: a pinned upstream *is* the domain, and a forwarder's existence *is*
// the reason not to talk to the registry directly. Two variables that have to
// agree are two variables that can disagree.
type PageConfig struct {
	Domain    string `json:"domain,omitempty"`
	Forwarder string `json:"forwarder,omitempty"`
	Direct    *bool  `json:"direct,omitempty"`
	Insecure  bool   `json:"insecure,omitempty"`
	Locked    bool   `json:"locked,omitempty"`
	Anonymous bool   `json:"anonymous,omitempty"`
	Logo      string `json:"logo,omitempty"`
	Title     string `json:"title,omitempty"`
}

// secret reads NAME, or the contents of NAME_FILE.
//
// The file is the better half of this. A password in the environment is a
// password in `docker inspect`, in the orchestrator's API and in anything that
// reads either; a file is a mounted secret, which is what a platform gives you
// for this and what it can rotate.
func secret(name string) (string, error) {
	if path := os.Getenv(name + "_FILE"); path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("%s_FILE: %w", name, err)
		}

		return strings.TrimSpace(string(raw)), nil
	}

	return strings.TrimSpace(os.Getenv(name)), nil
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}

	return fallback
}

func flag(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "true", "1", "yes":
		return true
	default:
		return false
	}
}

func number(name string, fallback int64) (int64, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}

	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s: %q is not a number", name, raw)
	}

	return value, nil
}

// Load reads the environment, and refuses to answer with a half-built one.
//
// Everything it can object to, it objects to here rather than on the first
// request: a process holding a signing key should not start if it has been
// handed something it cannot sign with, and finding that out at startup is the
// difference between a pod that will not go ready and a viewer that 500s.
func Load() (Config, error) {
	port, err := number("PORT", 8080)
	if err != nil {
		return Config{}, err
	}

	maximum, err := number("MAX_BODY_BYTES", 8*1024*1024)
	if err != nil {
		return Config{}, err
	}

	config := Config{
		Port:          int(port),
		PageRoot:      env("PAGE_ROOT", "./dist"),
		AllowedOrigin: env("ALLOWED_ORIGIN", "*"),
		AllowPrivate:  flag("ALLOW_PRIVATE_TARGETS"),
		MaximumBody:   maximum,
		Credential:    noCredential{},
	}

	if raw := env("REGISTRY_UPSTREAM", ""); raw != "" {
		upstream, err := url.Parse(raw)
		if err != nil {
			return Config{}, fmt.Errorf("REGISTRY_UPSTREAM: %w", err)
		}

		if upstream.Scheme != "http" && upstream.Scheme != "https" {
			return Config{}, fmt.Errorf("REGISTRY_UPSTREAM: %q is not http or https", raw)
		}

		if upstream.Host == "" {
			return Config{}, fmt.Errorf("REGISTRY_UPSTREAM: %q names no host", raw)
		}

		config.Upstream = &url.URL{Scheme: upstream.Scheme, Host: upstream.Host}
	}

	credential, err := loadCredential(config.Upstream)
	if err != nil {
		return Config{}, err
	}

	// A credential with nowhere to send it is a mistake worth stopping for,
	// not a setting to quietly ignore: the alternative is a deployment that
	// looks authenticated and is not.
	if _, none := credential.(noCredential); !none && config.Upstream == nil {
		return Config{}, errors.New("REGISTRY_AUTH is set but REGISTRY_UPSTREAM is not: there is nowhere to send a credential that is safe to send it")
	}

	config.Credential = credential
	config.Page = loadPage(config)
	return config, nil
}

func loadPage(config Config) PageConfig {
	direct := flag("REGISTRY_DIRECT")
	page := PageConfig{
		Domain:    env("REGISTRY_DOMAIN", ""),
		Forwarder: env("REGISTRY_FORWARDER", ""),
		Insecure:  flag("REGISTRY_INSECURE"),
		Locked:    flag("REGISTRY_LOCKED"),
		Anonymous: flag("REGISTRY_ANONYMOUS"),
		Logo:      env("REGISTRY_LOGO", ""),
		Title:     env("REGISTRY_TITLE", ""),
	}

	if config.Upstream == nil {
		// No pinned registry: this is a plain forwarder beside a page that is
		// still the person's to point anywhere. Only say what was said.
		if os.Getenv("REGISTRY_DIRECT") != "" {
			page.Direct = &direct
		}

		return page
	}

	// Pinned. The page is looking at this registry, through here, and there is
	// nothing for a person to fill in -- so say so rather than asking an
	// operator to write four more variables that agree with this one.
	no := false
	page.Domain = config.Upstream.Host
	page.Direct = &no
	page.Locked = true
	if page.Forwarder == "" {
		page.Forwarder = forwardPath
	}

	if _, none := config.Credential.(noCredential); !none {
		// The credential is here. Asking for one is asking for something that
		// would not be used.
		page.Anonymous = true
	}

	page.Insecure = config.Upstream.Scheme == "http"
	return page
}

// PageJSON is what /config.json answers.
//
// Marshalled once at startup rather than per request: it cannot change while
// the process runs, and a page fetching it on load should not be waiting on
// anything this process has to think about.
func (c Config) PageJSON() []byte {
	encoded, err := json.Marshal(c.Page)
	if err != nil {
		// Every field is a string or a bool; there is no shape of this that
		// fails to marshal, and pretending otherwise would be inventing an
		// error path nothing can reach.
		return []byte("{}")
	}

	return encoded
}

func writeFile(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o600)
}
