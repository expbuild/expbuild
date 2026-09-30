// webdav-stats reports a bounded, read-only snapshot of a WebDAV content tree.
// It never interprets a successful WebDAV request as a cache hit.
package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const maxEntries = 1_000_000

type snapshot struct {
	UsedBytes     int64     `json:"usedBytes"`
	CapacityBytes int64     `json:"capacityBytes"`
	ItemCount     int64     `json:"itemCount"`
	ObservedAt    time.Time `json:"observedAt"`
}

func scan(root string, capacityBytes int64, now time.Time) (snapshot, error) {
	result := snapshot{CapacityBytes: capacityBytes, ObservedAt: now.UTC()}
	deadline := now.Add(15 * time.Second)
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return result, err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return result, errors.New("content root is not a directory")
	}
	var visited int64
	var walk func(string, int) error
	walk = func(directory string, depth int) error {
		if depth > 128 {
			return errors.New("content directory nesting exceeds supported depth")
		}
		file, err := os.Open(directory)
		if err != nil {
			return err
		}
		defer file.Close()
		for {
			// File.ReadDir(n) bounds memory even for a large flat DAV directory.
			entries, readErr := file.ReadDir(256)
			for _, entry := range entries {
				visited++
				if visited > maxEntries {
					return errors.New("content scan exceeds supported entry count")
				}
				if time.Now().After(deadline) {
					return errors.New("content scan exceeded time limit")
				}
				if entry.Type()&os.ModeSymlink != 0 {
					continue
				}
				path := filepath.Join(directory, entry.Name())
				if entry.IsDir() {
					if err := walk(path, depth+1); err != nil {
						return err
					}
					continue
				}
				info, err := entry.Info()
				if err != nil {
					return err
				}
				if !info.Mode().IsRegular() {
					continue
				}
				if info.Size() < 0 || result.UsedBytes > int64(^uint64(0)>>1)-info.Size() {
					return errors.New("content scan exceeds supported size")
				}
				result.ItemCount++
				result.UsedBytes += info.Size()
			}
			if readErr == io.EOF {
				return nil
			}
			if readErr != nil {
				return readErr
			}
		}
	}
	return result, walk(root, 0)
}

type server struct {
	root, usernameFile, passwordFile string
	capacityBytes                    int64
	mu                               sync.RWMutex
	current                          snapshot
	lastErr                          error
}

func (s *server) refresh() {
	value, err := scan(s.root, s.capacityBytes, time.Now())
	s.mu.Lock()
	s.current, s.lastErr = value, err
	s.mu.Unlock()
	if err != nil {
		log.Printf("WebDAV content scan failed: %v", err)
	}
}

func (s *server) serveHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path != "/status" || r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	username, password, ok := r.BasicAuth()
	allowedUser, userErr := os.ReadFile(s.usernameFile)
	allowedPassword, passErr := os.ReadFile(s.passwordFile)
	if !ok || userErr != nil || passErr != nil ||
		subtle.ConstantTimeCompare([]byte(username), []byte(strings.TrimSpace(string(allowedUser)))) != 1 ||
		subtle.ConstantTimeCompare([]byte(password), []byte(strings.TrimSpace(string(allowedPassword)))) != 1 {
		w.Header().Set("WWW-Authenticate", `Basic realm="expbuild statistics"`)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	s.mu.RLock()
	value, err := s.current, s.lastErr
	s.mu.RUnlock()
	if err != nil || value.ObservedAt.IsZero() || time.Since(value.ObservedAt) > 2*time.Minute {
		http.Error(w, "Statistics unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func main() {
	listen := flag.String("listen", ":9093", "internal status listener")
	root := flag.String("root", "/data/content", "WebDAV content directory")
	usernameFile := flag.String("username-file", "/auth/probe-username", "probe username file")
	passwordFile := flag.String("password-file", "/auth/probe-password", "probe password file")
	capacityBytes := flag.Int64("capacity-bytes", 0, "requested PVC capacity in bytes")
	flag.Parse()
	if *capacityBytes <= 0 || *capacityBytes > 1<<50 {
		log.Fatal("capacity-bytes must be between 1 and 2^50")
	}
	s := &server{root: *root, usernameFile: *usernameFile, passwordFile: *passwordFile, capacityBytes: *capacityBytes}
	s.refresh()
	go func() {
		for range time.Tick(30 * time.Second) {
			s.refresh()
		}
	}()
	httpServer := &http.Server{Addr: *listen, Handler: http.HandlerFunc(s.serveHTTP), ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(fmt.Errorf("WebDAV statistics server: %w", httpServer.ListenAndServe()))
}
