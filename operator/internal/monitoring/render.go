// Package monitoring renders optional Prometheus Operator integration resources.
package monitoring

import (
	"fmt"
	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/utils/ptr"
	"regexp"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

var GVK = schema.GroupVersionKind{Group: "monitoring.coreos.com", Version: "v1", Kind: "ServiceMonitor"}

type Config struct{ Namespace string }

func (c Config) Validate() error {
	if len(validation.IsDNS1123Label(c.Namespace)) != 0 {
		return fmt.Errorf("monitoring namespace must be a DNS label")
	}
	return nil
}
func Monitor(name, namespace string) *unstructured.Unstructured {
	m := &unstructured.Unstructured{}
	m.SetGroupVersionKind(GVK)
	m.SetName(name)
	m.SetNamespace(namespace)
	return m
}
func (cfg Config) Render(c *cachev1.CacheInstance) ([]client.Object, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if c.Spec.TemplateRef.Name != "bazel-remote" || c.UID == "" {
		return nil, fmt.Errorf("monitoring requires a bound bazel-remote instance")
	}
	labels := map[string]string{"app.kubernetes.io/managed-by": "expbuild", "cache.expbuild.io/project-id": c.Spec.ProjectID, "cache.expbuild.io/instance-id": c.Spec.InstanceID, "cache.expbuild.io/instance-uid": string(c.UID)}
	selector := map[string]any{}
	for key, value := range labels {
		selector[key] = value
	}
	identity := []any{
		map[string]any{"action": "replace", "targetLabel": "expbuild_project_id", "replacement": c.Spec.ProjectID},
		map[string]any{"action": "replace", "targetLabel": "expbuild_instance_uid", "replacement": string(c.UID)},
	}
	m := Monitor(c.Name+"-metrics", c.Namespace)
	m.SetLabels(labels)
	m.Object["spec"] = map[string]any{
		"selector":          map[string]any{"matchLabels": selector},
		"namespaceSelector": map[string]any{"matchNames": []any{c.Namespace}},
		"sampleLimit":       int64(10000),
		"endpoints": []any{map[string]any{
			"port": "http", "path": "/metrics", "scheme": "http", "interval": "30s", "scrapeTimeout": "5s", "followRedirects": false, "honorLabels": false, "honorTimestamps": false,
			"basicAuth": map[string]any{
				"username": map[string]any{"name": c.Spec.Access.CredentialsSecretRef, "key": "probe-username"},
				"password": map[string]any{"name": c.Spec.Access.CredentialsSecretRef, "key": "probe-password"},
			},
			// The headless Service has identical ownership labels. Select only the
			// client Service to avoid collecting the same engine twice.
			"relabelings":       append([]any{map[string]any{"action": "keep", "sourceLabels": []any{"__meta_kubernetes_service_name"}, "regex": regexp.QuoteMeta(c.Name)}}, identity...),
			"metricRelabelings": identity,
		}},
	}
	policy := &networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: c.Name + "-metrics", Namespace: c.Namespace, Labels: labels}, Spec: networkingv1.NetworkPolicySpec{
		PodSelector: metav1.LabelSelector{MatchLabels: labels}, PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
		Ingress: []networkingv1.NetworkPolicyIngressRule{{From: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"kubernetes.io/metadata.name": cfg.Namespace}}, PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"cache.expbuild.io/monitoring": "true"}}}}, Ports: []networkingv1.NetworkPolicyPort{{Protocol: ptr.To(corev1.ProtocolTCP), Port: ptr.To(intstr.FromInt32(8080))}}}},
	}}
	return []client.Object{m, policy}, nil
}
