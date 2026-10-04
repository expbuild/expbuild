package nxcache

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func testServer(t *testing.T, maxEntry, maxTotal int64) *Server {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	creds := filepath.Join(dir, "auth")
	cache, _ := bcrypt.GenerateFromPassword([]byte("client-secret"), bcrypt.MinCost)
	health, _ := bcrypt.GenerateFromPassword([]byte("probe-secret"), bcrypt.MinCost)
	if err = os.WriteFile(creds, []byte("cache:"+string(cache)+"\nhealth:"+string(health)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := New(filepath.Join(dir, "data"), creds, "instance-test", maxEntry, maxTotal)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func request(s *Server, method, path string, body []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer client-secret")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func route(key string) string { return "/v1/cache/" + key }
func expect(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status %d want %d: %s", w.Code, status, w.Body.String())
	}
}
func TestArtifactProtocolAndRestart(t *testing.T) {
	s := testServer(t, 1024, 16384)
	body := []byte{0, 255, 3, 10, 0, 17}
	expect(t, request(s, "GET", route("opaque.task-key"), nil), 404)
	expect(t, request(s, "PUT", route("opaque.task-key"), body), 200)
	for _, srv := range []*Server{s, func() *Server {
		restarted, err := New(s.root, s.credentials, s.namespace, s.maxEntry, s.maxTotal)
		if err != nil {
			t.Fatal(err)
		}
		return restarted
	}()} {
		w := request(srv, "GET", route("opaque.task-key"), nil)
		expect(t, w, 200)
		if w.Header().Get("Content-Length") != "6" || w.Header().Get("Content-Type") != "application/octet-stream" || !bytes.Equal(w.Body.Bytes(), body) {
			t.Fatal("binary roundtrip changed")
		}
	}
	expect(t, request(s, "PUT", route("opaque.task-key"), body), 409)
	expect(t, request(s, "PUT", route("opaque.task-key"), []byte("replacement")), 409)
	if !bytes.Equal(request(s, "GET", route("opaque.task-key"), nil).Body.Bytes(), body) {
		t.Fatal("overwritten")
	}
	expect(t, request(s, "HEAD", route("opaque.task-key"), nil), 405)
	expect(t, request(s, "POST", route("opaque.task-key"), nil), 405)
	expect(t, request(s, "GET", route("OPAQUE.task-key"), nil), 404)
}
func TestAuthenticationAndScope(t *testing.T) {
	s := testServer(t, 1024, 16384)
	for _, query := range []string{"namespace=other", "teamId=instance-test", "token=client-secret", "x=1&x=2"} {
		expect(t, request(s, "GET", route("k")+"?"+query, nil), 400)
	}
	for _, auth := range []string{"Bearer bad", "Bearer probe-secret", "Basic Y2FjaGU6Y2xpZW50LXNlY3JldA==", ""} {
		r := httptest.NewRequest("GET", route("k"), nil)
		r.Header.Set("Authorization", auth)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		expect(t, w, 401)
	}
	r := httptest.NewRequest("GET", route("k"), nil)
	r.SetBasicAuth("health", "probe-secret")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	expect(t, w, 401)
	r = httptest.NewRequest("GET", "/status", nil)
	r.SetBasicAuth("health", "probe-secret")
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	expect(t, w, 200)
	if !strings.Contains(w.Body.String(), `"namespace":"instance-test"`) {
		t.Fatal(w.Body.String())
	}
	expect(t, request(s, "GET", "/status", nil), 401)
	for _, path := range []string{"/v1/cache/../secret", "/v1/cache/a/b", "/artifacts/key", "/v1/cache/%2e%2e"} {
		w = request(s, "GET", path, nil)
		if w.Code != 400 && w.Code != 404 {
			t.Fatalf("unsafe path %q status%d", path, w.Code)
		}
	}
	if err := os.WriteFile(s.credentials, []byte("cache:malformed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	expect(t, request(s, "GET", route("k"), nil), 503)
}

type interrupted struct{ done bool }

func (r *interrupted) Read(p []byte) (int, error) {
	if !r.done {
		r.done = true
		copy(p, "abc")
		return 3, nil
	}
	return 0, io.ErrUnexpectedEOF
}
func (r *interrupted) Close() error { return nil }
func TestRejectedUploadsAreNeverPublished(t *testing.T) {
	s := testServer(t, 32, 16384)
	expect(t, request(s, "PUT", route("old"), []byte("original")), 200)
	cases := []struct {
		name   string
		body   io.ReadCloser
		length int64
		status int
	}{
		{"interrupted", &interrupted{}, 20, 400},
		{"short", io.NopCloser(strings.NewReader("abc")), 4, 400},
		{"long", io.NopCloser(strings.NewReader("abc")), 2, 400},
		{"unknown", io.NopCloser(strings.NewReader("abc")), -1, 411},
		{"large", io.NopCloser(strings.NewReader(strings.Repeat("a", 33))), 33, 413},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("PUT", route(c.name), nil)
			r.Body = c.body
			r.ContentLength = c.length
			r.Header.Set("Authorization", "Bearer client-secret")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			expect(t, w, c.status)
			expect(t, request(s, "GET", route(c.name), nil), 404)
		})
	}
	w := request(s, "GET", route("old"), nil)
	expect(t, w, 200)
	if w.Body.String() != "original" {
		t.Fatal("old changed")
	}
	files, _ := os.ReadDir(s.root)
	if len(files) != 1 {
		t.Fatal("staging leaked", files)
	}
}
func TestLRUAndConcurrentImmutableWrites(t *testing.T) {
	s := testServer(t, 32, 2*(headerSize+4))
	for _, k := range []string{"a", "b"} {
		expect(t, request(s, "PUT", route(k), []byte("data")), 200)
	}
	expect(t, request(s, "GET", route("a"), nil), 200)
	expect(t, request(s, "PUT", route("c"), []byte("data")), 200)
	expect(t, request(s, "GET", route("b"), nil), 404)
	var wg sync.WaitGroup
	codes := make(chan int, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes <- request(s, "PUT", route("concurrent"), []byte(fmt.Sprint(i))).Code
		}(i)
	}
	wg.Wait()
	close(codes)
	success := 0
	for c := range codes {
		if c == 200 {
			success++
		} else if c != 409 && c != 503 {
			t.Fatal(c)
		}
	}
	if success != 1 {
		t.Fatal(success)
	}
	s.mu.Lock()
	if s.used > s.maxTotal {
		t.Fatal("over budget")
	}
	s.mu.Unlock()
	if _, err := New(s.root, s.credentials, s.namespace, s.maxEntry, s.maxTotal); err != nil {
		t.Fatal(err)
	}
}
func TestCorruptionAndSymlinkRejected(t *testing.T) {
	s := testServer(t, 1024, 16384)
	expect(t, request(s, "PUT", route("key"), []byte("artifact")), 200)
	f, err := os.OpenFile(filepath.Join(s.root, filename("key")), os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.WriteAt([]byte("X"), headerSize)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	expect(t, request(s, "GET", route("key"), nil), 503)
	if _, err = New(s.root, s.credentials, s.namespace, s.maxEntry, s.maxTotal); err == nil {
		t.Fatal("corrupt restart accepted")
	}
	p := filepath.Join(s.root, filename("key"))
	os.Remove(p)
	if err = os.Symlink(s.credentials, p); err != nil {
		t.Fatal(err)
	}
	expect(t, request(s, "GET", route("key"), nil), 503)
	if _, err = New(s.root, s.credentials, s.namespace, s.maxEntry, s.maxTotal); err == nil {
		t.Fatal("symlink accepted")
	}
	link := filepath.Join(filepath.Dir(s.root), "link")
	if err = os.Symlink(s.root, link); err != nil {
		t.Fatal(err)
	}
	if _, err = New(link, s.credentials, s.namespace, s.maxEntry, s.maxTotal); err == nil {
		t.Fatal("symlink root accepted")
	}
}
func TestHTTPTransportRoundtrip(t *testing.T) {
	s := testServer(t, 1024, 16384)
	ts := httptest.NewServer(s)
	defer ts.Close()
	req, err := http.NewRequest("PUT", ts.URL+route("binary"), bytes.NewReader([]byte{0, 255, 1}))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer client-secret")
	res, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(res.Status)
	}
	req, _ = http.NewRequest("GET", ts.URL+route("binary"), nil)
	req.Header.Set("Authorization", "Bearer client-secret")
	res, err = ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil || !bytes.Equal(body, []byte{0, 255, 1}) || res.ContentLength != 3 {
		t.Fatal("HTTP bytes or length changed")
	}
}

type blockingWriter struct {
	header           http.Header
	started, release chan struct{}
}

func (w *blockingWriter) Header() http.Header { return w.header }
func (w *blockingWriter) WriteHeader(int)     {}
func (w *blockingWriter) Write(p []byte) (int, error) {
	close(w.started)
	<-w.release
	return len(p), nil
}
func TestActiveReadRemainsAccountedDuringEviction(t *testing.T) {
	s := testServer(t, 32, headerSize+32)
	expect(t, request(s, "PUT", route("first"), []byte("payload")), 200)
	w := &blockingWriter{header: make(http.Header), started: make(chan struct{}), release: make(chan struct{})}
	r := httptest.NewRequest("GET", route("first"), nil)
	r.Header.Set("Authorization", "Bearer client-secret")
	readDone := make(chan struct{})
	go func() { s.ServeHTTP(w, r); close(readDone) }()
	<-w.started
	putDone := make(chan int, 1)
	go func() { putDone <- request(s, "PUT", route("second"), []byte("new")).Code }()
	select {
	case <-putDone:
		t.Fatal("evicted active reader")
	case <-time.After(50 * time.Millisecond):
	}
	close(w.release)
	<-readDone
	if code := <-putDone; code != 200 {
		t.Fatal(code)
	}
	expect(t, request(s, "GET", route("first"), nil), 404)
}
func TestFIFOAndDuplicateAuthorization(t *testing.T) {
	s := testServer(t, 1024, 16384)
	r := httptest.NewRequest("GET", route("key"), nil)
	r.Header.Add("Authorization", "Bearer client-secret")
	r.Header.Add("Authorization", "Bearer client-secret")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	expect(t, w, 401)
	if err := syscall.Mkfifo(filepath.Join(s.root, filename("fifo")), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(s.root, s.credentials, s.namespace, s.maxEntry, s.maxTotal); err == nil {
		t.Fatal("FIFO accepted")
	}
}

func TestTokenBoundInstanceIsolationAndPlainErrors(t *testing.T) {
	first := testServer(t, 1024, 16384)
	second := testServer(t, 1024, 16384)
	second.namespace = "second-instance"
	hash, err := bcrypt.GenerateFromPassword([]byte("second-secret"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(second.credentials, []byte("cache:"+string(hash)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	expect(t, request(first, "PUT", route("same-hash"), []byte("first")), 200)
	w := request(second, "GET", route("same-hash"), nil)
	expect(t, w, 401)
	if w.Header().Get("Content-Type") != "text/plain" {
		t.Fatal("Nx's 401 decoder requires exact text/plain")
	}
	if strings.Contains(w.Body.String(), "secret") {
		t.Fatal("credential leaked")
	}
	for _, method := range []string{"GET", "PUT"} {
		r := httptest.NewRequest(method, route("same-hash"), strings.NewReader("second"))
		r.Header.Set("Authorization", "Bearer second-secret")
		denied := httptest.NewRecorder()
		first.ServeHTTP(denied, r)
		expect(t, denied, 401)
		r = httptest.NewRequest(method, route("same-hash"), strings.NewReader("second"))
		r.Header.Set("Authorization", "Bearer second-secret")
		own := httptest.NewRecorder()
		second.ServeHTTP(own, r)
		want := 404
		if method == "PUT" {
			want = 200
		}
		expect(t, own, want)
	}
	if request(first, "GET", route("same-hash"), nil).Body.String() != "first" {
		t.Fatal("cross-instance corruption")
	}
}

func TestUploadQueueIsBoundedAndCancellable(t *testing.T) {
	s := testServer(t, 1024, 16384)
	for i := 0; i < cap(s.pendingUploads); i++ {
		s.pendingUploads <- struct{}{}
	}
	expect(t, request(s, "PUT", route("full"), []byte("body")), 503)
	for i := 0; i < cap(s.pendingUploads); i++ {
		<-s.pendingUploads
	}
	s.uploadSlot <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest("PUT", route("canceled"), strings.NewReader("body")).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer client-secret")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	expect(t, w, 408)
	<-s.uploadSlot
	expect(t, request(s, "GET", route("canceled"), nil), 404)
	if len(s.pendingUploads) != 0 {
		t.Fatal("admission slot leaked")
	}
	expect(t, request(s, "PUT", route("after"), []byte("body")), 200)
}
