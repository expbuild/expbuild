// Package templates binds exact template versions to trusted compiled adapters.
// Image selection is installation configuration, never instance-controlled code.
package templates

import (
	"context"
	"fmt"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/bazelremote"
	"github.com/expbuild/expbuild/operator/internal/gradlecache"
	"github.com/expbuild/expbuild/operator/internal/instance"
	"github.com/expbuild/expbuild/operator/internal/turbocache"
	"github.com/expbuild/expbuild/operator/internal/webdav"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// Capabilities describes only integrations certified for an exact template version.
// Zero GRPCPort or MetricsPort means unsupported; callers must not invent defaults.
type Capabilities struct {
	HTTPProtocol                 string
	HTTPBasePath                 string
	HTTPPort, GRPCPort           int32
	MetricsPort                  int32
	MetricsPortName, MetricsPath string
}

type Adapter struct {
	capabilities Capabilities
	image        string
	statsImage   string
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
		{Name: "webdav-apache", Version: "0.2.0"}: {
			policy: "none", render: webdav.RenderWithStats,
			capabilities: Capabilities{HTTPProtocol: "webdav", HTTPPort: 8080},
			probe: func(ctx context.Context, c *cachev1.CacheInstance, s *corev1.Secret) error {
				return webdav.CheckProtocol(ctx, s, fmt.Sprintf("http://%s.%s.svc:8080/", c.Name, c.Namespace))
			},
			endpoints: func(name, namespace string) []cachev1.Endpoint {
				return []cachev1.Endpoint{{Protocol: "webdav", URL: fmt.Sprintf("http://%s.%s.svc:8080/", name, namespace)}}
			},
		},
		{Name: "turborepo-http", Version: "0.1.0"}: {
			policy: "lru", render: turbocache.Render,
			capabilities: Capabilities{HTTPProtocol: "turborepo-http", HTTPPort: 8080},
			probe: func(ctx context.Context, c *cachev1.CacheInstance, s *corev1.Secret) error {
				return turbocache.CheckProtocol(ctx, c, s, fmt.Sprintf("http://%s.%s.svc:8080", c.Name, c.Namespace))
			},
			endpoints: func(name, namespace string) []cachev1.Endpoint {
				return []cachev1.Endpoint{{Protocol: "turborepo-http", URL: fmt.Sprintf("http://%s.%s.svc:8080", name, namespace)}}
			},
		},
		{Name: "gradle-http", Version: "0.1.0"}: {
			policy: "lru", render: gradlecache.Render,
			capabilities: Capabilities{HTTPProtocol: "gradle-http", HTTPBasePath: "/cache/", HTTPPort: 8080},
			probe: func(ctx context.Context, c *cachev1.CacheInstance, s *corev1.Secret) error {
				return gradlecache.CheckProtocol(ctx, c, s, fmt.Sprintf("http://%s.%s.svc:8080", c.Name, c.Namespace))
			},
			endpoints: func(name, namespace string) []cachev1.Endpoint {
				return []cachev1.Endpoint{{Protocol: "gradle-http", URL: fmt.Sprintf("http://%s.%s.svc:8080/cache/", name, namespace)}}
			},
		},
	}
	gradleMetrics := adapters[cachev1.TemplateRef{Name: "gradle-http", Version: "0.1.0"}]
	gradleMetrics.capabilities.MetricsPort = 8080
	gradleMetrics.capabilities.MetricsPortName = "http"
	gradleMetrics.capabilities.MetricsPath = "/metrics"
	adapters[cachev1.TemplateRef{Name: "gradle-http", Version: "0.2.0"}] = gradleMetrics
	adapter, ok := adapters[ref]
	if !ok {
		return Adapter{}, fmt.Errorf("unsupported template %s@%s", ref.Name, ref.Version)
	}
	return adapter, nil
}

// Resolve binds a compiled adapter to its administrator-approved image.
func Resolve(ref cachev1.TemplateRef, bazelImage, webdavImage, statsImage, gradleImage string, turborepoImages ...string) (Adapter, error) {
	images := map[string]string{"cache": map[string]string{"bazel-remote": bazelImage, "webdav-apache": webdavImage, "gradle-http": gradleImage}[ref.Name]}
	if ref.Name == "turborepo-http" && len(turborepoImages) == 1 {
		images["cache"] = turborepoImages[0]
	}
	if ref.Name == "webdav-apache" && ref.Version == "0.2.0" {
		images["statistics"] = statsImage
	}
	return Bind(ref, images)
}

// Bind accepts an operator-approved or durably trusted binding. Digest syntax
// alone is not evidence that a legacy workload's image was approved.
func Bind(ref cachev1.TemplateRef, images map[string]string) (Adapter, error) {
	adapter, err := lookup(ref)
	if err != nil {
		return Adapter{}, err
	}
	want := 1
	if ref.Name == "webdav-apache" && ref.Version == "0.2.0" {
		want = 2
		adapter.statsImage = images["statistics"]
		if err := instance.ValidateImage(adapter.statsImage); err != nil {
			return Adapter{}, fmt.Errorf("statistics: %w", err)
		}
	}
	if len(images) != want {
		return Adapter{}, fmt.Errorf("image set differs from the exact template's containers")
	}
	adapter.image = images["cache"]
	if err := instance.ValidateImage(adapter.image); err != nil {
		return Adapter{}, fmt.Errorf("cache: %w", err)
	}
	return adapter, nil
}

func (a Adapter) Images() map[string]string {
	images := map[string]string{"cache": a.image}
	if a.statsImage != "" {
		images["statistics"] = a.statsImage
	}
	return images
}

// Policy reports the exact version's supported engine policy.
func Policy(ref cachev1.TemplateRef) (string, error) {
	adapter, err := lookup(ref)
	if err != nil {
		return "", err
	}
	return adapter.policy, nil
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
	c.StatsImage = a.statsImage
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
