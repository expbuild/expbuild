package controller

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
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

type Probe interface {
	Check(context.Context, *cachev1.CacheInstance, *corev1.Secret) error
}

// ProtocolProbe is for cluster-internal endpoints. TLS ingress is certified
// separately. Credentials are a dedicated engine user in the same Secret.
type ProtocolProbe struct{}

func (ProtocolProbe) Check(ctx context.Context, c *cachev1.CacheInstance, s *corev1.Secret) error {
	host := fmt.Sprintf("%s.%s.svc", c.Name, c.Namespace)
	if c.Spec.TemplateRef.Name == "webdav-apache" {
		return checkWebDAV(ctx, s, "http://"+host+":8080/")
	}
	return checkProtocol(ctx, c, s, "http://"+host+":8080", host+":9092")
}

func checkWebDAV(ctx context.Context, secret *corev1.Secret, address string) error {
	username, password := string(secret.Data["probe-username"]), string(secret.Data["probe-password"])
	if username == "" || password == "" {
		return fmt.Errorf("probe credentials are missing")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "PROPFIND", address, nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(username, password)
	req.Header.Set("Depth", "0")
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("WebDAV protocol probe failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusMultiStatus {
		return fmt.Errorf("WebDAV probe returned %d", response.StatusCode)
	}
	var document struct {
		XMLName xml.Name `xml:"DAV: multistatus"`
	}
	if err := xml.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&document); err != nil {
		return fmt.Errorf("invalid WebDAV multistatus")
	}
	return nil
}

func checkProtocol(ctx context.Context, c *cachev1.CacheInstance, s *corev1.Secret, httpBase, grpcAddress string) error {
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
