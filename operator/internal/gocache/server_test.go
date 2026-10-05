package gocache

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"golang.org/x/crypto/bcrypt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const action = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const output = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func fixture(t *testing.T, readonly bool, budget int64) *Server {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	auth := filepath.Join(dir, "htpasswd")
	hash, _ := bcrypt.GenerateFromPassword([]byte("fixture-token"), bcrypt.MinCost)
	healthHash, _ := bcrypt.GenerateFromPassword([]byte("health-token"), bcrypt.MinCost)
	if err = os.WriteFile(auth, []byte("cache:"+string(hash)+"\nhealth:"+string(healthHash)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := New(filepath.Join(dir, "data"), auth, "instance", 1024, budget, readonly)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func putRequest(key string, body []byte) *http.Request {
	r := httptest.NewRequest("PUT", "/cache/"+key, bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fixture-token")
	md := md5.Sum(body)
	sha := sha256.Sum256(body)
	r.Header.Set("X-Cacheprog-OutputID", output)
	r.Header.Set("X-Cacheprog-MD5Sum", hex.EncodeToString(md[:]))
	r.Header.Set("X-Cacheprog-Sha256Sum", hex.EncodeToString(sha[:]))
	r.Header.Set("X-Cacheprog-CompressionAlgorithm", "")
	r.Header.Set("X-Cacheprog-UncompressedSize", strconv.Itoa(len(body)))
	return r
}
func invoke(s *Server, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func getRequest(key string) *http.Request {
	r := httptest.NewRequest("GET", "/cache/"+key, nil)
	r.Header.Set("Authorization", "Bearer fixture-token")
	return r
}
func TestWireContractAndAtomicReplacement(t *testing.T) {
	s := fixture(t, false, 65536)
	if w := invoke(s, getRequest(action)); w.Code != 404 {
		t.Fatal(w.Code)
	}
	for _, body := range [][]byte{nil, {0, 255, 1}, []byte("replacement")} {
		if w := invoke(s, putRequest(action, body)); w.Code != 200 {
			t.Fatalf("PUT %d %s", w.Code, w.Body)
		}
		w := invoke(s, getRequest(action))
		if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), body) {
			t.Fatal("roundtrip", w.Code)
		}
		if w.Header().Get("X-Cacheprog-OutputID") != output || w.Header().Get("Content-Length") != strconv.Itoa(len(body)) || w.Header().Get("X-Cacheprog-UncompressedSize") != strconv.Itoa(len(body)) {
			t.Fatal("lost metadata")
		}
		if _, e := time.Parse(http.TimeFormat, w.Header().Get("Last-Modified")); e != nil {
			t.Fatal(e)
		}
		if w.Header().Get("Content-Encoding") != "" {
			t.Fatal("protocol metadata is not content encoding")
		}
	}
	bad := putRequest(action, []byte("bad"))
	bad.Header.Set("X-Cacheprog-Sha256Sum", strings.Repeat("0", 64))
	if invoke(s, bad).Code != 400 || invoke(s, getRequest(action)).Body.String() != "replacement" {
		t.Fatal("failed replacement damaged retained object")
	}
	// zstd is opaque transport data: metadata and compressed bytes survive together.
	compressed := []byte{0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3}
	p := putRequest(action, compressed)
	p.Header.Set("X-Cacheprog-CompressionAlgorithm", "zstd")
	p.Header.Set("X-Cacheprog-UncompressedSize", "900")
	if w := invoke(s, p); w.Code != 200 {
		t.Fatal(w.Code)
	}
	recovered, err := New(s.root, s.credentials, s.namespace, 1024, 65536, false)
	if err != nil {
		t.Fatal(err)
	}
	w := invoke(recovered, getRequest(action))
	if !bytes.Equal(w.Body.Bytes(), compressed) || w.Header().Get("X-Cacheprog-CompressionAlgorithm") != "zstd" || w.Header().Get("X-Cacheprog-UncompressedSize") != "900" {
		t.Fatal("recovery metadata")
	}
}
func TestRejectedMetadataAndPaths(t *testing.T) {
	s := fixture(t, false, 65536)
	cases := []struct {
		name   string
		change func(*http.Request)
		code   int
	}{
		{"no token", func(r *http.Request) { r.Header.Del("Authorization") }, 401},
		{"wrong token", func(r *http.Request) { r.Header.Set("Authorization", "Bearer other") }, 401},
		{"duplicate token", func(r *http.Request) { r.Header.Add("Authorization", "Bearer fixture-token") }, 401},
		{"health token", func(r *http.Request) { r.SetBasicAuth("health", "health-token") }, 401},
		{"unknown length", func(r *http.Request) { r.ContentLength = -1 }, 411},
		{"oversize", func(r *http.Request) { r.ContentLength = 1025 }, 413},
		{"short body", func(r *http.Request) { r.ContentLength = 9 }, 400},
		{"long body", func(r *http.Request) { r.ContentLength = 2; r.Header.Set("X-Cacheprog-UncompressedSize", "2") }, 400},
		{"digest", func(r *http.Request) { r.Header.Set("X-Cacheprog-Sha256Sum", strings.Repeat("0", 64)) }, 400},
		{"md5", func(r *http.Request) { r.Header.Set("X-Cacheprog-MD5Sum", strings.Repeat("0", 32)) }, 400},
		{"duplicate metadata", func(r *http.Request) { r.Header.Add("X-Cacheprog-OutputID", output) }, 400},
		{"missing compression", func(r *http.Request) { r.Header.Del("X-Cacheprog-CompressionAlgorithm") }, 400},
		{"unknown compression", func(r *http.Request) { r.Header.Set("X-Cacheprog-CompressionAlgorithm", "gzip") }, 400},
		{"negative size", func(r *http.Request) { r.Header.Set("X-Cacheprog-UncompressedSize", "-1") }, 400},
		{"raw size", func(r *http.Request) { r.Header.Set("X-Cacheprog-UncompressedSize", "9") }, 400},
		{"decompressed limit", func(r *http.Request) {
			r.Header.Set("X-Cacheprog-CompressionAlgorithm", "zstd")
			r.Header.Set("X-Cacheprog-UncompressedSize", "1025")
		}, 413},
		{"content encoding", func(r *http.Request) { r.Header.Set("Content-Encoding", "gzip") }, 400},
		{"path", func(r *http.Request) { r.URL.Path = "/cache/../outside" }, 404},
		{"query", func(r *http.Request) { r.URL.RawQuery = "tenant=other" }, 400},
		{"encoded path", func(r *http.Request) { r.URL.RawPath = "/cache/%61" + action[1:] }, 400},
		{"uppercase", func(r *http.Request) { r.URL.Path = "/cache/" + strings.ToUpper(action) }, 404},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := putRequest(action, []byte("abc"))
			tc.change(r)
			w := invoke(s, r)
			if w.Code != tc.code {
				t.Fatalf("got %d expected %d: %s", w.Code, tc.code, w.Body)
			}
		})
	}
	if len(s.entries) != 0 || s.used != 0 {
		t.Fatal("rejected requests retained data")
	}
}
func TestReadonlyAndCredentialIsolation(t *testing.T) {
	s := fixture(t, false, 65536)
	if invoke(s, putRequest(action, []byte("ok"))).Code != 200 {
		t.Fatal("seed")
	}
	healthBearer := getRequest(action)
	healthBearer.Header.Set("Authorization", "Bearer health-token")
	if invoke(s, healthBearer).Code != 401 {
		t.Fatal("health credential used as cache token")
	}
	ro, e := New(s.root, s.credentials, s.namespace, 1024, 65536, true)
	if e != nil {
		t.Fatal(e)
	}
	if invoke(ro, putRequest(action, []byte("changed"))).Code != 403 || invoke(ro, getRequest(action)).Body.String() != "ok" {
		t.Fatal("readonly is not server enforced")
	}
	r := httptest.NewRequest("GET", "/status", nil)
	r.SetBasicAuth("health", "health-token")
	if w := invoke(ro, r); w.Code != 200 || !strings.Contains(w.Body.String(), `"readOnly":true`) {
		t.Fatal("policy status", w.Code)
	}
	if invoke(ro, getRequest("status")).Code != 404 {
		t.Fatal("route")
	}
	other := fixture(t, false, 65536)
	hash, _ := bcrypt.GenerateFromPassword([]byte("other-instance"), bcrypt.MinCost)
	os.WriteFile(other.credentials, []byte("cache:"+string(hash)+"\n"), 0600)
	if invoke(other, getRequest(action)).Code != 401 {
		t.Fatal("cross-instance credential accepted")
	}
	hash, _ = bcrypt.GenerateFromPassword([]byte("rotated"), bcrypt.MinCost)
	os.WriteFile(s.credentials, []byte("cache:"+string(hash)+"\n"), 0600)
	if invoke(ro, getRequest(action)).Code != 401 {
		t.Fatal("credential rotation not applied")
	}
}
func TestEvictionCorruptionAndAdmission(t *testing.T) {
	s := fixture(t, false, 2*(headerSize+3))
	k2 := strings.Repeat("c", 64)
	k3 := strings.Repeat("d", 64)
	for _, k := range []string{action, k2, k3} {
		if w := invoke(s, putRequest(k, []byte("abc"))); w.Code != 200 {
			t.Fatal(w.Code)
		}
	}
	if s.used > s.maxTotal || len(s.entries) != 2 || invoke(s, getRequest(action)).Code != 404 {
		t.Fatal("LRU budget")
	}
	f, e := os.OpenFile(filepath.Join(s.root, filename(k3)), os.O_WRONLY, 0600)
	if e != nil {
		t.Fatal(e)
	}
	f.WriteAt([]byte("bad"), headerSize)
	f.Close()
	if invoke(s, getRequest(k3)).Code != 503 {
		t.Fatal("corruption served")
	}
	if _, e = New(s.root, s.credentials, s.namespace, 1024, s.maxTotal, false); e == nil {
		t.Fatal("corruption recovered")
	}
	s2 := fixture(t, false, 65536)
	for i := 0; i < cap(s2.requests); i++ {
		s2.requests <- struct{}{}
	}
	if invoke(s2, getRequest(action)).Code != 503 {
		t.Fatal("request admission")
	}
	for len(s2.requests) > 0 {
		<-s2.requests
	}
	for i := 0; i < cap(s2.pendingUploads); i++ {
		s2.pendingUploads <- struct{}{}
	}
	if invoke(s2, putRequest(action, nil)).Code != 503 {
		t.Fatal("upload admission")
	}
}
func TestConcurrentReplacementAndRealHTTP(t *testing.T) {
	s := fixture(t, false, 65536)
	server := httptest.NewServer(s)
	defer server.Close()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r := putRequest(action, []byte(fmt.Sprintf("value%d", i)))
			r.URL.Scheme = "http"
			r.URL.Host = strings.TrimPrefix(server.URL, "http://")
			r.RequestURI = ""
			response, e := server.Client().Do(r)
			if e != nil {
				t.Error(e)
				return
			}
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode != 200 {
				t.Error(response.StatusCode)
			}
		}(i)
	}
	wg.Wait()
	if len(s.entries) != 1 || s.used != headerSize+6 {
		t.Fatal("overwrite accounting", s.used)
	}
	r := getRequest(action)
	r.URL.Scheme = "http"
	r.URL.Host = strings.TrimPrefix(server.URL, "http://")
	r.RequestURI = ""
	response, e := server.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != 200 || len(body) != 6 {
		t.Fatal("real HTTP GET")
	}
}

func TestCancelledUploadAndSymlinkRecovery(t *testing.T) {
	s := fixture(t, false, 65536)
	s.uploadSlot <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if w := invoke(s, putRequest(action, nil).WithContext(ctx)); w.Code != 408 {
		t.Fatal("cancel", w.Code)
	}
	<-s.uploadSlot
	outside := filepath.Join(filepath.Dir(s.root), "outside")
	if err := os.WriteFile(outside, []byte("never read"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(s.root, filename(action))); err != nil {
		t.Fatal(err)
	}
	if _, err := New(s.root, s.credentials, s.namespace, 1024, 65536, false); err == nil {
		t.Fatal("followed symlink")
	}
}
