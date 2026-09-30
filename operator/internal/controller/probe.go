package controller

import (
	"context"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/templates"
	corev1 "k8s.io/api/core/v1"
)

type Probe interface {
	Check(context.Context, *cachev1.CacheInstance, *corev1.Secret) error
}

// ProtocolProbe checks cluster-internal protocols through the exact template adapter.
// TLS ingress is certified separately.
type ProtocolProbe struct{}

func (ProtocolProbe) Check(ctx context.Context, c *cachev1.CacheInstance, s *corev1.Secret) error {
	return templates.CheckProtocol(ctx, c, s)
}
