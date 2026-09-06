package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Credential is what this process puts in Authorization on the way upstream.
//
// Four shapes, named rather than inferred from which secret happens to be set:
// a process that holds a key should not be guessing what it was meant to do
// with it, and two secrets set at once is a question, not a default.
type Credential interface {
	// Authorization is the header value, or "" for none. It may mint.
	Authorization() (string, error)
	// Describe says what this is, for the log line at startup. Never a secret.
	Describe() string
}

type noCredential struct{}

func (noCredential) Authorization() (string, error) { return "", nil }
func (noCredential) Describe() string               { return "none" }

type staticCredential struct {
	value string
	kind  string
}

func (c staticCredential) Authorization() (string, error) { return c.value, nil }
func (c staticCredential) Describe() string               { return c.kind }

func loadCredential(upstream *url.URL) (Credential, error) {
	switch mode := strings.ToLower(env("REGISTRY_AUTH", "none")); mode {
	case "none":
		return noCredential{}, nil

	case "basic":
		username, err := secret("REGISTRY_USERNAME")
		if err != nil {
			return nil, err
		}

		password, err := secret("REGISTRY_PASSWORD")
		if err != nil {
			return nil, err
		}

		if username == "" || password == "" {
			return nil, errors.New("REGISTRY_AUTH=basic needs REGISTRY_USERNAME and REGISTRY_PASSWORD")
		}

		encoded := base64.StdEncoding.EncodeToString([]byte(username + ":" + password))
		return staticCredential{value: "Basic " + encoded, kind: "basic as " + username}, nil

	case "bearer":
		token, err := secret("REGISTRY_TOKEN")
		if err != nil {
			return nil, err
		}

		if token == "" {
			return nil, errors.New("REGISTRY_AUTH=bearer needs REGISTRY_TOKEN")
		}

		return staticCredential{value: "Bearer " + token, kind: "bearer, a token given to it"}, nil

	case "jwt":
		return loadMinter(upstream)

	default:
		return nil, fmt.Errorf("REGISTRY_AUTH: %q is not none, basic, bearer or jwt", mode)
	}
}

// minter signs its own tokens, which is what a registry verifying against a
// key set wants and what a process with no way to ask for one has to do.
//
// A key rather than a token is the safer half of that trade, which reads
// backwards until you ask how each is taken away. A token cannot be revoked --
// a registry checking signatures has no deny list, so a leaked one is good
// until it expires. A key is revoked by dropping its entry from the registry's
// key set, which takes effect at once and touches nothing else in it.
//
// And it lets the tokens be short. Nothing has to survive a restart or a week,
// so they last minutes, and one that leaks out of a log is worth almost
// nothing by the time anybody reads it.
type minter struct {
	key          *ecdsa.PrivateKey
	keyID        string
	issuer       string
	subject      string
	audience     string
	capabilities []string
	lifetime     time.Duration

	mutex sync.Mutex
	token string
	until time.Time
}

// privateJWK is the P-256 key as REGISTRY_SIGNING_KEY carries it.
type privateJWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	D   string `json:"d"`
	X   string `json:"x"`
	Y   string `json:"y"`
	Kid string `json:"kid"`
}

