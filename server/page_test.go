package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// TestPageSaysWhatABrowserMayKeep pins the pair: the page is revalidated every
// time and the hashed assets are believed for a year. The second is what makes
// the first free, and doing one without the other is half wrong -- page only
// refetches every asset, assets only leaves an old page pointing at old ones.
//
// Without either, a browser falls back to a heuristic over `Last-Modified`,
// which in an image is the build time. That failure is silent -- the server is
// right, the bundle is right, only the page somebody sees is old -- which is
// why it is worth a test rather than a comment.
func TestPageSaysWhatABrowserMayKeep(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("<!doctype html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "assets", "index-abc123.js"), []byte("//"), 0o644); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(page(root))
	defer srv.Close()

	for _, tc := range []struct {
		path string
		want string
	}{
		{"/", "no-cache"},
		{"/index.html", "no-cache"},
		{"/assets/index-abc123.js", "public, max-age=31536000, immutable"},
	} {
		res, err := http.Get(srv.URL + tc.path)
		if err != nil {
			t.Fatalf("get %s: %v", tc.path, err)
		}
		res.Body.Close()
		if got := res.Header.Get("Cache-Control"); got != tc.want {
			t.Errorf("%s: Cache-Control = %q, want %q", tc.path, got, tc.want)
		}
	}
}
