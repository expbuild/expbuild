package gateway

import (
	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
	"testing"
)

func TestRoutesAndStatus(t *testing.T) {
	cfg := Config{Name: "shared", Namespace: "edge", SectionName: "https", BaseDomain: "cache.example.test", ControllerName: "example.test/controller", DataPlaneNamespace: "edge-pods"}
	c := &cachev1.CacheInstance{ObjectMeta: metav1.ObjectMeta{Name: "cache", Namespace: "project", UID: "unique-uid"}, Spec: cachev1.CacheInstanceSpec{InstanceID: "id", ProjectID: "p", TemplateRef: cachev1.TemplateRef{Name: "bazel-remote"}}}
	objects, err := cfg.Render(c)
	if err != nil {
		t.Fatal(err)
	}
	http := objects[0].(*gatewayv1.HTTPRoute)
	grpc := objects[1].(*gatewayv1.GRPCRoute)
	policy := objects[2].(*networkingv1.NetworkPolicy)
	if http.Spec.Hostnames[0] == grpc.Spec.Hostnames[0] || string(http.Spec.Hostnames[0]) != "http-unique-uid.cache.example.test" {
		t.Fatal("protocol hostnames must be unique")
	}
	if *http.Spec.Rules[0].BackendRefs[0].Port != 8080 || *grpc.Spec.Rules[0].BackendRefs[0].Port != 9092 {
		t.Fatal("wrong backend ports")
	}
	peer := policy.Spec.Ingress[0].From[0]
	if peer.NamespaceSelector.MatchLabels["kubernetes.io/metadata.name"] != "edge-pods" || peer.PodSelector.MatchLabels["cache.expbuild.io/gateway"] != "true" {
		t.Fatal("gateway namespace and Pod labels must both match")
	}
	c.UID = "different-uid"
	if cfg.Host(c, "http") == string(http.Spec.Hostnames[0]) {
		t.Fatal("recreated instance reused hostname")
	}
	c.Spec.TemplateRef.Name = "webdav-apache"
	webdav, err := cfg.Render(c)
	if err != nil || len(webdav) != 2 {
		t.Fatal("WebDAV must not render a gRPC route", err)
	}
	if len(webdav[1].(*networkingv1.NetworkPolicy).Spec.Ingress[0].Ports) != 1 {
		t.Fatal("WebDAV must not expose gRPC port")
	}
	conditions := []metav1.Condition{{Type: "Accepted", Status: metav1.ConditionTrue, ObservedGeneration: 2}, {Type: "ResolvedRefs", Status: metav1.ConditionTrue, ObservedGeneration: 2}}
	parents := []gatewayv1.RouteParentStatus{{ParentRef: cfg.Parent(), ControllerName: gatewayv1.GatewayController(cfg.ControllerName), Conditions: conditions}}
	if !cfg.Accepted(parents, 2) || cfg.Accepted(parents, 3) {
		t.Fatal("route acceptance must match current generation")
	}
	parents[0].ControllerName = "foreign/controller"
	if cfg.Accepted(parents, 2) {
		t.Fatal("foreign controller status accepted")
	}
	parents[0].ControllerName = gatewayv1.GatewayController(cfg.ControllerName)
	parents[0].ParentRef.SectionName = ptr.To(gatewayv1.SectionName("other"))
	if cfg.Accepted(parents, 2) {
		t.Fatal("wrong listener status accepted")
	}
	parents[0].ParentRef = cfg.Parent()
	parents[0].Conditions[1].Status = metav1.ConditionFalse
	if cfg.Accepted(parents, 2) {
		t.Fatal("unresolved backend accepted")
	}
	cfg.BaseDomain = "https://bad.example.test"
	if _, err := cfg.Render(c); err == nil {
		t.Fatal("invalid domain accepted")
	}
}
func TestHTTPSGatewayReadiness(t *testing.T) {
	cfg := Config{SectionName: "https"}
	conditions := []metav1.Condition{{Type: "Accepted", Status: metav1.ConditionTrue, ObservedGeneration: 3}, {Type: "ResolvedRefs", Status: metav1.ConditionTrue, ObservedGeneration: 3}, {Type: "Programmed", Status: metav1.ConditionTrue, ObservedGeneration: 3}}
	g := &gatewayv1.Gateway{ObjectMeta: metav1.ObjectMeta{Generation: 3}, Spec: gatewayv1.GatewaySpec{Listeners: []gatewayv1.Listener{{Name: "https", Protocol: gatewayv1.HTTPSProtocolType, Port: 443, TLS: &gatewayv1.GatewayTLSConfig{CertificateRefs: []gatewayv1.SecretObjectReference{{Name: "wildcard"}}}}}}, Status: gatewayv1.GatewayStatus{Conditions: conditions, Listeners: []gatewayv1.ListenerStatus{{Name: "https", Conditions: conditions}}}}
	if !cfg.Ready(g) {
		t.Fatal("current programmed HTTPS listener rejected")
	}
	g.Spec.Listeners[0].Protocol = gatewayv1.HTTPProtocolType
	if cfg.Ready(g) {
		t.Fatal("plaintext listener accepted")
	}
	g.Spec.Listeners[0].Protocol = gatewayv1.HTTPSProtocolType
	g.Generation++
	if cfg.Ready(g) {
		t.Fatal("stale gateway status accepted")
	}
	g.Generation--
	g.Spec.Listeners[0].TLS = nil
	if cfg.Ready(g) {
		t.Fatal("missing TLS configuration accepted")
	}
}
