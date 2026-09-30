package templates

import (
	"context"
	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/instance"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"strings"
	"testing"
)

func TestRegistryTrustBoundary(t *testing.T) {
	image := "registry.example/cache@sha256:" + strings.Repeat("a", 64)
	for _, ref := range []cachev1.TemplateRef{{Name: "unknown", Version: "0.1.0"}, {Name: "bazel-remote", Version: "latest"}, {Name: "bazel-remote", Version: "0.2.0"}} {
		if _, err := Resolve(ref, image, image); err == nil {
			t.Fatalf("accepted unknown template: %+v", ref)
		}
	}
	if _, err := Resolve(cachev1.TemplateRef{Name: "webdav-apache", Version: "0.1.0"}, image, ""); err == nil {
		t.Fatal("accepted disabled engine")
	}
	for _, name := range []string{"bazel-remote", "webdav-apache"} {
		t.Run(name, func(t *testing.T) {
			adapter, err := Resolve(cachev1.TemplateRef{Name: name, Version: "0.1.0"}, image, image)
			if err != nil {
				t.Fatal(err)
			}
			resources := corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("100m"), corev1.ResourceMemory: resource.MustParse("128Mi")}
			c := instance.Config{Name: "test", Namespace: "project", InstanceID: "instance", ProjectID: "project", Image: "untrusted:latest", StorageClass: "standard", Capacity: "3Gi", CredentialsSecret: "auth", DesiredState: "Running", Resources: corev1.ResourceRequirements{Requests: resources, Limits: resources}}
			policy := "none"
			if name == "bazel-remote" {
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
	for _, name := range []string{"bazel-remote", "webdav-apache"} {
		c := &cachev1.CacheInstance{}
		c.Spec.TemplateRef = cachev1.TemplateRef{Name: name, Version: "0.1.0"}
		err := CheckProtocol(context.Background(), c, &corev1.Secret{})
		if err == nil || err.Error() != "probe credentials are missing" {
			t.Fatalf("registered probe not invoked for %s: %v", name, err)
		}
	}
}
