package controller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/expbuild/expbuild/operator/internal/bazelremote"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protowire"
	corev1 "k8s.io/api/core/v1"
)

// Raw protobuf codec keeps this contract test independent of a second copy of
// generated REAPI bindings. Field numbers follow remote_execution.proto.
type wireCodec struct{}

func (wireCodec) Name() string                  { return "proto" }
func (wireCodec) Marshal(v any) ([]byte, error) { return *v.(*[]byte), nil }
func (wireCodec) Unmarshal(data []byte, v any) error {
	*v.(*[]byte) = append([]byte(nil), data...)
	return nil
}

func TestRealBazelRemoteContract(t *testing.T) {
	binary := os.Getenv("BAZEL_REMOTE_BIN")
	if binary == "" {
		t.Skip("set BAZEL_REMOTE_BIN to a verified bazel-remote v2.6.2 binary")
	}
	r, c := setup(t)
	c.Spec.Eviction.MaxCacheGiB = 1
	objects, err := bazelremote.Render(config(c, r.Image))
	if err != nil {
		t.Fatal(err)
	}
	var configuration string
	for _, object := range objects {
		if cm, ok := object.(*corev1.ConfigMap); ok {
			configuration = cm.Data["config.yaml"]
		}
	}
	directory := t.TempDir()
	auth := filepath.Join(directory, "htpasswd")
	data := filepath.Join(directory, "data")
	if err := os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	// Public test-only bcrypt fixture for engine-test-only, produced by bcryptjs.
	const hash = "$2b$10$Z9RNLYUAIh7a19cBqRUKx.zSNfeY9lgPD3T6/fMX.JC82Or3o/5SW"
	if err := os.WriteFile(auth, []byte("health:"+hash+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	address := func() string {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		a := l.Addr().String()
		_ = l.Close()
		return a
	}
	httpAddress, grpcAddress := address(), address()
	configuration = strings.NewReplacer("/data", data, "/auth/htpasswd", auth, "0.0.0.0:8080", httpAddress, "0.0.0.0:9092", grpcAddress).Replace(configuration)
	configPath := filepath.Join(directory, "config.yaml")
	if err := os.WriteFile(configPath, []byte(configuration), 0600); err != nil {
		t.Fatal(err)
	}
	secret := &corev1.Secret{Data: map[string][]byte{"probe-username": []byte("health"), "probe-password": []byte("engine-test-only")}}
	start := func() func() {
		ctx, cancel := context.WithCancel(context.Background())
		command := exec.CommandContext(ctx, binary, "--config_file="+configPath)
		logFile, err := os.CreateTemp(directory, "engine-log-")
		if err != nil {
			t.Fatal(err)
		}
		command.Stdout, command.Stderr = logFile, logFile
		if err := command.Start(); err != nil {
			cancel()
			_ = logFile.Close()
			t.Fatal(err)
		}
		done := make(chan struct{})
		go func() { _ = command.Wait(); close(done) }()
		var once sync.Once
		stop := func() { once.Do(func() { cancel(); <-done; _ = logFile.Close() }) }
		t.Cleanup(stop)
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			select {
			case <-done:
				output, _ := os.ReadFile(logFile.Name())
				t.Fatalf("engine exited: %s", output)
			default:
			}
			if checkProtocol(context.Background(), c, secret, "http://"+httpAddress, grpcAddress) == nil {
				return stop
			}
			time.Sleep(100 * time.Millisecond)
		}
		output, _ := os.ReadFile(logFile.Name())
		t.Fatalf("engine did not become ready: %s", output)
		return stop
	}
	stop := start()
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	payload := []byte("expbuild real engine protocol contract")
	digest := fmt.Sprintf("%x", sha256.Sum256(payload))
	request := func(method, username string) (int, []byte) {
		req, err := http.NewRequest(method, "http://"+httpAddress+"/cas/"+digest, bytes.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		if username != "" {
			req.SetBasicAuth(username, "engine-test-only")
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, body
	}
	conn, err := grpc.NewClient(grpcAddress, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	digestMessage := protowire.AppendBytes(protowire.AppendTag(nil, 1, protowire.BytesType), []byte(digest))
	digestMessage = protowire.AppendVarint(protowire.AppendTag(digestMessage, 2, protowire.VarintType), uint64(len(payload)))
	missingRequest := protowire.AppendBytes(protowire.AppendTag(nil, 2, protowire.BytesType), digestMessage)
	findMissing := func(authenticated bool) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if authenticated {
			ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("health:engine-test-only")))
		}
		var response []byte
		err := conn.Invoke(ctx, "/build.bazel.remote.execution.v2.ContentAddressableStorage/FindMissingBlobs", &missingRequest, &response, grpc.ForceCodec(wireCodec{}))
		return response, err
	}
	if _, err := findMissing(false); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("unauthenticated REAPI accepted: %v", err)
	}
	if response, err := findMissing(true); err != nil || !bytes.Equal(response, missingRequest) {
		t.Fatalf("missing digest mismatch: %x, %v", response, err)
	}
	if code, _ := request(http.MethodPut, ""); code != 401 {
		t.Fatalf("unauthenticated write returned %d", code)
	}
	if code, body := request(http.MethodPut, "health"); code != 200 {
		t.Fatalf("authenticated write: %d %s", code, body)
	}
	if code, _ := request(http.MethodGet, ""); code != 401 {
		t.Fatalf("unauthenticated read returned %d", code)
	}
	if code, body := request(http.MethodGet, "health"); code != 200 || !bytes.Equal(body, payload) {
		t.Fatalf("read round trip: %d %q", code, body)
	}
	if response, err := findMissing(true); err != nil || len(response) != 0 {
		t.Fatalf("uploaded digest still missing: %x, %v", response, err)
	}
	stop()
	if err := os.WriteFile(auth, []byte("new-health:"+hash+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	secret.Data["probe-username"] = []byte("new-health")
	start()
	if code, _ := request(http.MethodGet, "health"); code != 401 {
		t.Fatalf("old credential survived restart: %d", code)
	}
	if code, body := request(http.MethodGet, "new-health"); code != 200 || !bytes.Equal(body, payload) {
		t.Fatalf("persistent read with rotated credential: %d %q", code, body)
	}
}
