package controller

import (
	"context"
	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/gateway"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"os"
	"path/filepath"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
	"testing"
)

func gatewayConfig() *gateway.Config {
	return &gateway.Config{Name: "shared", Namespace: "edge", SectionName: "https", BaseDomain: "cache.example.test", ControllerName: "example.test/controller", DataPlaneNamespace: "edge"}
}
func TestGatewayCleanupOwnership(t *testing.T) {
	r, c := setup(t)
	_ = gatewayv1.Install(r.Scheme())
	_ = networkingv1.AddToScheme(r.Scheme())
	r.Gateway = gatewayConfig()
	ctx := context.Background()
	if err := r.applyGateway(ctx, c); err != nil {
		t.Fatal(err)
	}
	var route gatewayv1.HTTPRoute
	key := types.NamespacedName{Namespace: c.Namespace, Name: c.Name + "-http"}
	if err := r.Get(ctx, key, &route); err != nil {
		t.Fatal(err)
	}
	route.Labels[UIDLabel] = "foreign"
	if err := r.Update(ctx, &route); err != nil {
		t.Fatal(err)
	}
	if _, err := r.removeGateway(ctx, c); err == nil {
		t.Fatal("foreign route deleted")
	}
	if err := r.applyGateway(ctx, c); err == nil {
		t.Fatal("foreign route adopted")
	}
	route.Labels[UIDLabel] = string(c.UID)
	if err := r.Update(ctx, &route); err != nil {
		t.Fatal(err)
	}
	r.Gateway = nil // Cleanup must remain possible after new provisioning is disabled.
	if pending, err := r.removeGateway(ctx, c); err != nil || !pending {
		t.Fatal(pending, err)
	}
	if pending, err := r.removeGateway(ctx, c); err != nil || pending {
		t.Fatal(pending, err)
	}
}
func TestGatewayMarkerAndSuspension(t *testing.T) {
	r, c := setup(t)
	_ = gatewayv1.Install(r.Scheme())
	_ = networkingv1.AddToScheme(r.Scheme())
	r.Gateway = gatewayConfig()
	ctx := context.Background()
	c.Spec.Access.Exposure = "Gateway"
	if err := r.Update(ctx, c); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, c)
	reconcile(t, r, c)
	if err := r.Get(ctx, client.ObjectKeyFromObject(c), c); err != nil {
		t.Fatal(err)
	}
	if !controllerutil.ContainsFinalizer(c, GatewayFinalizer) {
		t.Fatal("gateway ownership marker missing")
	}
	c.Spec.DesiredState = "Suspended"
	if err := r.Update(ctx, c); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, c)
	reconcile(t, r, c)
	if err := r.Get(ctx, client.ObjectKeyFromObject(c), c); err != nil {
		t.Fatal(err)
	}
	if controllerutil.ContainsFinalizer(c, GatewayFinalizer) {
		t.Fatal("gateway cleanup marker retained after routes removed")
	}
	var routes gatewayv1.HTTPRouteList
	if err := r.List(ctx, &routes); err != nil || len(routes.Items) != 0 {
		t.Fatal("suspension left HTTP routes", err)
	}
}
func TestGatewayAPIServerContract(t *testing.T) {
	path := os.Getenv("GATEWAY_API_CRDS")
	if os.Getenv("KUBEBUILDER_ASSETS") == "" || path == "" {
		t.Skip("set KUBEBUILDER_ASSETS and GATEWAY_API_CRDS for real Gateway CRD validation")
	}
	e := &envtest.Environment{CRDDirectoryPaths: []string{filepath.Join("..", "..", "config", "crd"), path}, ErrorIfCRDPathMissing: true}
	cfg, err := e.Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := e.Stop(); err != nil {
			t.Error(err)
		}
	})
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	_ = appsv1.AddToScheme(scheme)
	_ = networkingv1.AddToScheme(scheme)
	_ = cachev1.AddToScheme(scheme)
	_ = gatewayv1.Install(scheme)
	cl, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	_, c := setup(t)
	c.UID = ""
	c.Generation = 0
	c.ResourceVersion = ""
	c.Spec.Access.Exposure = "Gateway"
	if err := cl.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: c.Namespace}}); err != nil {
		t.Fatal(err)
	}
	if err := cl.Create(ctx, c); err != nil {
		t.Fatal(err)
	}
	r := &Reconciler{Client: cl, Reader: cl, Gateway: gatewayConfig()}
	if err := r.applyGateway(ctx, c); err != nil {
		t.Fatal(err)
	}
	var route gatewayv1.HTTPRoute
	key := types.NamespacedName{Namespace: c.Namespace, Name: c.Name + "-http"}
	if err := cl.Get(ctx, key, &route); err != nil {
		t.Fatal(err)
	}
	version := route.ResourceVersion
	if err := r.applyGateway(ctx, c); err != nil {
		t.Fatal(err)
	}
	if err := cl.Get(ctx, key, &route); err != nil {
		t.Fatal(err)
	}
	if version != route.ResourceVersion {
		t.Fatal("API defaults cause endless route updates")
	}
	// These statuses are simulated: this verifies observation fencing, not proxy
	// configuration or TLS traffic. A real data-plane test remains required.
	if err := cl.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "edge"}}); err != nil {
		t.Fatal(err)
	}
	g := &gatewayv1.Gateway{ObjectMeta: metav1.ObjectMeta{Name: "shared", Namespace: "edge"}, Spec: gatewayv1.GatewaySpec{GatewayClassName: "test", Listeners: []gatewayv1.Listener{{Name: "https", Protocol: gatewayv1.HTTPSProtocolType, Port: 443, TLS: &gatewayv1.GatewayTLSConfig{CertificateRefs: []gatewayv1.SecretObjectReference{{Name: "wildcard"}}}}}}}
	if err := cl.Create(ctx, g); err != nil {
		t.Fatal(err)
	}
	conditions := func(generation int64, kinds ...string) []metav1.Condition {
		values := []metav1.Condition{}
		for _, kind := range kinds {
			values = append(values, metav1.Condition{Type: kind, Status: metav1.ConditionTrue, Reason: "Accepted", Message: "test controller observation", ObservedGeneration: generation, LastTransitionTime: metav1.Now()})
		}
		return values
	}
	g.Status.Conditions = conditions(g.Generation, "Accepted", "Programmed")
	g.Status.Listeners = []gatewayv1.ListenerStatus{{Name: "https", SupportedKinds: []gatewayv1.RouteGroupKind{{Kind: "HTTPRoute"}, {Kind: "GRPCRoute"}}, AttachedRoutes: 2, Conditions: conditions(g.Generation, "Accepted", "ResolvedRefs", "Programmed")}}
	if err := cl.Status().Update(ctx, g); err != nil {
		t.Fatal(err)
	}
	if ready, err := r.gatewayReady(ctx, c); err != nil || ready {
		t.Fatal("unaccepted routes reported ready", ready, err)
	}
	parents := func(generation int64) []gatewayv1.RouteParentStatus {
		return []gatewayv1.RouteParentStatus{{ParentRef: r.Gateway.Parent(), ControllerName: gatewayv1.GatewayController(r.Gateway.ControllerName), Conditions: conditions(generation, "Accepted", "ResolvedRefs")}}
	}
	route.Status.Parents = parents(route.Generation)
	if err := cl.Status().Update(ctx, &route); err != nil {
		t.Fatal(err)
	}
	var grpc gatewayv1.GRPCRoute
	if err := cl.Get(ctx, types.NamespacedName{Name: c.Name + "-grpc", Namespace: c.Namespace}, &grpc); err != nil {
		t.Fatal(err)
	}
	grpc.Status.Parents = parents(grpc.Generation)
	if err := cl.Status().Update(ctx, &grpc); err != nil {
		t.Fatal(err)
	}
	if ready, err := r.gatewayReady(ctx, c); err != nil || !ready {
		t.Fatal("current accepted routes rejected", ready, err)
	}
	*route.Spec.Rules[0].BackendRefs[0].Port = 9092
	if err := cl.Update(ctx, &route); err != nil {
		t.Fatal(err)
	}
	route.Status.Parents = parents(route.Generation)
	if err := cl.Status().Update(ctx, &route); err != nil {
		t.Fatal(err)
	}
	if ready, err := r.gatewayReady(ctx, c); err != nil || ready {
		t.Fatal("externally changed route accepted", ready, err)
	}

	if pending, err := r.removeGateway(ctx, c); err != nil || !pending {
		t.Fatal(pending, err)
	}
	if pending, err := r.removeGateway(ctx, c); err != nil || pending {
		t.Fatal(pending, err)
	}
}
