package gradlecache

import (
	"golang.org/x/crypto/bcrypt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMetricsAreAuthenticatedAndDoNotAffectCacheAccounting(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("secret"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	credentials := filepath.Join(t.TempDir(), "htpasswd")
	if err := os.WriteFile(credentials, []byte("builder:"+string(hash)+"\nhealth:"+string(hash)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := New(filepath.Join(t.TempDir(), "entries"), credentials, 8, 10)
	if err != nil {
		t.Fatal(err)
	}
	scrape := func(user, method string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/metrics", nil)
		if user != "" {
			r.SetBasicAuth(user, "secret")
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	for _, test := range []struct {
		user, method string
		status       int
	}{{"", "GET", 401}, {"builder", "GET", 403}, {"health", "POST", 405}, {"health", "GET", 200}} {
		if w := scrape(test.user, test.method); w.Code != test.status {
			t.Fatalf("%s %s: %d", test.user, test.method, w.Code)
		}
	}
	request(t, s, "GET", keyA, nil, "secret")
	request(t, s, "PUT", keyA, []byte("12345678"), "secret")
	request(t, s, "GET", keyA, nil, "secret")
	request(t, s, "PUT", keyB, []byte("abcdefgh"), "secret")
	before := scrape("health", "GET").Body.String()
	for _, expected := range []string{
		`expbuild_cache_lookups_total{outcome="hit"} 1`,
		`expbuild_cache_lookups_total{outcome="miss"} 1`,
		`expbuild_cache_requests_total{method="GET",status_class="4xx"} 1`,
		`expbuild_cache_requests_total{method="PUT",status_class="2xx"} 2`,
		`expbuild_cache_transfer_bytes_total{direction="read"} 8`,
		`expbuild_cache_transfer_bytes_total{direction="write"} 16`,
		`expbuild_cache_evictions_total 1`, `expbuild_cache_evicted_bytes_total 8`,
		`expbuild_cache_used_bytes 8`, `expbuild_cache_entries 1`,
	} {
		if !strings.Contains(before, expected) {
			t.Fatalf("missing metric %s\n%s", expected, before)
		}
	}
	for i := 0; i < 3; i++ {
		if got := scrape("health", "GET").Body.String(); got != before {
			t.Fatal("scrape changed cache accounting")
		}
	}
	if strings.Contains(before, keyA) || strings.Contains(before, "secret") {
		t.Fatal("unbounded identity in metrics")
	}
}
