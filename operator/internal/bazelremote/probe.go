package bazelremote

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/emptypb"
	corev1 "k8s.io/api/core/v1"
)

// CheckProtocol verifies applied capacity and authenticated REAPI capabilities.
func CheckProtocol(ctx context.Context, c *cachev1.CacheInstance, s *corev1.Secret, httpBase, grpcAddress string) error {
	username, password := string(s.Data["probe-username"]), string(s.Data["probe-password"])
	if username == "" || password == "" {
		return fmt.Errorf("probe credentials are missing")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	httpClient := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, httpBase+"/status", nil)
	if err != nil {
		return err
	}
	request.SetBasicAuth(username, password)
	response, err := httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("HTTP status probe failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP status probe returned %d", response.StatusCode)
	}
	var state struct{ MaxSize int64 }
	if err = json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&state); err != nil {
		return fmt.Errorf("invalid engine status response")
	}
	if c.Spec.Eviction.MaxCacheGiB > (1<<63-1)/(1<<30) || state.MaxSize != c.Spec.Eviction.MaxCacheGiB*(1<<30) {
		return fmt.Errorf("engine has not applied the requested cache budget")
	}
	conn, err := grpc.NewClient(grpcAddress, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return fmt.Errorf("cannot initialize gRPC probe")
	}
	defer conn.Close()
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+password))
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", auth)
	// GetCapabilitiesRequest has no required fields; emptypb emits the same
	// empty protobuf request and safely ignores response fields we don't use.
	if err = conn.Invoke(ctx, "/build.bazel.remote.execution.v2.Capabilities/GetCapabilities", &emptypb.Empty{}, &emptypb.Empty{}); err != nil {
		return fmt.Errorf("authenticated REAPI capabilities probe failed")
	}
	return nil
}
