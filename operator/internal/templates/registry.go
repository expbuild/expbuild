// Package templates binds exact template versions to trusted compiled adapters.
// Image selection is installation configuration, never instance-controlled code.
package templates

import (
	"context"
	"fmt"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/bazelremote"
	"github.com/expbuild/expbuild/operator/internal/instance"
	"github.com/expbuild/expbuild/operator/internal/webdav"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// Capabilities describes only integrations certified for an exact template version.
// Zero GRPCPort or MetricsPort means unsupported; callers must not invent defaults.
type Capabilities struct {
	HTTPProtocol                 string
	HTTPPort, GRPCPort           int32
	MetricsPort                  int32
	MetricsPortName, MetricsPath string
}

type Adapter struct {
	capabilities Capabilities
	image        string
	probe        func(context.Context, *cachev1.CacheInstance, *corev1.Secret) error
	policy       string
	render       func(instance.Config) ([]runtime.Object, error)
	endpoints    func(string, string) []cachev1.Endpoint
}

// lookup fails closed on unknown versions; there is no fallback to latest.
func lookup(ref cachev1.TemplateRef) (Adapter, error) {
	adapters := map[cachev1.TemplateRef]Adapter{
		{Name: "bazel-remote", Version: "0.1.0"}: {
			policy: "lru", render: bazelremote.Render,
			capabilities: Capabilities{HTTPProtocol: "bazel-http", HTTPPort: 8080, GRPCPort: 9092, MetricsPort: 8080, MetricsPortName: "http", MetricsPath: "/metrics"},
			probe: func(ctx context.Context, c *cachev1.CacheInstance, s *corev1.Secret) error {
				host := fmt.Sprintf("%s.%s.svc", c.Name, c.Namespace)
				return bazelremote.CheckProtocol(ctx, c, s, "http://"+host+":8080", host+":9092")
			},
			endpoints: func(name, namespace string) []cachev1.Endpoint {
				return []cachev1.Endpoint{{Protocol: "reapi", URL: fmt.Sprintf("grpc://%s.%s.svc:9092", name, namespace)}, {Protocol: "bazel-http", URL: fmt.Sprintf("http://%s.%s.svc:8080", name, namespace)}}
			},
		},
		{Name: "webdav-apache", Version: "0.1.0"}: {
			policy: "none", render: webdav.Render,
			capabilities: Capabilities{HTTPProtocol: "webdav", HTTPPort: 8080},
			probe: func(ctx context.Context, c *cachev1.CacheInstance, s *corev1.Secret) error {
				return webdav.CheckProtocol(ctx, s, fmt.Sprintf("http://%s.%s.svc:8080/", c.Name, c.Namespace))
			},
			endpoints: func(name, namespace string) []cachev1.Endpoint {
				return []cachev1.Endpoint{{Protocol: "webdav", URL: fmt.Sprintf("http://%s.%s.svc:8080/", name, namespace)}}
			},
		},
	}
	adapter, ok := adapters[ref]
	if !ok {
		return Adapter{}, fmt.Errorf("unsupported template %s@%s", ref.Name, ref.Version)
	}
	return adapter, nil
}

// Resolve binds a compiled adapter to its administrator-approved image.
func Resolve(ref cachev1.TemplateRef, bazelImage, webdavImage string) (Adapter, error) {
	adapter, err := lookup(ref)
	if err != nil {
		return Adapter{}, err
	}
	adapter.image = map[string]string{"bazel-remote": bazelImage, "webdav-apache": webdavImage}[ref.Name]
	if adapter.image == "" {
		return Adapter{}, fmt.Errorf("template %s has no approved image", ref.Name)
	}
	return adapter, nil
}

// Render enforces template policy and overwrites any caller-provided image.
// Engine adapters enforce budget, storage, resource and digest constraints.
func (a Adapter) Render(c instance.Config, policy string) ([]runtime.Object, error) {
	if a.render == nil {
		return nil, fmt.Errorf("unresolved template")
	}
	if policy != a.policy {
		return nil, fmt.Errorf("template requires %s eviction policy", a.policy)
	}
	c.Image = a.image
	return a.render(c)
}

func (a Adapter) Endpoints(name, namespace string) []cachev1.Endpoint {
	if a.endpoints == nil {
		return nil
	}
	return a.endpoints(name, namespace)
}

// CheckProtocol rejects unknown versions before making any network request.
func CheckProtocol(ctx context.Context, c *cachev1.CacheInstance, s *corev1.Secret) error {
	adapter, err := lookup(c.Spec.TemplateRef)
	if err != nil {
		return err
	}
	return adapter.probe(ctx, c, s)
}

// Describe returns a value copy, independent of deployment image configuration.
func Describe(ref cachev1.TemplateRef) (Capabilities, error) {
	adapter, err := lookup(ref)
	if err != nil {
		return Capabilities{}, err
	}
	return adapter.capabilities, nil
}
