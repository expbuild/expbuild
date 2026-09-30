// Package gateway renders instance routes attached to an administrator-managed
// HTTPS Gateway. It never changes shared listeners, certificates or DNS.
package gateway

import (
	"fmt"
	"strings"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/templates"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

type Config struct {
	Name, Namespace, SectionName, BaseDomain, ControllerName, DataPlaneNamespace string
}

func (c Config) Validate() error {
	for name, value := range map[string]string{"name": c.Name, "namespace": c.Namespace, "section": c.SectionName, "data plane namespace": c.DataPlaneNamespace} {
		if len(validation.IsDNS1123Label(value)) > 0 {
			return fmt.Errorf("gateway %s must be a DNS label", name)
		}
	}
	if len(validation.IsDNS1123Subdomain(c.BaseDomain)) > 0 || !strings.Contains(c.BaseDomain, ".") || len(c.BaseDomain) > 180 {
		return fmt.Errorf("gateway base domain must be a DNS domain of at most 180 characters")
	}
	parts := strings.SplitN(c.ControllerName, "/", 2)
	if len(parts) != 2 || len(validation.IsDNS1123Subdomain(parts[0])) > 0 || parts[1] == "" {
		return fmt.Errorf("gateway controller name must be domain/name")
	}
	return nil
}
func (c Config) Parent() gatewayv1.ParentReference {
	return gatewayv1.ParentReference{Group: ptr.To(gatewayv1.Group("gateway.networking.k8s.io")), Kind: ptr.To(gatewayv1.Kind("Gateway")), Namespace: ptr.To(gatewayv1.Namespace(c.Namespace)), Name: gatewayv1.ObjectName(c.Name), SectionName: ptr.To(gatewayv1.SectionName(c.SectionName))}
}
func (c Config) Host(instance *cachev1.CacheInstance, protocol string) string {
	// The immutable cluster-issued UID prevents two manually created CRs with
	// identical instanceId values from claiming the same hostname.
	return protocol + "-" + string(instance.UID) + "." + c.BaseDomain
}
func (c Config) Render(instance *cachev1.CacheInstance) ([]client.Object, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	capabilities, err := templates.Describe(instance.Spec.TemplateRef)
	if err != nil {
		return nil, err
	}
	if len(validation.IsDNS1123Label("grpc-"+string(instance.UID))) > 0 {
		return nil, fmt.Errorf("instance UID cannot form a DNS hostname")
	}
	labels := map[string]string{"app.kubernetes.io/managed-by": "expbuild", "cache.expbuild.io/project-id": instance.Spec.ProjectID, "cache.expbuild.io/instance-id": instance.Spec.InstanceID, "cache.expbuild.io/instance-uid": string(instance.UID)}
	metadata := func(suffix string) metav1.ObjectMeta {
		return metav1.ObjectMeta{Name: instance.Name + suffix, Namespace: instance.Namespace, Labels: labels}
	}
	backend := func(port int32) gatewayv1.BackendRef {
		return gatewayv1.BackendRef{BackendObjectReference: gatewayv1.BackendObjectReference{Group: ptr.To(gatewayv1.Group("")), Kind: ptr.To(gatewayv1.Kind("Service")), Name: gatewayv1.ObjectName(instance.Name), Port: ptr.To(gatewayv1.PortNumber(port))}, Weight: ptr.To(int32(1))}
	}
	http := &gatewayv1.HTTPRoute{ObjectMeta: metadata("-http"), Spec: gatewayv1.HTTPRouteSpec{CommonRouteSpec: gatewayv1.CommonRouteSpec{ParentRefs: []gatewayv1.ParentReference{c.Parent()}}, Hostnames: []gatewayv1.Hostname{gatewayv1.Hostname(c.Host(instance, "http"))}, Rules: []gatewayv1.HTTPRouteRule{{Matches: []gatewayv1.HTTPRouteMatch{{Path: &gatewayv1.HTTPPathMatch{Type: ptr.To(gatewayv1.PathMatchPathPrefix), Value: ptr.To("/")}}}, BackendRefs: []gatewayv1.HTTPBackendRef{{BackendRef: backend(capabilities.HTTPPort)}}}}}}
	objects := []client.Object{http}
	if capabilities.GRPCPort > 0 {
		objects = append(objects, &gatewayv1.GRPCRoute{ObjectMeta: metadata("-grpc"), Spec: gatewayv1.GRPCRouteSpec{CommonRouteSpec: gatewayv1.CommonRouteSpec{ParentRefs: []gatewayv1.ParentReference{c.Parent()}}, Hostnames: []gatewayv1.Hostname{gatewayv1.Hostname(c.Host(instance, "grpc"))}, Rules: []gatewayv1.GRPCRouteRule{{BackendRefs: []gatewayv1.GRPCBackendRef{{BackendRef: backend(capabilities.GRPCPort)}}}}}})
	}
	ports := []networkingv1.NetworkPolicyPort{{Protocol: ptr.To(corev1.ProtocolTCP), Port: ptr.To(intstr.FromInt32(capabilities.HTTPPort))}}
	if capabilities.GRPCPort > 0 {
		ports = append(ports, networkingv1.NetworkPolicyPort{Protocol: ptr.To(corev1.ProtocolTCP), Port: ptr.To(intstr.FromInt32(capabilities.GRPCPort))})
	}
	objects = append(objects, &networkingv1.NetworkPolicy{ObjectMeta: metadata("-gateway"), Spec: networkingv1.NetworkPolicySpec{PodSelector: metav1.LabelSelector{MatchLabels: labels}, PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress}, Ingress: []networkingv1.NetworkPolicyIngressRule{{From: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"kubernetes.io/metadata.name": c.DataPlaneNamespace}}, PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"cache.expbuild.io/gateway": "true"}}}}, Ports: ports}}}})
	return objects, nil
}
func (c Config) Endpoints(instance *cachev1.CacheInstance) []cachev1.Endpoint {
	capabilities, err := templates.Describe(instance.Spec.TemplateRef)
	if err != nil {
		return nil
	}
	protocol := capabilities.HTTPProtocol
	result := []cachev1.Endpoint{{Protocol: protocol, URL: "https://" + c.Host(instance, "http") + "/"}}
	if capabilities.GRPCPort > 0 {
		result = append(result, cachev1.Endpoint{Protocol: "reapi", URL: "grpcs://" + c.Host(instance, "grpc")})
	}
	return result
}
func condition(conditions []metav1.Condition, kind string, generation int64) bool {
	for _, value := range conditions {
		if value.Type == kind {
			return value.Status == metav1.ConditionTrue && value.ObservedGeneration == generation
		}
	}
	return false
}
func (c Config) Accepted(parents []gatewayv1.RouteParentStatus, generation int64) bool {
	for _, parent := range parents {
		p := parent.ParentRef
		if p.Name != gatewayv1.ObjectName(c.Name) || p.Namespace == nil || *p.Namespace != gatewayv1.Namespace(c.Namespace) || p.SectionName == nil || *p.SectionName != gatewayv1.SectionName(c.SectionName) || (p.Kind != nil && *p.Kind != "Gateway") || (p.Group != nil && *p.Group != "gateway.networking.k8s.io") || string(parent.ControllerName) != c.ControllerName {
			continue
		}
		if condition(parent.Conditions, "Accepted", generation) && condition(parent.Conditions, "ResolvedRefs", generation) {
			return true
		}
	}
	return false
}
func (c Config) Ready(g *gatewayv1.Gateway) bool {
	if g.DeletionTimestamp != nil || !condition(g.Status.Conditions, "Programmed", g.Generation) || !condition(g.Status.Conditions, "Accepted", g.Generation) {
		return false
	}
	for _, listener := range g.Spec.Listeners {
		if string(listener.Name) != c.SectionName || listener.Protocol != gatewayv1.HTTPSProtocolType || listener.Port != 443 || listener.TLS == nil || len(listener.TLS.CertificateRefs) == 0 || (listener.TLS.Mode != nil && *listener.TLS.Mode != gatewayv1.TLSModeTerminate) {
			continue
		}
		for _, status := range g.Status.Listeners {
			if status.Name == listener.Name && condition(status.Conditions, "Accepted", g.Generation) && condition(status.Conditions, "ResolvedRefs", g.Generation) && condition(status.Conditions, "Programmed", g.Generation) {
				return true
			}
		}
	}
	return false
}
