package webdav

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
)

func TestApacheWebDAVContract(t *testing.T) {
	binary, modules := os.Getenv("APACHE_BIN"), os.Getenv("APACHE_MODULES")
	if binary == "" || modules == "" {
		t.Skip("set APACHE_BIN and APACHE_MODULES for real WebDAV tests")
	}
	dir := t.TempDir()
	for _, name := range []string{"content", "locks"} {
		if err := os.Mkdir(filepath.Join(dir, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	const hash = "$2b$10$Z9RNLYUAIh7a19cBqRUKx.zSNfeY9lgPD3T6/fMX.JC82Or3o/5SW"
	auth := filepath.Join(dir, "htpasswd")
	if err := os.WriteFile(auth, []byte("cache:"+hash+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	configuration := strings.NewReplacer("/usr/local/apache2", dir, "modules/", modules+"/", "0.0.0.0:8080", address, "/data/content", filepath.Join(dir, "content"), "/data/locks", filepath.Join(dir, "locks"), "/auth/htpasswd", auth, "/tmp", dir, `User "#1000"`, fmt.Sprintf(`User "#%d"`, os.Getuid()), `Group "#1000"`, fmt.Sprintf(`Group "#%d"`, os.Getgid())).Replace(Configuration)
	configPath := filepath.Join(dir, "httpd.conf")
	if err := os.WriteFile(configPath, []byte(configuration), 0600); err != nil {
		t.Fatal(err)
	}
	log, err := os.Create(filepath.Join(dir, "log"))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "-DFOREGROUND", "-f", configPath)
	cmd.Stdout, cmd.Stderr = log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		_ = log.Close()
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	t.Cleanup(func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			<-done
		}
		_ = log.Close()
	})
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	ready := false
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		select {
		case <-done:
			output, _ := os.ReadFile(log.Name())
			t.Fatalf("Apache exited: %s", output)
		default:
		}
		response, err := client.Get("http://" + address + "/")
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == 401 {
				ready = true
				break
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !ready {
		output, _ := os.ReadFile(log.Name())
		t.Fatalf("Apache did not start: %s", output)
	}
	secret := &corev1.Secret{Data: map[string][]byte{"probe-username": []byte("cache"), "probe-password": []byte("engine-test-only")}}
	if err := CheckProtocol(context.Background(), secret, "http://"+address+"/"); err != nil {
		t.Fatalf("authenticated adapter probe: %v", err)
	}
	secret.Data["probe-password"] = []byte("incorrect")
	if err := CheckProtocol(context.Background(), secret, "http://"+address+"/"); err == nil {
		t.Fatal("adapter probe accepted wrong credentials")
	}
	request := func(method, path string, body []byte, authenticated bool, headers map[string]string) (int, []byte, http.Header) {
		req, err := http.NewRequest(method, "http://"+address+path, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if authenticated {
			req.SetBasicAuth("cache", "engine-test-only")
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		result, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, result, response.Header
	}
	if code, _, _ := request("MKCOL", "/cache", nil, true, nil); code != 201 {
		t.Fatalf("MKCOL: %d", code)
	}
	payload := []byte("webdav cache payload")
	if code, _, _ := request("PUT", "/cache/blob", payload, false, nil); code != 401 {
		t.Fatalf("anonymous PUT: %d", code)
	}
	if code, body, _ := request("PUT", "/cache/blob", payload, true, nil); code != 201 {
		t.Fatalf("PUT: %d %s", code, body)
	}
	if code, body, _ := request("GET", "/cache/blob", nil, true, nil); code != 200 || !bytes.Equal(body, payload) {
		t.Fatalf("GET: %d %q", code, body)
	}
	if code, body, _ := request("PROPFIND", "/cache/", nil, true, map[string]string{"Depth": "1"}); code != 207 || !bytes.Contains(body, []byte("blob")) {
		t.Fatalf("PROPFIND: %d %s", code, body)
	}
	lock := []byte(`<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>test</D:owner></D:lockinfo>`)
	code, body, headers := request("LOCK", "/cache/blob", lock, true, map[string]string{"Content-Type": "application/xml", "Timeout": "Second-60"})
	if code != 200 || headers.Get("Lock-Token") == "" {
		t.Fatalf("LOCK: %d %s", code, body)
	}
	if code, _, _ := request("DELETE", "/cache/blob", nil, true, nil); code != 423 {
		t.Fatalf("delete without lock token: %d", code)
	}
	if code, body, _ := request("DELETE", "/cache/blob", nil, true, map[string]string{"If": "<http://" + address + "/cache/blob> (" + headers.Get("Lock-Token") + ")"}); code != 204 {
		t.Fatalf("authorized DELETE: %d %s", code, body)
	}
}
