package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestScanDoesNotFollowLinks(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "one"), []byte("cache"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "nested", "two"), []byte("item"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "one"), filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	value, err := scan(root, 1<<30, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if value.UsedBytes != 9 || value.ItemCount != 2 || value.CapacityBytes != 1<<30 {
		t.Fatalf("unexpected snapshot: %+v", value)
	}
}

func TestStatusRequiresProbeCredentialsAndFreshSnapshot(t *testing.T) {
	root := t.TempDir()
	user, password := filepath.Join(root, "user"), filepath.Join(root, "password")
	for path, value := range map[string]string{user: "health", password: "secret"} {
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	s := &server{root: root, usernameFile: user, passwordFile: password, capacityBytes: 1 << 30}
	s.refresh()
	request := func(username, secret string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/status", nil)
		if username != "" {
			r.SetBasicAuth(username, secret)
		}
		w := httptest.NewRecorder()
		s.serveHTTP(w, r)
		return w
	}
	for _, credentials := range [][2]string{{"", ""}, {"health", "wrong"}, {"other", "secret"}} {
		if got := request(credentials[0], credentials[1]).Code; got != http.StatusUnauthorized {
			t.Fatalf("invalid credentials returned %d", got)
		}
	}
	w := request("health", "secret")
	if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("valid status returned %d", w.Code)
	}
	var value snapshot
	if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil || value.CapacityBytes != 1<<30 {
		t.Fatalf("unexpected status %s: %v", w.Body.String(), err)
	}
	s.mu.Lock()
	s.current.ObservedAt = time.Now().Add(-3 * time.Minute)
	s.mu.Unlock()
	if got := request("health", "secret").Code; got != http.StatusServiceUnavailable {
		t.Fatalf("stale snapshot returned %d", got)
	}
}
