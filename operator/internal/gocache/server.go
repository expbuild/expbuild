// Package gocache implements the experimental cacheprog v1.3.0 HTTP contract.
// Keys are opaque identifiers, never content digests. One process owns a PVC.
package gocache

import (
	"crypto/md5"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const headerSize int64 = 4096

type artifact struct {
	Key              string `json:"key"`
	Size             int64  `json:"size"`
	Digest           string `json:"digest"`
	MD5              string `json:"md5"`
	OutputID         string `json:"outputId"`
	Compression      string `json:"compression"`
	UncompressedSize int64  `json:"uncompressedSize"`
	Modified         int64  `json:"modified"`
	accessed         time.Time
}

type Server struct {
	root, credentials, namespace string
	readOnly                     bool
	requests                     chan struct{}
	maxEntry, maxTotal, used     int64
	mu                           sync.Mutex
	uploadSlot                   chan struct{} // At most one staging file.
	pendingUploads               chan struct{} // Bounded admission prevents an unlimited upload queue.
	entries                      map[string]artifact
}

func validKey(key string) bool { return validHex(key, 32) }
func validHex(value string, size int) bool {
	if len(value) != size*2 || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
func validMetadata(a artifact) bool {
	return validKey(a.Key) && validHex(a.OutputID, 32) && validHex(a.Digest, 32) && validHex(a.MD5, 16) && a.Modified > 0 && a.UncompressedSize >= 0 && (a.Compression == "zstd" || a.Compression == "" && a.UncompressedSize == a.Size)
}
func filename(key string) string {
	d := sha256.Sum256([]byte(key))
	return hex.EncodeToString(d[:]) + ".entry"
}

// New recovers only complete envelopes. Disk capacity includes envelope metadata;
// a single in-flight upload may additionally consume maxEntry + headerSize bytes.
func New(root, credentials, namespace string, maxEntry, maxTotal int64, readOnly bool) (*Server, error) {
	if maxEntry <= 0 || maxTotal <= headerSize || maxEntry > maxTotal-headerSize || (namespace == "" || len(namespace) > 63 || strings.ContainsAny(namespace, "/\\")) {
		return nil, fmt.Errorf("invalid cache budget or namespace")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(abs, 0700); err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	// macOS /var is a system symlink; callers must supply its canonical path.
	if resolved != abs {
		return nil, fmt.Errorf("cache root must not contain symlinks")
	}
	s := &Server{readOnly: readOnly, requests: make(chan struct{}, 64), root: abs, credentials: credentials, namespace: namespace, maxEntry: maxEntry, maxTotal: maxTotal, entries: map[string]artifact{}, uploadSlot: make(chan struct{}, 1), pendingUploads: make(chan struct{}, 16)}
	items, err := os.ReadDir(abs)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		p := filepath.Join(abs, item.Name())
		if strings.HasPrefix(item.Name(), ".upload-") && item.Type().IsRegular() {
			if err = os.Remove(p); err != nil {
				return nil, err
			}
			continue
		}
		if !strings.HasSuffix(item.Name(), ".entry") || !item.Type().IsRegular() {
			return nil, fmt.Errorf("unexpected cache file %s", item.Name())
		}
		f, a, e := readArtifact(p)
		if f != nil {
			f.Close()
		}
		if e != nil || filename(a.Key) != item.Name() || a.Size > maxEntry || a.UncompressedSize > maxEntry {
			return nil, fmt.Errorf("invalid stored artifact %s", item.Name())
		}
		s.entries[a.Key] = a
		s.used += a.Size + headerSize
	}
	if err = s.evictLocked(0, "", false); err != nil {
		return nil, err
	}
	return s, nil
}

func readArtifact(path string) (*os.File, artifact, error) {
	var a artifact
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, a, err
	}
	f := os.NewFile(uintptr(fd), path)
	fail := func(e error) (*os.File, artifact, error) { f.Close(); return nil, a, e }
	info, err := f.Stat()
	if err != nil {
		return fail(err)
	}
	if !info.Mode().IsRegular() {
		return fail(fmt.Errorf("not regular"))
	}
	buf := make([]byte, headerSize)
	if _, err = io.ReadFull(f, buf); err != nil {
		return fail(err)
	}
	n := binary.BigEndian.Uint32(buf[:4])
	if n == 0 || n > uint32(headerSize-4) {
		return fail(fmt.Errorf("invalid header"))
	}
	if err = json.Unmarshal(buf[4:4+n], &a); err != nil {
		return fail(err)
	}
	if !validMetadata(a) || a.Size < 0 || a.Size != info.Size()-headerSize {
		return fail(fmt.Errorf("invalid size"))
	}
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return fail(err)
	}
	if hex.EncodeToString(h.Sum(nil)) != a.Digest {
		return fail(fmt.Errorf("corrupt artifact"))
	}
	if _, err = f.Seek(headerSize, io.SeekStart); err != nil {
		return fail(err)
	}
	a.accessed = info.ModTime()
	return f, a, nil
}
func apiError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "text/plain")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
	_, _ = io.WriteString(w, message+"\n")
}

