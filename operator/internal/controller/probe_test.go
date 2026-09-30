package controller

import (
	"context"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/expbuild/expbuild/operator/internal/bazelremote"
	"github.com/expbuild/expbuild/operator/internal/webdav"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"
	corev1 "k8s.io/api/core/v1"
)

func TestWebDAVProbeChecksAuthenticationAndMultistatus(t *testing.T) {
	secret := &corev1.Secret{Data: map[string][]byte{"probe-username": []byte("health"), "probe-password": []byte("test")}}
	for _, scenario := range []struct {
		code int
		body string
		ok   bool
	}{{207, `<D:multistatus xmlns:D="DAV:"><D:response/></D:multistatus>`, true}, {401, "denied", false}, {207, "<html/>", false}} {
		t.Run(fmt.Sprint(scenario.code, scenario.ok), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				u, p, ok := r.BasicAuth()
				if !ok || u != "health" || p != "test" || r.Method != "PROPFIND" || r.Header.Get("Depth") != "0" {
					t.Error("incorrect DAV probe request")
				}
				w.WriteHeader(scenario.code)
				_, _ = w.Write([]byte(scenario.body))
			}))
			defer server.Close()
			err := webdav.CheckProtocol(context.Background(), secret, server.URL)
			if (err == nil) != scenario.ok {
				t.Fatalf("probe result: %v", err)
			}
		})
	}
}

func TestAuthenticatedProtocolProbe(t *testing.T) {
	_, c := setup(t)
	s := &corev1.Secret{Data: map[string][]byte{"probe-username": []byte("health"), "probe-password": []byte("test-only")}}
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte("health:test-only"))
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != auth {
			w.WriteHeader(401)
			return
		}
		fmt.Fprint(w, `{"MaxSize":8589934592}`)
	}))
	defer h.Close()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	g := grpc.NewServer()
	g.RegisterService(&grpc.ServiceDesc{ServiceName: "build.bazel.remote.execution.v2.Capabilities", HandlerType: (*interface{})(nil), Methods: []grpc.MethodDesc{{MethodName: "GetCapabilities", Handler: func(_ interface{}, ctx context.Context, decode func(interface{}) error, _ grpc.UnaryServerInterceptor) (interface{}, error) {
		var request emptypb.Empty
		if err := decode(&request); err != nil {
			return nil, err
		}
		md, _ := metadata.FromIncomingContext(ctx)
		values := md.Get("authorization")
		if len(values) != 1 || values[0] != auth {
			return nil, status.Error(codes.Unauthenticated, "invalid credentials")
		}
		return &emptypb.Empty{}, nil
	}}}}, struct{}{})
	go func() { _ = g.Serve(l) }()
	defer g.Stop()
	if err = bazelremote.CheckProtocol(context.Background(), c, s, h.URL, l.Addr().String()); err != nil {
		t.Fatal(err)
	}
	c.Spec.Eviction.MaxCacheGiB = 7
	if err = bazelremote.CheckProtocol(context.Background(), c, s, h.URL, l.Addr().String()); err == nil {
		t.Fatal("wrong cache budget accepted")
	}
	c.Spec.Eviction.MaxCacheGiB = 8
	s.Data["probe-password"] = []byte("wrong")
	if err = bazelremote.CheckProtocol(context.Background(), c, s, h.URL, l.Addr().String()); err == nil {
		t.Fatal("wrong credentials accepted")
	}
}
