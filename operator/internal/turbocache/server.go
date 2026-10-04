// Package turbocache implements the experimental Turborepo v8 artifact API.
// Keys are opaque identifiers, never content digests. One process owns a PVC.
package turbocache

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
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
	Key       string `json:"key"`
	Size      int64  `json:"size"`
	Digest    string `json:"digest"`
	Duration  string `json:"duration"`
	Tag       string `json:"tag,omitempty"`
	SHA       string `json:"sha,omitempty"`
	DirtyHash string `json:"dirtyHash,omitempty"`
	accessed  time.Time
}

type Server struct {
	root, credentials, team  string
	maxEntry, maxTotal, used int64
	mu                       sync.Mutex
	uploadMu                 sync.Mutex // One bounded staging file, independent of readers.
	entries                  map[string]artifact
}

func validKey(key string) bool {
	if len(key) == 0 || len(key) > 256 || key == "." || key == ".." {
		return false
	}
	for _, c := range key {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	return true
}
func filename(key string) string {
	d := sha256.Sum256([]byte(key))
	return hex.EncodeToString(d[:]) + ".entry"
}

// New recovers only complete envelopes. Disk capacity includes envelope metadata;
// a single in-flight upload may additionally consume maxEntry + headerSize bytes.
func New(root, credentials, team string, maxEntry, maxTotal int64) (*Server, error) {
	if maxEntry <= 0 || maxTotal <= headerSize || maxEntry > maxTotal-headerSize || !strings.HasPrefix(team, "team_") || !validKey(team) {
		return nil, fmt.Errorf("invalid cache budget or team")
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
	s := &Server{root: abs, credentials: credentials, team: team, maxEntry: maxEntry, maxTotal: maxTotal, entries: map[string]artifact{}}
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
		if e != nil || filename(a.Key) != item.Name() || a.Size > maxEntry {
			return nil, fmt.Errorf("invalid stored artifact %s", item.Name())
		}
		s.entries[a.Key] = a
		s.used += a.Size + headerSize
	}
	if err = s.evictLocked(0); err != nil {
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
	if !validKey(a.Key) || a.Size < 0 || a.Size != info.Size()-headerSize {
		return fail(fmt.Errorf("invalid size"))
	}
	if _, err = strconv.ParseUint(a.Duration, 10, 64); err != nil {
		return fail(err)
	}
	for _, v := range []string{a.Tag, a.SHA, a.DirtyHash} {
		if !safeMetadata(v) {
			return fail(fmt.Errorf("invalid metadata"))
		}
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
func safeMetadata(v string) bool {
	if len(v) > 512 {
		return false
	}
	for _, c := range v {
		if c < 32 || c > 126 {
			return false
		}
	}
	return true
}
func apiError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"error": map[string]string{"code": http.StatusText(code), "message": message}})
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
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"sizeBytes": s.used, "capacityBytes": s.maxTotal, "entries": len(s.entries), "team": s.team})
		return
	}
	if !s.authenticate(w, r, false) {
		return
	}
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(q) != 1 || len(q["teamId"]) != 1 || q.Get("teamId") != s.team {
		apiError(w, 403, "instance teamId required")
		return
	}
	if r.URL.RawPath != "" {
		apiError(w, 400, "encoded paths unsupported")
		return
	}
	path := r.URL.Path
	if r.Method == "OPTIONS" && (path == "/v8/artifacts" || path == "/v8/artifacts/status" || path == "/v8/artifacts/events" || strings.HasPrefix(path, "/v8/artifacts/") && validKey(strings.TrimPrefix(path, "/v8/artifacts/"))) {
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, User-Agent, x-artifact-duration, x-artifact-tag, x-artifact-sha, x-artifact-dirty-hash")
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, PUT, POST, OPTIONS")
		w.WriteHeader(204)
		return
	}
	if path == "/v8/artifacts/status" {
		if r.Method != "GET" {
			apiError(w, 405, "GET required")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"enabled"}`)
		return
	}
	if path == "/v8/artifacts/events" {
		if r.Method != "POST" {
			apiError(w, 405, "POST required")
			return
		}
		var events []json.RawMessage
		if !decodeBounded(w, r, &events) {
			return
		}
		w.WriteHeader(200)
		return
	}
	if path == "/v8/artifacts" {
		if r.Method != "POST" {
			apiError(w, 405, "POST required")
			return
		}
		s.query(w, r)
		return
	}
	key := strings.TrimPrefix(path, "/v8/artifacts/")
	if key == path || !validKey(key) {
		apiError(w, 404, "not found")
		return
	}
	switch r.Method {
	case "GET", "HEAD":
		s.get(w, r, key)
	case "PUT":
		s.put(w, r, key)
	default:
		w.Header().Set("Allow", "GET, HEAD, PUT, OPTIONS")
		apiError(w, 405, "method not allowed")
	}
}
func decodeBounded(w http.ResponseWriter, r *http.Request, out interface{}) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	if err := d.Decode(out); err != nil {
		apiError(w, 400, "invalid bounded JSON")
		return false
	}
	var extra interface{}
	if d.Decode(&extra) != io.EOF {
		apiError(w, 400, "invalid JSON trailer")
		return false
	}
	return true
}
func (s *Server) query(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Hashes []string `json:"hashes"`
	}
	if !decodeBounded(w, r, &in) {
		return
	}
	if len(in.Hashes) > 256 {
		apiError(w, 400, "too many hashes")
		return
	}
	out := map[string]interface{}{}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, key := range in.Hashes {
		if !validKey(key) {
			apiError(w, 400, "invalid key")
			return
		}
		out[key] = nil
		if a, ok := s.entries[key]; ok {
			f, current, err := readArtifact(filepath.Join(s.root, filename(key)))
			if err != nil {
				apiError(w, 503, "artifact unavailable")
				return
			}
			f.Close()
			if !sameArtifact(current, a) {
				apiError(w, 503, "artifact changed")
				return
			}
			duration, _ := strconv.ParseUint(a.Duration, 10, 64)
			out[key] = map[string]interface{}{"taskDurationMs": duration, "sha": a.SHA, "dirtyHash": a.DirtyHash}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
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
	w.Header().Set("x-artifact-duration", a.Duration)
	for k, v := range map[string]string{"x-artifact-tag": a.Tag, "x-artifact-sha": a.SHA, "x-artifact-dirty-hash": a.DirtyHash} {
		if v != "" {
			w.Header().Set(k, v)
		}
	}
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
	a := artifact{Key: key, Duration: r.Header.Get("x-artifact-duration"), Tag: r.Header.Get("x-artifact-tag"), SHA: r.Header.Get("x-artifact-sha"), DirtyHash: r.Header.Get("x-artifact-dirty-hash")}
	if _, err := strconv.ParseUint(a.Duration, 10, 64); err != nil {
		apiError(w, 400, "invalid artifact duration")
		return
	}
	for _, k := range []string{"x-artifact-duration", "x-artifact-tag", "x-artifact-sha", "x-artifact-dirty-hash"} {
		if len(r.Header.Values(k)) > 1 || !safeMetadata(r.Header.Get(k)) {
			apiError(w, 400, "invalid metadata")
			return
		}
	}
	s.uploadMu.Lock()
	defer s.uploadMu.Unlock()
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
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(r.Body, r.ContentLength+1))
	if err != nil || n != r.ContentLength {
		apiError(w, 400, "incomplete artifact")
		return
	}
	a.Size = n
	a.Digest = hex.EncodeToString(h.Sum(nil))
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
	// First writer owns metadata. Rebuild runtime/source metadata may differ
	// for identical bytes; retries do not replace the published envelope.
	if old, ok := s.entries[key]; ok {
		if old.Digest == a.Digest && old.Tag == a.Tag {
			w.WriteHeader(200)
		} else {
			apiError(w, 409, "immutable artifact already exists")
		}
		return
	}
	if err = s.evictLocked(a.Size + headerSize); err != nil {
		apiError(w, 503, "storage unavailable")
		return
	}
	if err = os.Link(tmp.Name(), filepath.Join(s.root, filename(key))); err != nil {
		apiError(w, 503, "storage unavailable")
		return
	}
	dir, e := os.Open(s.root)
	if e == nil {
		e = dir.Sync()
		dir.Close()
	}
	if e != nil {
		_ = os.Remove(filepath.Join(s.root, filename(key)))
		apiError(w, 503, "storage unavailable")
		return
	}
	s.entries[key] = a
	s.used += a.Size + headerSize
	w.WriteHeader(200)
}
func (s *Server) evictLocked(incoming int64) error {
	keys := make([]string, 0, len(s.entries))
	for key := range s.entries {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := s.entries[keys[i]], s.entries[keys[j]]
		if a.accessed.Equal(b.accessed) {
			return keys[i] < keys[j]
		}
		return a.accessed.Before(b.accessed)
	})
	for _, key := range keys {
		if s.used+incoming <= s.maxTotal {
			return nil
		}
		if err := os.Remove(filepath.Join(s.root, filename(key))); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		s.used -= s.entries[key].Size + headerSize
		delete(s.entries, key)
	}
	if s.used+incoming > s.maxTotal {
		return fmt.Errorf("capacity exceeded")
	}
	return nil
}

func sameArtifact(a, b artifact) bool {
	return a.Key == b.Key && a.Size == b.Size && a.Digest == b.Digest && a.Duration == b.Duration && a.Tag == b.Tag && a.SHA == b.SHA && a.DirtyHash == b.DirtyHash
}
