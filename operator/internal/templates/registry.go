// Package templates binds exact template versions to trusted compiled adapters.
// Image selection is installation configuration, never instance-controlled code.
package templates

import (
	"fmt"
	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/bazelremote"
	"github.com/expbuild/expbuild/operator/internal/instance"
	"github.com/expbuild/expbuild/operator/internal/webdav"
	"k8s.io/apimachinery/pkg/runtime"
)

type Adapter struct {
	image     string
	policy    string
	render    func(instance.Config) ([]runtime.Object, error)
	endpoints func(string, string) []cachev1.Endpoint
}

// Resolve fails closed on unknown versions; there is no fallback to latest.
func Resolve(ref cachev1.TemplateRef, bazelImage, webdavImage string) (Adapter, error) {
	adapters := map[cachev1.TemplateRef]Adapter{
		{Name: "bazel-remote", Version: "0.1.0"}: {
			image: bazelImage, policy: "lru", render: bazelremote.Render,
			endpoints: func(name, namespace string) []cachev1.Endpoint {
				return []cachev1.Endpoint{{Protocol: "reapi", URL: fmt.Sprintf("grpc://%s.%s.svc:9092", name, namespace)}, {Protocol: "bazel-http", URL: fmt.Sprintf("http://%s.%s.svc:8080", name, namespace)}}
			},
		},
		{Name: "webdav-apache", Version: "0.1.0"}: {
			image: webdavImage, policy: "none", render: webdav.Render,
			endpoints: func(name, namespace string) []cachev1.Endpoint {
				return []cachev1.Endpoint{{Protocol: "webdav", URL: fmt.Sprintf("http://%s.%s.svc:8080/", name, namespace)}}
			},
		},
	}
	adapter, ok := adapters[ref]
	if !ok {
		return Adapter{}, fmt.Errorf("unsupported template %s@%s", ref.Name, ref.Version)
	}
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
