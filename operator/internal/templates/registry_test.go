package templates

import (
	"context"
	"encoding/json"
	"fmt"
	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/instance"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestRegistryTrustBoundary(t *testing.T) {
	image := "registry.example/cache@sha256:" + strings.Repeat("a", 64)
	for _, ref := range []cachev1.TemplateRef{{Name: "unknown", Version: "0.1.0"}, {Name: "bazel-remote", Version: "latest"}, {Name: "bazel-remote", Version: "0.2.0"}} {
		if _, err := Resolve(ref, image, image, image, image); err == nil {
			t.Fatalf("accepted unknown template: %+v", ref)
		}
	}
	if _, err := Resolve(cachev1.TemplateRef{Name: "webdav-apache", Version: "0.1.0"}, image, "", image, image); err == nil {
		t.Fatal("accepted disabled engine")
	}
	for _, name := range []string{"bazel-remote", "webdav-apache", "gradle-http"} {
		t.Run(name, func(t *testing.T) {
			adapter, err := Resolve(cachev1.TemplateRef{Name: name, Version: "0.1.0"}, image, image, image, image)
			if err != nil {
				t.Fatal(err)
			}
			resources := corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("100m"), corev1.ResourceMemory: resource.MustParse("128Mi")}
			c := instance.Config{Name: "test", Namespace: "project", InstanceID: "instance", ProjectID: "project", Image: "untrusted:latest", StorageClass: "standard", Capacity: "3Gi", CredentialsSecret: "auth", DesiredState: "Running", Resources: corev1.ResourceRequirements{Requests: resources, Limits: resources}}
			policy := "none"
			if name == "bazel-remote" || name == "gradle-http" {
				c.MaxCacheGiB = 1
				policy = "lru"
			}
			if _, err := adapter.Render(c, "ttl"); err == nil {
				t.Fatal("accepted unsupported policy")
			}
			objects, err := adapter.Render(c, policy)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, obj := range objects {
				if sts, ok := obj.(*appsv1.StatefulSet); ok {
					found = true
					if sts.Spec.Template.Spec.Containers[0].Image != image {
						t.Fatal("caller replaced approved image")
					}
				}
			}
			if !found {
				t.Fatal("workload missing")
			}
			endpoints := adapter.Endpoints(c.Name, c.Namespace)
			if len(endpoints) == 0 {
				t.Fatal("no endpoints")
			}
			endpoints[0].URL = "changed"
			if adapter.Endpoints(c.Name, c.Namespace)[0].URL == "changed" {
				t.Fatal("shared mutable endpoint state")
			}
			if name == "webdav-apache" {
				c.MaxCacheGiB = 1
			} else {
				c.MaxCacheGiB = 3
			}
			if _, err := adapter.Render(c, policy); err == nil {
				t.Fatal("engine budget validation bypassed")
			}
		})
	}
}

func TestProtocolLookupRejectsUnknownBeforeNetwork(t *testing.T) {
	for _, ref := range []cachev1.TemplateRef{{Name: "unknown", Version: "0.1.0"}, {Name: "bazel-remote", Version: "0.2.0"}, {Name: "webdav-apache", Version: "latest"}} {
		c := &cachev1.CacheInstance{}
		c.Spec.TemplateRef = ref
		// A nil Secret would panic if execution fell through to an engine probe.
		err := CheckProtocol(context.Background(), c, nil)
		if err == nil || !strings.Contains(err.Error(), "unsupported template") {
			t.Fatalf("expected template rejection, got %v", err)
		}
	}
	for _, name := range []string{"bazel-remote", "webdav-apache", "gradle-http"} {
		c := &cachev1.CacheInstance{}
		c.Spec.TemplateRef = cachev1.TemplateRef{Name: name, Version: "0.1.0"}
		err := CheckProtocol(context.Background(), c, &corev1.Secret{})
		if err == nil || err.Error() != "probe credentials are missing" {
			t.Fatalf("registered probe not invoked for %s: %v", name, err)
		}
	}
}

