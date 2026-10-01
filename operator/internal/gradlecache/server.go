// Package gradlecache implements Gradle's opaque HTTP build-cache GET/PUT
// contract. A key names an archive; its bytes are never interpreted as a
// digest, unlike the Bazel CAS.
package gradlecache

import (
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type entry struct {
	size     int64
	accessed time.Time
}

type Server struct {
	metrics            *cacheMetrics
	root               string
	credentials        string
	maxEntry, maxTotal int64
	mu                 sync.Mutex
	entries            map[string]entry
	used               int64
	getHits            atomic.Uint64
	getMisses          atomic.Uint64
	putSuccess         atomic.Uint64
	putRejected        atomic.Uint64
}

// New refuses a symlinked data root and scans existing entries before serving.
// The single-process index is reconstructed after every restart.
func New(root, credentials string, maxEntry, maxTotal int64) (*Server, error) {
	if maxEntry <= 0 || maxTotal <= 0 || maxEntry > maxTotal {
		return nil, fmt.Errorf("invalid cache budget")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("cache root must be a directory")
	}
	s := &Server{root: root, credentials: credentials, maxEntry: maxEntry, maxTotal: maxTotal, entries: map[string]entry{}}
	s.metrics = newCacheMetrics(s)
	items, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		if strings.HasPrefix(item.Name(), ".upload-") && item.Type().IsRegular() {
			if err := os.Remove(filepath.Join(root, item.Name())); err != nil {
				return nil, err
			}
			continue
		}
		if !validKey(item.Name()) || !item.Type().IsRegular() {
			continue
		}
		info, err := item.Info()
		if err != nil {
			return nil, err
		}
		s.entries[item.Name()] = entry{size: info.Size(), accessed: info.ModTime()}
		s.used += info.Size()
	}
	if err := s.evictLocked(""); err != nil {
		return nil, err
	}
	return s, nil
}

func validKey(key string) bool {
	if len(key) != 32 && len(key) != 64 {
		return false
	}
	_, err := hex.DecodeString(key)
	return err == nil && key == strings.ToLower(key)
}

