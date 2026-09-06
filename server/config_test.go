package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestACredentialWithNowhereToSendItRefusesToStart(t *testing.T) {
	t.Setenv("REGISTRY_AUTH", "bearer")
	t.Setenv("REGISTRY_TOKEN", "secret")

	_, err := Load()
	if err == nil {
		t.Fatal("it started with a credential and no upstream")
	}

	if !strings.Contains(err.Error(), "REGISTRY_UPSTREAM") {
		t.Fatalf("it did not say what was missing: %v", err)
	}
}

func TestAPinnedUpstreamDecidesThePageForItself(t *testing.T) {
	t.Setenv("REGISTRY_UPSTREAM", "https://registry.hday.io")
	t.Setenv("REGISTRY_AUTH", "bearer")
	t.Setenv("REGISTRY_TOKEN", "secret")

	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}

	var page map[string]any
	if err := json.Unmarshal(config.PageJSON(), &page); err != nil {
		t.Fatal(err)
	}

	for field, want := range map[string]any{
		"domain":    "registry.hday.io",
		"direct":    false,
		"locked":    true,
		"anonymous": true,
		"forwarder": forwardPath,
	} {
		if page[field] != want {
			t.Errorf("%s is %v, want %v", field, page[field], want)
		}
	}
}

// Without one, nothing is decided on the person's behalf.
func TestAnOpenForwarderSaysOnlyWhatItWasTold(t *testing.T) {
	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}

	if got := string(config.PageJSON()); got != "{}" {
		t.Fatalf("config.json is %s, want nothing said", got)
	}
}

func TestAKeyWhoseHalvesDisagreeIsRefused(t *testing.T) {
	t.Setenv("REGISTRY_UPSTREAM", "https://registry.example")
	t.Setenv("REGISTRY_AUTH", "jwt")
	// The same key with one bit of x turned over.
	t.Setenv("REGISTRY_SIGNING_KEY", strings.Replace(testKey, "3T7GZ", "3T7GX", 1))

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "do not belong together") {
		t.Fatalf("got %v, want a refusal naming the mismatch", err)
	}
}

func TestASecretCanComeFromAFile(t *testing.T) {
	path := t.TempDir() + "/token"
	if err := writeFile(path, "  from-a-file\n"); err != nil {
		t.Fatal(err)
	}

	t.Setenv("REGISTRY_UPSTREAM", "https://registry.example")
	t.Setenv("REGISTRY_AUTH", "bearer")
	t.Setenv("REGISTRY_TOKEN_FILE", path)

	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}

	got, err := config.Credential.Authorization()
	if err != nil {
		t.Fatal(err)
	}

	if got != "Bearer from-a-file" {
		t.Fatalf("got %q, want the file's contents, trimmed", got)
	}
}