func loadMinter(upstream *url.URL) (Credential, error) {
	raw, err := secret("REGISTRY_SIGNING_KEY")
	if err != nil {
		return nil, err
	}

	if raw == "" {
		return nil, errors.New("REGISTRY_AUTH=jwt needs REGISTRY_SIGNING_KEY, a P-256 private key in JWK form")
	}

	var jwk privateJWK
	if err := json.Unmarshal([]byte(raw), &jwk); err != nil {
		return nil, fmt.Errorf("REGISTRY_SIGNING_KEY is not JSON: %w", err)
	}

	if jwk.Kty != "EC" || jwk.Crv != "P-256" {
		return nil, fmt.Errorf("REGISTRY_SIGNING_KEY is %s/%s; this signs ES256, which is EC/P-256", jwk.Kty, jwk.Crv)
	}

	d, err := decodeCoordinate(jwk.D)
	if err != nil {
		return nil, fmt.Errorf("REGISTRY_SIGNING_KEY: d: %w", err)
	}

	// The public half is derived rather than read. The JWK carries x and y, but
	// they are the private part's consequence, not a second input -- and a key
	// whose parts disagree signs nothing, which is a thing to be told at
	// startup rather than on the first request an hour later.
	key := &ecdsa.PrivateKey{D: new(big.Int).SetBytes(d)}
	key.PublicKey.Curve = elliptic.P256()
	key.PublicKey.X, key.PublicKey.Y = elliptic.P256().ScalarBaseMult(d)

	if err := agrees(jwk.X, key.PublicKey.X, "x"); err != nil {
		return nil, err
	}

	if err := agrees(jwk.Y, key.PublicKey.Y, "y"); err != nil {
		return nil, err
	}

	// The registry compares host and port and ignores the scheme, so the host
	// it is reached at is the audience it will accept.
	audience := env("REGISTRY_TOKEN_AUDIENCE", "")
	if audience == "" && upstream != nil {
		audience = upstream.Host
	}

	if audience == "" {
		return nil, errors.New("REGISTRY_AUTH=jwt needs an audience: set REGISTRY_UPSTREAM, or REGISTRY_TOKEN_AUDIENCE")
	}

	lifetime, err := number("REGISTRY_TOKEN_LIFETIME", 300)
	if err != nil {
		return nil, err
	}

	if lifetime < 60 {
		// A registry tolerating a minute of clock skew cannot usefully be
		// handed anything shorter than that.
		return nil, fmt.Errorf("REGISTRY_TOKEN_LIFETIME: %ds is shorter than the clock skew a registry allows for", lifetime)
	}

	capabilities := strings.FieldsFunc(env("REGISTRY_TOKEN_CAPABILITIES", "pull"), func(r rune) bool {
		return r == ',' || r == ' '
	})

	return &minter{
		key:          key,
		keyID:        jwk.Kid,
		issuer:       env("REGISTRY_TOKEN_ISSUER", ""),
		subject:      env("REGISTRY_TOKEN_SUBJECT", "service/registry-ui"),
		audience:     audience,
		capabilities: capabilities,
		lifetime:     time.Duration(lifetime) * time.Second,
	}, nil
}

// agrees checks a coordinate the JWK stated against the one d implies.
//
// Only when it states one: a key file that omits the public half is still a
// key. Stating a different one is not, and it is the shape a truncated or
// half-swapped secret takes.
func agrees(stated string, derived *big.Int, name string) error {
	if stated == "" {
		return nil
	}

	raw, err := decodeCoordinate(stated)
	if err != nil {
		return fmt.Errorf("REGISTRY_SIGNING_KEY: %s: %w", name, err)
	}

	if new(big.Int).SetBytes(raw).Cmp(derived) != 0 {
		return fmt.Errorf("REGISTRY_SIGNING_KEY: %s is not the one d implies; the key's halves do not belong together", name)
	}

	return nil
}

func decodeCoordinate(value string) ([]byte, error) {
	if value == "" {
		return nil, errors.New("missing")
	}

	return base64.RawURLEncoding.DecodeString(value)
}

func (m *minter) Describe() string {
	return fmt.Sprintf("jwt, signed here as %s for %s (%s)", m.issuer, m.audience, strings.Join(m.capabilities, ","))
}

// renewBefore is how long before expiry a token is replaced.
//
// Before rather than after, so a request is never sent with one that died
// between being chosen and arriving.
const renewBefore = 60 * time.Second

func (m *minter) Authorization() (string, error) {
	m.mutex.Lock()
	defer m.mutex.Unlock()

	if m.token != "" && time.Now().Before(m.until) {
		return m.token, nil
	}

	now := time.Now()
	expires := now.Add(m.lifetime)

	header := map[string]any{"alg": "ES256", "typ": "JWT"}
	if m.keyID != "" {
		header["kid"] = m.keyID
	}

	claims := map[string]any{
		"iss":          m.issuer,
		"sub":          m.subject,
		"aud":          []string{m.audience},
		"capabilities": m.capabilities,
		"iat":          now.Unix(),
		"exp":          expires.Unix(),
	}

	signing, err := segment(header)
	if err != nil {
		return "", err
	}

	payload, err := segment(claims)
	if err != nil {
		return "", err
	}

	signing = signing + "." + payload
	digest := sha256.Sum256([]byte(signing))

	// The fixed-width r||s of JWS, not the ASN.1 that ecdsa.SignASN1 answers.
	r, s, err := ecdsa.Sign(rand.Reader, m.key, digest[:])
	if err != nil {
		return "", fmt.Errorf("signing a token: %w", err)
	}

	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])

	m.token = "Bearer " + signing + "." + base64.RawURLEncoding.EncodeToString(signature)
	m.until = expires.Add(-renewBefore)
	return m.token, nil
}

func segment(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}

	return base64.RawURLEncoding.EncodeToString(encoded), nil
}