func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (string, bool) {
	user, password, ok := r.BasicAuth()
	data, err := os.ReadFile(s.credentials)
	if err != nil {
		http.Error(w, "credentials unavailable", http.StatusServiceUnavailable)
		return "", false
	}
	// The management API supplies one client identity and one probe identity.
	// Validate the entire bounded file before accepting either identity.
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	if len(data) > 4096 || len(lines) == 0 || len(lines) > 2 {
		http.Error(w, "credentials unavailable", http.StatusServiceUnavailable)
		return "", false
	}
	seen := map[string]bool{}
	hash := ""
	for _, line := range lines {
		parts := strings.Split(line, ":")
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" || strings.ContainsAny(parts[0], "\r\n\t ") || strings.ContainsAny(parts[1], "\r\n\t ") || seen[parts[0]] {
			http.Error(w, "credentials unavailable", http.StatusServiceUnavailable)
			return "", false
		}
		seen[parts[0]] = true
		if ok && subtle.ConstantTimeCompare([]byte(user), []byte(parts[0])) == 1 {
			hash = parts[1]
		}
	}
	if hash == "" || bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		w.Header().Set("WWW-Authenticate", `Basic realm="expbuild Gradle cache"`)
		http.Error(w, "authentication required", http.StatusUnauthorized)
		return "", false
	}
	return user, true
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	user, authenticated := s.authenticate(w, r)
	if !authenticated {
		return
	}
	if r.URL.Path == "/metrics" && r.URL.RawQuery == "" {
		if user != "health" {
			http.Error(w, "probe identity required", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		s.metrics.handler.ServeHTTP(w, r)
		return
	}
	if r.URL.Path == "/status" && r.URL.RawQuery == "" {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		s.mu.Lock()
		used, count := s.used, len(s.entries)
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{"sizeBytes": used, "capacityBytes": s.maxTotal, "entries": count,
			"getHits": s.getHits.Load(), "getMisses": s.getMisses.Load(), "putSuccess": s.putSuccess.Load(), "putRejected": s.putRejected.Load()})
		return
	}
	// The health identity is stored in the same Secret for Operator and API
	// probes, but it cannot read or mutate build-cache archives.
	if user == "health" {
		http.Error(w, "probe identity cannot access cache content", http.StatusForbidden)
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/cache/") || !validKey(strings.TrimPrefix(r.URL.Path, "/cache/")) || r.URL.RawQuery != "" {
		http.NotFound(w, r)
		return
	}
	key := strings.TrimPrefix(r.URL.Path, "/cache/")
	switch r.Method {
	case http.MethodGet:
		s.measure(w, r, func(out http.ResponseWriter) { s.get(out, r, key) })
	case http.MethodPut:
		s.measure(w, r, func(out http.ResponseWriter) { s.put(out, r, key) })
	default:
		w.Header().Set("Allow", "GET, PUT")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) get(w http.ResponseWriter, r *http.Request, key string) {
	s.mu.Lock()
	value, ok := s.entries[key]
	if !ok {
		s.getMisses.Add(1)
		s.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(filepath.Join(s.root, key))
	if errors.Is(err, os.ErrNotExist) {
		s.getMisses.Add(1)
		delete(s.entries, key)
		s.used -= value.size
		s.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if err != nil {
		s.mu.Unlock()
		http.Error(w, "cache unavailable", http.StatusServiceUnavailable)
		return
	}
	s.getHits.Add(1)
	now := time.Now()
	s.entries[key] = entry{size: value.size, accessed: now}
	// Persist access time at most once a minute to bound metadata writes.
	if now.Sub(value.accessed) >= time.Minute {
		_ = os.Chtimes(filepath.Join(s.root, key), now, now)
	}
	s.mu.Unlock()
	defer f.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprint(value.size))
	w.Header().Set("Cache-Control", "private, max-age=0")
	_, _ = io.Copy(w, f)
}

func (s *Server) put(w http.ResponseWriter, r *http.Request, key string) {
	if r.ContentLength > s.maxEntry {
		s.putRejected.Add(1)
		http.Error(w, "entry too large", http.StatusRequestEntityTooLarge)
		return
	}
	tmp, err := os.CreateTemp(s.root, ".upload-")
	if err != nil {
		http.Error(w, "cache unavailable", http.StatusServiceUnavailable)
		return
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if err = tmp.Chmod(0600); err != nil {
		http.Error(w, "cache unavailable", http.StatusServiceUnavailable)
		return
	}
	size, err := io.Copy(tmp, io.LimitReader(r.Body, s.maxEntry+1))
	s.metrics.bytes.WithLabelValues("write").Add(float64(size))
	if err != nil {
		http.Error(w, "upload interrupted", http.StatusBadRequest)
		return
	}
	if size > s.maxEntry {
		s.putRejected.Add(1)
		http.Error(w, "entry too large", http.StatusRequestEntityTooLarge)
		return
	}
	if err = tmp.Sync(); err != nil {
		http.Error(w, "cache unavailable", http.StatusServiceUnavailable)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.entries[key]; ok {
		s.putRejected.Add(1)
		http.Error(w, "entry already exists", http.StatusConflict)
		return
	}
	// Link creates the final name only if absent. Readers can never see a
	// partial archive, and a concurrent writer cannot replace an existing key.
	if err = os.Link(tmp.Name(), filepath.Join(s.root, key)); err != nil {
		if errors.Is(err, os.ErrExist) {
			s.putRejected.Add(1)
			http.Error(w, "entry already exists", http.StatusConflict)
		} else {
			http.Error(w, "cache unavailable", http.StatusServiceUnavailable)
		}
		return
	}
	s.entries[key] = entry{size: size, accessed: time.Now()}
	s.used += size
	if err := s.evictLocked(key); err != nil {
		_ = os.Remove(filepath.Join(s.root, key))
		s.used -= size
		delete(s.entries, key)
		http.Error(w, "cache unavailable", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusCreated)
	s.putSuccess.Add(1)
}

func (s *Server) evictLocked(protected string) error {
	if s.used <= s.maxTotal {
		return nil
	}
	candidates := make([]string, 0, len(s.entries))
	for key := range s.entries {
		if key != protected {
			candidates = append(candidates, key)
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		a, b := s.entries[candidates[i]], s.entries[candidates[j]]
		if a.accessed.Equal(b.accessed) {
			return candidates[i] < candidates[j]
		}
		return a.accessed.Before(b.accessed)
	})
	for _, oldest := range candidates {
		if s.used <= s.maxTotal {
			break
		}
		if err := os.Remove(filepath.Join(s.root, oldest)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		s.metrics.evictions.Inc()
		s.metrics.evictedBytes.Add(float64(s.entries[oldest].size))
		s.used -= s.entries[oldest].size
		delete(s.entries, oldest)
	}
	if s.used > s.maxTotal {
		return fmt.Errorf("cache cannot satisfy budget")
	}
	return nil
}
