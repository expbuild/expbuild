package controller

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"
)

// Generate reproducible incompressible blobs without retaining hundreds of MiB
// in test memory. This exercises the normal compressed storage configuration.
type zeroSource struct{}

func (zeroSource) Read(p []byte) (int, error) { clear(p); return len(p), nil }
func verifyRealLRU(t *testing.T, address, username string) {
	t.Helper()
	const size int64 = 400 * 1024 * 1024
	stream := func(seed byte) io.Reader {
		key := make([]byte, 32)
		key[0] = seed
		block, err := aes.NewCipher(key)
		if err != nil {
			t.Fatal(err)
		}
		return io.LimitReader(&cipher.StreamReader{S: cipher.NewCTR(block, make([]byte, aes.BlockSize)), R: zeroSource{}}, size)
	}
	client := &http.Client{Timeout: 120 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	call := func(method, path string, body io.Reader, length int64) *http.Response {
		t.Helper()
		req, err := http.NewRequest(method, "http://"+address+path, body)
		if err != nil {
			t.Fatal(err)
		}
		req.ContentLength = length
		req.SetBasicAuth(username, "engine-test-only")
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	upload := func(seed byte) string {
		t.Helper()
		hash := sha256.New()
		n, err := io.Copy(hash, stream(seed))
		if err != nil || n != size {
			t.Fatalf("hash stream: %d %v", n, err)
		}
		digest := fmt.Sprintf("%x", hash.Sum(nil))
		response := call(http.MethodPut, "/cas/"+digest, stream(seed), size)
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
			t.Fatalf("large upload: %d %s", response.StatusCode, body)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		return digest
	}
	read := func(digest string) {
		t.Helper()
		response := call(http.MethodGet, "/cas/"+digest, nil, 0)
		defer response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatalf("retained blob returned %d", response.StatusCode)
		}
		hash := sha256.New()
		n, err := io.Copy(hash, response.Body)
		if err != nil || n != size || fmt.Sprintf("%x", hash.Sum(nil)) != digest {
			t.Fatalf("retained blob integrity failed: %d %v", n, err)
		}
	}
	a, b := upload(1), upload(2)
	read(a) // Make A newer than B before exceeding the 1 GiB engine budget.
	c := upload(3)
	missing := call(http.MethodGet, "/cas/"+b, nil, 0)
	_, _ = io.Copy(io.Discard, missing.Body)
	_ = missing.Body.Close()
	if missing.StatusCode != 404 {
		t.Fatalf("least recently used blob was not evicted: %d", missing.StatusCode)
	}
	read(a)
	read(c)
	response := call(http.MethodGet, "/status", nil, 0)
	defer response.Body.Close()
	var state struct{ CurrSize, MaxSize, NumFiles int64 }
	if response.StatusCode != 200 {
		t.Fatalf("status returned %d", response.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&state); err != nil {
		t.Fatal(err)
	}
	if state.MaxSize != 1<<30 || state.CurrSize > state.MaxSize || state.CurrSize < 2*size || state.NumFiles != 2 {
		t.Fatalf("unexpected eviction accounting: %+v", state)
	}
	t.Log("1 GiB budget: three incompressible 400 MiB blobs, read refresh, LRU eviction and retained data integrity verified")
}