func TestSharedAPITemplateFixtures(t *testing.T) {
	data, err := os.ReadFile("../../../tests/contracts/templates.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name, Version, EnginePolicy string
		StorageGiB, CacheGiB        int64
		EndpointProtocols           []string
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) == 0 {
		t.Fatal("no shared fixtures")
	}
	image := "registry.example/cache@sha256:" + strings.Repeat("a", 64)
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			adapter, err := Resolve(cachev1.TemplateRef{Name: fixture.Name, Version: fixture.Version}, image, image, image, image)
			if err != nil {
				t.Fatal(err)
			}
			resources := corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("500m"), corev1.ResourceMemory: resource.MustParse("512Mi")}
			c := instance.Config{Name: "contract", Namespace: "project", InstanceID: "instance", ProjectID: "project", StorageClass: "standard", Capacity: fmt.Sprintf("%dGi", fixture.StorageGiB), MaxCacheGiB: fixture.CacheGiB, CredentialsSecret: "auth", DesiredState: "Running", Resources: corev1.ResourceRequirements{Requests: resources, Limits: resources}}
			c.StatsImage = "untrusted:latest"
			objects, err := adapter.Render(c, fixture.EnginePolicy)
			if err != nil {
				t.Fatal(err)
			}
			if fixture.Name == "webdav-apache" && fixture.Version == "0.2.0" {
				sts := objects[4].(*appsv1.StatefulSet)
				if sts.Spec.Template.Spec.Containers[1].Image != image {
					t.Fatal("caller replaced approved statistics image")
				}
			}
			var protocols []string
			for _, endpoint := range adapter.Endpoints(c.Name, c.Namespace) {
				protocols = append(protocols, endpoint.Protocol)
			}
			if !reflect.DeepEqual(protocols, fixture.EndpointProtocols) {
				t.Fatalf("endpoint contract: %v != %v", protocols, fixture.EndpointProtocols)
			}
		})
	}
}

func TestIntegrationCapabilitiesMatchRenderedService(t *testing.T) {
	data, err := os.ReadFile("../../../tests/contracts/templates.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name, Version, EnginePolicy   string
		StorageGiB, CacheGiB          int64
		HTTPPort, GRPCPort            int32
		Statistics, PrometheusMetrics bool
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	image := "registry.example/cache@sha256:" + strings.Repeat("a", 64)
	for _, fixture := range fixtures {
		ref := cachev1.TemplateRef{Name: fixture.Name, Version: fixture.Version}
		capabilities, err := Describe(ref)
		if err != nil {
			t.Fatal(err)
		}
		if capabilities.HTTPPort != fixture.HTTPPort || capabilities.GRPCPort != fixture.GRPCPort || (capabilities.MetricsPort > 0) != fixture.PrometheusMetrics {
			t.Fatalf("capability contract drift for %s", fixture.Name)
		}
		adapter, err := Resolve(ref, image, image, image, image)
		if err != nil {
			t.Fatal(err)
		}
		resources := corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("500m"), corev1.ResourceMemory: resource.MustParse("512Mi")}
		c := instance.Config{Name: "contract", Namespace: "project", InstanceID: "instance", ProjectID: "project", StorageClass: "standard", Capacity: fmt.Sprintf("%dGi", fixture.StorageGiB), MaxCacheGiB: fixture.CacheGiB, CredentialsSecret: "auth", DesiredState: "Running", Resources: corev1.ResourceRequirements{Requests: resources, Limits: resources}}
		objects, err := adapter.Render(c, fixture.EnginePolicy)
		if err != nil {
			t.Fatal(err)
		}
		ports := map[string]int32{}
		for _, object := range objects {
			if service, ok := object.(*corev1.Service); ok && service.Name == c.Name {
				for _, port := range service.Spec.Ports {
					ports[port.Name] = port.Port
				}
			}
		}
		if ports["http"] != capabilities.HTTPPort || ports["grpc"] != capabilities.GRPCPort {
			t.Fatalf("route backend not served for %s", fixture.Name)
		}
		if capabilities.MetricsPort > 0 && (ports[capabilities.MetricsPortName] != capabilities.MetricsPort || capabilities.MetricsPath != "/metrics") {
			t.Fatal("metrics endpoint not served")
		}
		if fixture.Name == "webdav-apache" && fixture.Version == "0.2.0" && ports["stats"] != 9093 {
			t.Fatal("WebDAV content statistics endpoint not served")
		}
	}
	if _, err := Describe(cachev1.TemplateRef{Name: "bazel-remote", Version: "unknown"}); err == nil {
		t.Fatal("accepted unknown version")
	}
}
