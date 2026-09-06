package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func pinned(t *testing.T, upstream string, credential Credential) *Forwarder {
	t.Helper()
	parsed, err := url.Parse(upstream)
	if err != nil {
		t.Fatal(err)
	}

	return NewForwarder(Config{
		Upstream:      &url.URL{Scheme: parsed.Scheme, Host: parsed.Host},
		Credential:    credential,
		AllowedOrigin: "*",
		MaximumBody:   8 << 20,
	})
}

func ask(f *Forwarder, target string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, forwardPath+"?url="+url.QueryEscape(target), nil)
	recorder := httptest.NewRecorder()
	f.ServeHTTP(recorder, request)
	return recorder
}

// The rule the whole design rests on: a forwarder holding a credential must not
// be steerable at another host, or it is a forwarder that gives it away.
func TestPinnedForwarderRefusesAnotherHost(t *testing.T) {
	seen := make(chan string, 1)
	elsewhere := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("Authorization")
	}))
	defer elsewhere.Close()

	f := pinned(t, "https://registry.example", staticCredential{value: "Bearer secret"})
	got := ask(f, elsewhere.URL+"/v2/")

	if got.Code != http.StatusForbidden {
		t.Fatalf("asked to fetch another host: got %d, want 403", got.Code)
	}

	select {
	case authorization := <-seen:
		t.Fatalf("it went anyway, carrying %q", authorization)
	default:
	}
}

func TestPinnedForwarderAttachesItsOwnCredential(t *testing.T) {
	var got string
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		w.Header().Set("docker-content-digest", "sha256:abc")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer registry.Close()

	f := pinned(t, registry.URL, staticCredential{value: "Bearer minted"})
	res := ask(f, registry.URL+"/v2/_catalog")

	if res.Code != http.StatusOK {
		t.Fatalf("got %d: %s", res.Code, res.Body.String())
	}

	if got != "Bearer minted" {
		t.Fatalf("upstream saw %q, want the configured credential", got)
	}

	if exposed := res.Header().Get("access-control-expose-headers"); !strings.Contains(exposed, "docker-content-digest") {
		t.Fatalf("the digest is not exposed to the page: %q", exposed)
	}
}

// A page must not be able to choose what this sends upstream: it would be able
// to spend the credential on requests this process did not intend.
func TestPageCannotChooseWhatGoesUpstream(t *testing.T) {
	var got string
	registry := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
	}))
	defer registry.Close()

	f := pinned(t, registry.URL, staticCredential{value: "Bearer mine"})
	request := httptest.NewRequest(http.MethodGet, forwardPath+"?url="+url.QueryEscape(registry.URL+"/v2/"), nil)
	request.Header.Set("Authorization", "Bearer theirs")
	f.ServeHTTP(httptest.NewRecorder(), request)

	if got != "Bearer mine" {
		t.Fatalf("upstream saw %q, want the process's own credential", got)
	}
}

// A registry answers a blob with a redirect to storage, and the credential is
// for the registry and nobody else.
func TestCredentialIsNotCarriedAcrossARedirect(t *testing.T) {
	var atStorage string
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atStorage = r.Header.Get("Authorization")
		_, _ = w.Write([]byte("blob"))
	}))
	defer storage.Close()

	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, storage.URL+"/object", http.StatusTemporaryRedirect)
	}))
	defer registry.Close()

	f := pinned(t, registry.URL, staticCredential{value: "Bearer secret"})
	if res := ask(f, registry.URL+"/v2/x/blobs/sha256:abc"); res.Code != http.StatusOK {
		t.Fatalf("got %d", res.Code)
	}

	if atStorage != "" {
		t.Fatalf("storage was sent %q", atStorage)
	}
}

// Without an upstream it holds nothing, so the question is the ordinary one.
func TestOpenForwarderRefusesPrivateAddresses(t *testing.T) {
	f := NewForwarder(Config{Credential: noCredential{}, AllowedOrigin: "*", MaximumBody: 8 << 20})
	for _, target := range []string{
		"http://127.0.0.1/v2/",
		"http://10.0.0.1/v2/",
		"http://169.254.169.254/latest/meta-data/",
		"http://localhost:5000/v2/",
		"http://[::1]/v2/",
	} {
		if got := ask(f, target).Code; got != http.StatusForbidden {
			t.Errorf("%s: got %d, want 403", target, got)
		}
	}
}

func TestOnlyReadsAreForwarded(t *testing.T) {
	f := pinned(t, "https://registry.example", noCredential{})
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		request := httptest.NewRequest(method, forwardPath+"?url=https://registry.example/v2/", nil)
		recorder := httptest.NewRecorder()
		f.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: got %d, want 405", method, recorder.Code)
		}
	}
}

func TestBodyOverTheLimitIsRefused(t *testing.T) {
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-length", "999999")
		w.WriteHeader(http.StatusOK)
	}))
	defer registry.Close()

	f := pinned(t, registry.URL, noCredential{})
	f.config.MaximumBody = 1024
	if got := ask(f, registry.URL+"/v2/x/blobs/sha256:abc").Code; got != http.StatusRequestEntityTooLarge {
		t.Fatalf("got %d, want 413", got)
	}
}

func TestMintedTokenIsAnES256JWTForTheUpstream(t *testing.T) {
	t.Setenv("REGISTRY_AUTH", "jwt")
	t.Setenv("REGISTRY_SIGNING_KEY", testKey)
	t.Setenv("REGISTRY_TOKEN_ISSUER", "https://ui.example")

	upstream, _ := url.Parse("https://registry.example")
	credential, err := loadCredential(upstream)
	if err != nil {
		t.Fatal(err)
	}

	value, err := credential.Authorization()
	if err != nil {
		t.Fatal(err)
	}

	parts := strings.Split(strings.TrimPrefix(value, "Bearer "), ".")
	if len(parts) != 3 {
		t.Fatalf("not a JWT: %q", value)
	}

	header := decodeSegment(t, parts[0])
	if header["alg"] != "ES256" {
		t.Errorf("alg is %v, want ES256", header["alg"])
	}

	claims := decodeSegment(t, parts[1])
	if claims["iss"] != "https://ui.example" {
		t.Errorf("iss is %v", claims["iss"])
	}

	audience, _ := claims["aud"].([]any)
	if len(audience) != 1 || audience[0] != "registry.example" {
		t.Errorf("aud is %v, want the upstream host", claims["aud"])
	}

	if signature, err := base64.RawURLEncoding.DecodeString(parts[2]); err != nil || len(signature) != 64 {
		t.Errorf("signature is %d bytes, want the 64 of JWS r||s", len(signature))
	}

	// Minted once and kept: a token per request would be a signature per
	// request for no reason.
	again, _ := credential.Authorization()
	if again != value {
		t.Error("it minted a second token for a second request")
	}
}

func decodeSegment(t *testing.T, segment string) map[string]any {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil {
		t.Fatal(err)
	}

	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}

	return value
}

// A P-256 key, generated for this test and used nowhere.
const testKey = `{"kty":"EC","crv":"P-256","kid":"test",
	"d":"rfFuT-nVYG_DCWbTeE7Qjm4A-ljKPE_9WQs2Gb6xxpQ",
	"x":"3T7GZzOdBkgHOBHno0YiIFuREqkZYes4QCLPmjRdXEA",
	"y":"Z8OX4MGE3y8HqEfvdeeL65j8_6tEA5ySue9sdL18io4"}`
