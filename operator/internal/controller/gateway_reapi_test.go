package controller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protowire"
)

// This test connects only when explicitly supplied a private fixture file by
// tools/helm_lifecycle.py. Credentials are never logged or passed on the CLI.
func TestGatewayREAPIContract(t *testing.T) {
	file := os.Getenv("GATEWAY_REAPI_FIXTURE")
	if file == "" {
		t.Skip("requires isolated TLS gateway fixture")
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct{ Address, Host, CA, Username, Password, OldPassword, Phase string }
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatal("invalid fixture")
	}
	roots := x509.NewCertPool()
	cert, err := os.ReadFile(cfg.CA)
	if err != nil || !roots.AppendCertsFromPEM(cert) {
		t.Fatal("invalid test CA")
	}
	conn, err := grpc.NewClient(cfg.Address, grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{RootCAs: roots, ServerName: cfg.Host, MinVersion: tls.VersionTLS12})), grpc.WithAuthority(cfg.Host))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	authenticated := func(password string) context.Context {
		return metadata.AppendToOutgoingContext(ctx, "authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(cfg.Username+":"+password)))
	}
	auth := authenticated(cfg.Password)
	seed := sha256.Sum256([]byte(cfg.Host))
	payload := bytes.Repeat(seed[:], 8*1024*1024/len(seed))
	digest := fmt.Sprintf("%x", sha256.Sum256(payload))
	byteField := func(message []byte, field protowire.Number, value []byte) []byte {
		return protowire.AppendBytes(protowire.AppendTag(message, field, protowire.BytesType), value)
	}
	intField := func(message []byte, field protowire.Number, value uint64) []byte {
		return protowire.AppendVarint(protowire.AppendTag(message, field, protowire.VarintType), value)
	}
	digestMessage := intField(byteField(nil, 1, []byte(digest)), 2, uint64(len(payload)))
	missingRequest := byteField(nil, 2, digestMessage)
	findMissing := func(context context.Context) ([]byte, error) {
		var response []byte
		err := conn.Invoke(context, "/build.bazel.remote.execution.v2.ContentAddressableStorage/FindMissingBlobs", &missingRequest, &response, grpc.ForceCodec(wireCodec{}))
		return response, err
	}
	if _, err := findMissing(ctx); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("anonymous REAPI status: %v", status.Code(err))
	}
	if cfg.OldPassword != "" {
		if _, err := findMissing(authenticated(cfg.OldPassword)); status.Code(err) != codes.Unauthenticated {
			t.Fatalf("old credential status: %v", status.Code(err))
		}
	}
	var empty, capabilities []byte
	if err := conn.Invoke(auth, "/build.bazel.remote.execution.v2.Capabilities/GetCapabilities", &empty, &capabilities, grpc.ForceCodec(wireCodec{})); err != nil || len(capabilities) == 0 {
		t.Fatal("TLS capabilities probe failed", err)
	}
	if cfg.Phase == "write" {
		if response, err := findMissing(auth); err != nil || !bytes.Equal(response, missingRequest) {
			t.Fatal("new digest not reported missing", err)
		}
		stream, err := conn.NewStream(auth, &grpc.StreamDesc{ClientStreams: true}, "/google.bytestream.ByteStream/Write", grpc.ForceCodec(wireCodec{}))
		if err != nil {
			t.Fatal(err)
		}
		name := fmt.Sprintf("uploads/00000000-0000-4000-8000-000000000001/blobs/%s/%d", digest, len(payload))
		const chunk = 256 * 1024
		for offset := 0; offset < len(payload); offset += chunk {
			end := offset + chunk
			if end > len(payload) {
				end = len(payload)
			}
			message := intField(byteField(nil, 1, []byte(name)), 2, uint64(offset))
			if end == len(payload) {
				message = intField(message, 3, 1)
			}
			message = byteField(message, 10, payload[offset:end])
			if err := stream.SendMsg(&message); err != nil {
				t.Fatal(err)
			}
		}
		if err := stream.CloseSend(); err != nil {
			t.Fatal(err)
		}
		var response []byte
		if err := stream.RecvMsg(&response); err != nil {
			t.Fatal(err)
		}
		expected := intField(nil, 1, uint64(len(payload)))
		if !bytes.Equal(response, expected) {
			t.Fatal("incorrect committed size")
		}
	}
	if response, err := findMissing(auth); err != nil || len(response) != 0 {
		t.Fatal("stored digest reported missing", err)
	}
	reader, err := conn.NewStream(auth, &grpc.StreamDesc{ServerStreams: true}, "/google.bytestream.ByteStream/Read", grpc.ForceCodec(wireCodec{}))
	if err != nil {
		t.Fatal(err)
	}
	readRequest := byteField(nil, 1, []byte(fmt.Sprintf("blobs/%s/%d", digest, len(payload))))
	if err := reader.SendMsg(&readRequest); err != nil {
		t.Fatal(err)
	}
	if err := reader.CloseSend(); err != nil {
		t.Fatal(err)
	}
	received := []byte{}
	for {
		var response []byte
		err := reader.RecvMsg(&response)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		for len(response) > 0 {
			number, kind, n := protowire.ConsumeTag(response)
			if n < 0 {
				t.Fatal("invalid read response")
			}
			response = response[n:]
			if number == 10 && kind == protowire.BytesType {
				value, n := protowire.ConsumeBytes(response)
				if n < 0 || len(received)+len(value) > len(payload) {
					t.Fatal("invalid read data")
				}
				received = append(received, value...)
				response = response[n:]
			} else {
				n := protowire.ConsumeFieldValue(number, kind, response)
				if n < 0 {
					t.Fatal("invalid read field")
				}
				response = response[n:]
			}
		}
	}
	if !bytes.Equal(received, payload) {
		t.Fatal("TLS ByteStream round trip mismatch")
	}
	t.Log("authenticated TLS capabilities, FindMissing and 8 MiB ByteStream verified")
}
