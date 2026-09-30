package gradlecache

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

const keyA = "0123456789abcdef0123456789abcdef"
const keyB = "fedcba9876543210fedcba9876543210"
const keyC = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func fixture(t *testing.T, root string, maxEntry, maxTotal int64) *Server {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte("secret"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	credentials := filepath.Join(t.TempDir(), "htpasswd")
	if err := os.WriteFile(credentials, []byte("builder:"+string(hash)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := New(root, credentials, maxEntry, maxTotal)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func request(t *testing.T, s *Server, method, key string, body []byte, password string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "/cache/"+key, bytes.NewReader(body))
	if password != "" {
		r.SetBasicAuth("builder", password)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestOpaqueArchiveLifecycleAndRestart(t *testing.T) {
	root := filepath.Join(t.TempDir(), "entries")
	s := fixture(t, root, 20, 30)
	if got := request(t, s, http.MethodGet, keyA, nil, "secret"); got.Code != 404 {
		t.Fatalf("miss=%d", got.Code)
	}
	if got := request(t, s, http.MethodPut, keyA, []byte("opaque-a"), "secret"); got.Code != 201 {
		t.Fatalf("put=%d %s", got.Code, got.Body)
	}
	if got := request(t, s, http.MethodGet, keyA, nil, "secret"); got.Code != 200 || got.Body.String() != "opaque-a" {
		t.Fatalf("get=%d %q", got.Code, got.Body)
	}
	if got := request(t, s, http.MethodPut, keyA, []byte("different"), "secret"); got.Code != 409 {
		t.Fatalf("overwrite=%d", got.Code)
	}
	s = fixture(t, root, 20, 30)
	if got := request(t, s, http.MethodGet, keyA, nil, "secret"); got.Code != 200 || got.Body.String() != "opaque-a" {
		t.Fatalf("restart=%d %q", got.Code, got.Body)
	}
}

func TestAuthenticationAndBounds(t *testing.T) {
	s := fixture(t, filepath.Join(t.TempDir(), "entries"), 8, 16)
	if got := request(t, s, http.MethodPut, keyA, []byte("payload"), ""); got.Code != 401 {
		t.Fatalf("anonymous=%d", got.Code)
	}
	if got := request(t, s, http.MethodPut, keyA, []byte("payload"), "wrong"); got.Code != 401 {
		t.Fatalf("wrong password=%d", got.Code)
	}
	if got := request(t, s, http.MethodPut, "../"+keyA, []byte("payload"), "secret"); got.Code != 404 {
		t.Fatalf("path traversal=%d", got.Code)
	}
	if got := request(t, s, http.MethodPut, keyA, []byte("123456789"), "secret"); got.Code != 413 {
		t.Fatalf("oversize=%d", got.Code)
	}
	if got := request(t, s, http.MethodGet, keyA, nil, "secret"); got.Code != 404 {
		t.Fatalf("partial upload visible=%d", got.Code)
	}
	if got := request(t, s, http.MethodDelete, keyA, nil, "secret"); got.Code != 405 {
		t.Fatalf("delete=%d", got.Code)
	}
}

func TestClientAndProbeCredentialsFromManagementAPI(t *testing.T) {
	clientHash, err := bcrypt.GenerateFromPassword([]byte("client-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	probeHash, err := bcrypt.GenerateFromPassword([]byte("probe-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	credentials := filepath.Join(t.TempDir(), "htpasswd")
	write := func(content string) {
		t.Helper()
		if err := os.WriteFile(credentials, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("cache:" + string(clientHash) + "\nhealth:" + string(probeHash) + "\n")
	s, err := New(filepath.Join(t.TempDir(), "entries"), credentials, 32, 64)
	if err != nil {
		t.Fatal(err)
	}
	check := func(user, password string, want int) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/status", nil)
		r.SetBasicAuth(user, password)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("user %q: got %d, want %d", user, w.Code, want)
		}
	}
	check("cache", "client-password", 200)
	check("health", "probe-password", 200)
	check("cache", "probe-password", 401)
	check("health", "client-password", 401)
	write("cache:" + string(clientHash) + "\nhealth:" + string(probeHash) + "\nother:" + string(probeHash) + "\n")
	check("cache", "client-password", 503)
	write("cache:" + string(clientHash) + "\ncache:" + string(probeHash) + "\n")
	check("cache", "client-password", 503)
}

func TestAuthenticatedStatusReportsRequestsAndCapacity(t *testing.T) {
	s := fixture(t, filepath.Join(t.TempDir(), "entries"), 8, 16)
	request(t, s, http.MethodGet, keyA, nil, "secret")
	request(t, s, http.MethodPut, keyA, []byte("archive"), "secret")
	request(t, s, http.MethodGet, keyA, nil, "secret")
	r := httptest.NewRequest(http.MethodGet, "/status", nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatalf("anonymous status=%d", w.Code)
	}
	r.SetBasicAuth("builder", "secret")
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("status=%d", w.Code)
	}
	var status struct {
		SizeBytes, CapacityBytes       int64
		Entries                        int
		GetHits, GetMisses, PutSuccess uint64
	}
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.SizeBytes != 7 || status.CapacityBytes != 16 || status.Entries != 1 || status.GetHits != 1 || status.GetMisses != 1 || status.PutSuccess != 1 {
		t.Fatalf("unexpected status: %+v", status)
	}
}

func TestBudgetEvictsOldestAndRecoversAfterRestart(t *testing.T) {
	root := filepath.Join(t.TempDir(), "entries")
	s := fixture(t, root, 8, 12)
	for _, key := range []string{keyA, keyB, keyC} {
		if got := request(t, s, http.MethodPut, key, []byte(strings.Repeat(key[:1], 6)), "secret"); got.Code != 201 {
			t.Fatalf("put %s=%d", key, got.Code)
		}
	}
	if got := request(t, s, http.MethodGet, keyA, nil, "secret"); got.Code != 404 {
		t.Fatalf("oldest not evicted=%d", got.Code)
	}
	for _, key := range []string{keyB, keyC} {
		if got := request(t, s, http.MethodGet, key, nil, "secret"); got.Code != 200 {
			t.Fatalf("retained %s=%d", key, got.Code)
		}
	}
	s = fixture(t, root, 8, 12)
	if got := request(t, s, http.MethodGet, keyC, nil, "secret"); got.Code != 200 {
		t.Fatalf("restart=%d", got.Code)
	}
}

func TestConcurrentWritersPublishOneCompleteArchive(t *testing.T) {
	s := fixture(t, filepath.Join(t.TempDir(), "entries"), 1024, 2048)
	const writers = 12
	var group sync.WaitGroup
	statuses := make(chan int, writers)
	for range writers {
		group.Add(1)
		go func() {
			defer group.Done()
			statuses <- request(t, s, http.MethodPut, keyA, bytes.Repeat([]byte("x"), 1000), "secret").Code
		}()
	}
	group.Wait()
	close(statuses)
	created := 0
	for status := range statuses {
		if status == 201 {
			created++
		} else if status != 409 {
			t.Fatalf("unexpected status %d", status)
		}
	}
	if created != 1 {
		t.Fatalf("created %d entries", created)
	}
	got := request(t, s, http.MethodGet, keyA, nil, "secret")
	if got.Code != 200 || got.Body.Len() != 1000 {
		t.Fatalf("incomplete archive: %d bytes, status %d", got.Body.Len(), got.Code)
	}
}