// Authentication reuses only the cache identity's bcrypt password as a Bearer
// token. Basic health credentials are restricted to operational status.
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request, probe bool) bool {
	f, err := os.Open(s.credentials)
	if err != nil {
		apiError(w, 503, "credentials unavailable")
		return false
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil || len(data) > 4096 {
		apiError(w, 503, "credentials unavailable")
		return false
	}
	hashes := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		p := strings.Split(line, ":")
		if len(p) != 2 || (p[0] != "cache" && p[0] != "health") || hashes[p[0]] != "" {
			apiError(w, 503, "credentials unavailable")
			return false
		}
		if _, err = bcrypt.Cost([]byte(p[1])); err != nil {
			apiError(w, 503, "credentials unavailable")
			return false
		}
		hashes[p[0]] = p[1]
	}
	var password, hash string
	if len(r.Header.Values("Authorization")) != 1 {
		apiError(w, 401, "authentication required")
		return false
	}
	if probe {
		u, p, ok := r.BasicAuth()
		if ok && u == "health" {
			password = p
			hash = hashes[u]
		}
	} else {
		parts := strings.Split(r.Header.Get("Authorization"), " ")
		if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
			password = parts[1]
			hash = hashes["cache"]
		}
	}
	if hash == "" || password == "" || len(password) > 72 || bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		apiError(w, 401, "authentication required")
		return false
	}
	return true
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	select {
	case s.requests <- struct{}{}:
		defer func() { <-s.requests }()
	default:
		apiError(w, 503, "request limit reached")
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path == "/status" && r.URL.RawQuery == "" {
		if !s.authenticate(w, r, true) {
			return
		}
		if r.Method != "GET" {
			apiError(w, 405, "GET required")
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"sizeBytes": s.used, "capacityBytes": s.maxTotal, "entries": len(s.entries), "namespace": s.namespace, "readOnly": s.readOnly})
		return
	}
	if !s.authenticate(w, r, false) {
		return
	}
	// Each process/PVC and its credential belong to one instance. Caller hashes
	// and query parameters never select the authorization namespace.
	if r.URL.RawQuery != "" || r.URL.RawPath != "" {
		apiError(w, 400, "query parameters and encoded paths unsupported")
		return
	}
	path := r.URL.Path
	key := strings.TrimPrefix(path, "/cache/")
	if key == path || !validKey(key) {
		apiError(w, 404, "not found")
		return
	}
	switch r.Method {
	case "GET":
		s.get(w, r, key)
	case "PUT":
		if s.readOnly {
			apiError(w, 403, "cache is read-only")
			return
		}
		s.put(w, r, key)
	default:
		w.Header().Set("Allow", "GET, PUT")
		apiError(w, 405, "method not allowed")
	}
}
func (s *Server) get(w http.ResponseWriter, r *http.Request, key string) {
	s.mu.Lock()
	a, ok := s.entries[key]
	if !ok {
		s.mu.Unlock()
		apiError(w, 404, "artifact not found")
		return
	}
	p := filepath.Join(s.root, filename(key))
	f, current, err := readArtifact(p)
	if err != nil || !sameArtifact(current, a) {
		if f != nil {
			f.Close()
		}
		s.mu.Unlock()
		apiError(w, 503, "artifact unavailable")
		return
	}
	now := time.Now()
	a.accessed = now
	s.entries[key] = a
	_ = os.Chtimes(p, now, now)
	// Keep reader bytes accounted until the socket copy completes. Otherwise
	// eviction could unlink open files and hide unlimited retained disk usage.
	defer s.mu.Unlock()
	defer f.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(a.Size, 10))
	w.Header().Set("Last-Modified", time.Unix(a.Modified, 0).UTC().Format(http.TimeFormat))
	w.Header().Set("X-Cacheprog-OutputID", a.OutputID)
	w.Header().Set("X-Cacheprog-CompressionAlgorithm", a.Compression)
	w.Header().Set("X-Cacheprog-UncompressedSize", strconv.FormatInt(a.UncompressedSize, 10))
	w.Header().Set("X-Cacheprog-MD5Sum", a.MD5)
	w.Header().Set("X-Cacheprog-Sha256Sum", a.Digest)
	w.WriteHeader(200)
	if r.Method == "GET" {
		_, _ = io.Copy(w, f)
	}
}
func (s *Server) put(w http.ResponseWriter, r *http.Request, key string) {
	if r.ContentLength < 0 {
		apiError(w, 411, "Content-Length required")
		return
	}
	if r.ContentLength > s.maxEntry {
		apiError(w, 413, "artifact too large")
		return
	}
	a := artifact{Key: key, Size: r.ContentLength, Modified: time.Now().Unix()}
	for _, h := range []string{"X-Cacheprog-OutputID", "X-Cacheprog-MD5Sum", "X-Cacheprog-Sha256Sum", "X-Cacheprog-CompressionAlgorithm", "X-Cacheprog-UncompressedSize"} {
		if len(r.Header.Values(h)) != 1 {
			apiError(w, 400, "metadata required exactly once")
			return
		}
	}
	a.OutputID = r.Header.Get("X-Cacheprog-OutputID")
	a.MD5 = r.Header.Get("X-Cacheprog-MD5Sum")
	a.Digest = r.Header.Get("X-Cacheprog-Sha256Sum")
	a.Compression = r.Header.Get("X-Cacheprog-CompressionAlgorithm")
	var metadataError error
	a.UncompressedSize, metadataError = strconv.ParseInt(r.Header.Get("X-Cacheprog-UncompressedSize"), 10, 64)
	if metadataError != nil || !validMetadata(a) {
		apiError(w, 400, "invalid metadata")
		return
	}
	if a.UncompressedSize > s.maxEntry {
		apiError(w, 413, "uncompressed artifact too large")
		return
	}
	if r.Header.Get("Content-Encoding") != "" {
		apiError(w, 400, "content encoding unsupported")
		return
	}
	select {
	case s.pendingUploads <- struct{}{}:
		defer func() { <-s.pendingUploads }()
	default:
		apiError(w, 503, "upload queue full; retry later")
		return
	}
	timer := time.NewTimer(5 * time.Minute)
	defer timer.Stop()
	select {
	case s.uploadSlot <- struct{}{}:
		defer func() { <-s.uploadSlot }()
	case <-r.Context().Done():
		apiError(w, 408, "upload canceled")
		return
	case <-timer.C:
		apiError(w, 503, "upload wait timed out")
		return
	}
	tmp, err := os.CreateTemp(s.root, ".upload-")
	if err != nil {
		apiError(w, 503, "storage unavailable")
		return
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if _, err = tmp.Write(make([]byte, headerSize)); err != nil {
		apiError(w, 503, "storage unavailable")
		return
	}
	h := sha256.New()
	md := md5.New() // Required wire checksum, not an authentication primitive.
	n, err := io.Copy(io.MultiWriter(tmp, h, md), io.LimitReader(r.Body, r.ContentLength+1))
	if err != nil || n != r.ContentLength {
		apiError(w, 400, "incomplete artifact")
		return
	}
	a.Size = n
	if a.Digest != hex.EncodeToString(h.Sum(nil)) || a.MD5 != hex.EncodeToString(md.Sum(nil)) {
		apiError(w, 400, "wire checksum mismatch")
		return
	}
	a.accessed = time.Now()
	metadata, err := json.Marshal(a)
	if err != nil || len(metadata) > int(headerSize)-4 {
		apiError(w, 400, "metadata too large")
		return
	}
	buf := make([]byte, headerSize)
	binary.BigEndian.PutUint32(buf[:4], uint32(len(metadata)))
	copy(buf[4:], metadata)
	if _, err = tmp.WriteAt(buf, 0); err != nil {
		apiError(w, 503, "storage unavailable")
		return
	}
	if err = tmp.Sync(); err != nil {
		apiError(w, 503, "storage unavailable")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Replace the complete envelope atomically, including metadata. Keep the
	// previous key visible until rename; failed admission never truncates it.
	old, exists := s.entries[key]
	incoming := a.Size + headerSize
	if exists {
		incoming -= old.Size + headerSize
	}
	if incoming < 0 {
		incoming = 0
	}
	if err = s.evictLocked(incoming, key, !exists); err != nil {
		apiError(w, 503, "storage unavailable")
		return
	}
	if err = os.Rename(tmp.Name(), filepath.Join(s.root, filename(key))); err != nil {
		apiError(w, 503, "storage unavailable")
		return
	}
	if exists {
		s.used -= old.Size + headerSize
	}
	s.entries[key] = a
	s.used += a.Size + headerSize
	dir, e := os.Open(s.root)
	if e == nil {
		e = dir.Sync()
		dir.Close()
	}
	if e != nil {
		// The new envelope is already published; retain accurate accounting.
		apiError(w, 503, "storage unavailable")
		return
	}
	w.WriteHeader(200)
}
func (s *Server) evictLocked(incoming int64, keep string, adding bool) error {
	keys := make([]string, 0, len(s.entries))
	for key := range s.entries {
		if key != keep {
			keys = append(keys, key)
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := s.entries[keys[i]], s.entries[keys[j]]
		if a.accessed.Equal(b.accessed) {
			return keys[i] < keys[j]
		}
		return a.accessed.Before(b.accessed)
	})
	for _, key := range keys {
		if s.used <= s.maxTotal-incoming && (len(s.entries) < 10000 || !adding && len(s.entries) <= 10000) {
			return nil
		}
		if err := os.Remove(filepath.Join(s.root, filename(key))); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		s.used -= s.entries[key].Size + headerSize
		delete(s.entries, key)
	}
	if s.used > s.maxTotal-incoming {
		return fmt.Errorf("capacity exceeded")
	}
	return nil
}

func sameArtifact(a, b artifact) bool {
	return a.Key == b.Key && a.Size == b.Size && a.Digest == b.Digest && a.MD5 == b.MD5 && a.OutputID == b.OutputID && a.Compression == b.Compression && a.UncompressedSize == b.UncompressedSize && a.Modified == b.Modified
}
