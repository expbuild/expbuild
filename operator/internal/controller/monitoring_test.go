package controller

import (
	"context"
	"fmt"
	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/monitoring"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"os"
	"path/filepath"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	"testing"
	"time"
)

func TestMonitoringAPIServerContract(t *testing.T) {
	crds := os.Getenv("MONITORING_CRDS")
	if crds == "" || os.Getenv("KUBEBUILDER_ASSETS") == "" {
		t.Skip("requires isolated API server and pinned ServiceMonitor CRD")
	}
	e := &envtest.Environment{CRDDirectoryPaths: []string{filepath.Join("..", "..", "config", "crd"), crds}, ErrorIfCRDPathMissing: true}
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
	cl, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		t.Fatal(err)
	}
	r, c := setup(t)
	r.Client = cl
	r.Reader = cl
	r.Monitoring = &monitoring.Config{Namespace: "monitoring"}
	ctx := context.Background()
	c.UID = ""
	c.ResourceVersion = ""
	c.Generation = 0
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: c.Namespace, Labels: map[string]string{"app.kubernetes.io/managed-by": "expbuild", ProjectLabel: c.Spec.ProjectID}}}
	if err := cl.Create(ctx, ns); err != nil {
		t.Fatal(err)
	}
	if err := cl.Create(ctx, c); err != nil {
		t.Fatal(err)
	}
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "auth", Namespace: c.Namespace, Labels: map[string]string{ProjectLabel: c.Spec.ProjectID, InstanceLabel: c.Spec.InstanceID}}, Data: map[string][]byte{"htpasswd": []byte("fixture"), "probe-username": []byte("cache"), "probe-password": []byte("fixture")}}
	if err := cl.Create(ctx, secret); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, c)
	reconcile(t, r, c)
	get := func() *unstructured.Unstructured {
		t.Helper()
		m := monitoring.Monitor(c.Name+"-metrics", c.Namespace)
		if err := cl.Get(ctx, client.ObjectKeyFromObject(m), m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	m := get()
	rv := m.GetResourceVersion()
	if err := cl.Get(ctx, client.ObjectKeyFromObject(c), c); err != nil {
		t.Fatal(err)
	}
	statusRV := c.ResourceVersion
	time.Sleep(1100 * time.Millisecond) // Conditions have second-resolution transition times.
	reconcile(t, r, c)
	if err := cl.Get(ctx, client.ObjectKeyFromObject(c), c); err != nil {
		t.Fatal(err)
	}
	if c.ResourceVersion != statusRV {
		t.Fatal("unchanged monitor configuration churned instance status")
	}

	if get().GetResourceVersion() != rv {
		t.Fatal("defaulting caused repeated ServiceMonitor writes")
	}
	secret.ResourceVersion = ""
	secret.UID = ""
	secret.Name = "auth-v2"
	if err := cl.Create(ctx, secret); err != nil {
		t.Fatal(err)
	}
	if err := cl.Get(ctx, client.ObjectKeyFromObject(c), c); err != nil {
		t.Fatal(err)
	}
	c.Spec.Access.CredentialsSecretRef = secret.Name
	if err := cl.Update(ctx, c); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, c)
	endpoints, _, _ := unstructured.NestedSlice(get().Object, "spec", "endpoints")
	if endpoints[0].(map[string]any)["basicAuth"].(map[string]any)["password"].(map[string]any)["name"] != "auth-v2" {
		t.Fatal("credential rotation not reflected in monitor")
	}
	// A conflicting owner is never adopted or overwritten; its failure is a
	// monitoring condition rather than a cache availability failure.
	foreign := get()
	owners := foreign.GetOwnerReferences()
	owners[0].UID = "foreign"
	foreign.SetOwnerReferences(owners)
	if err := cl.Update(ctx, foreign); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, c)
	if err := cl.Get(ctx, client.ObjectKeyFromObject(c), c); err != nil {
		t.Fatal(err)
	}
	if condition := meta.FindStatusCondition(c.Status.Conditions, "MonitoringConfigured"); condition == nil || condition.Status != metav1.ConditionFalse {
		t.Fatal("foreign resource was reported configured")
	}
	if metav1.GetControllerOf(get()).UID != "foreign" {
		t.Fatal("adopted foreign monitor")
	}
	if err := cl.Delete(ctx, foreign); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, c)
	// Pause revokes the collector target and ingress, then resume recreates them.
	if err := cl.Get(ctx, client.ObjectKeyFromObject(c), c); err != nil {
		t.Fatal(err)
	}
	c.Spec.DesiredState = "Suspended"
	if err := cl.Update(ctx, c); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, c)
	reconcile(t, r, c)
	paused := monitoring.Monitor(c.Name+"-metrics", c.Namespace)
	if err := cl.Get(ctx, client.ObjectKeyFromObject(paused), paused); !apierrors.IsNotFound(err) {
		t.Fatalf("paused monitor remains: %v", err)
	}
	var policy networkingv1.NetworkPolicy
	if err := cl.Get(ctx, client.ObjectKey{Namespace: c.Namespace, Name: c.Name + "-metrics"}, &policy); !apierrors.IsNotFound(err) {
		t.Fatalf("paused monitoring ingress remains: %v", err)
	}
	if err := cl.Get(ctx, client.ObjectKeyFromObject(c), c); err != nil {
		t.Fatal(err)
	}
	c.Spec.DesiredState = "Running"
	if err := cl.Update(ctx, c); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, c)
	reconcile(t, r, c)
	_ = get()
	// Disabling integration must still clean the resources tracked by its marker.
	r.Monitoring = nil
	reconcile(t, r, c)
	reconcile(t, r, c)
	m = monitoring.Monitor(c.Name+"-metrics", c.Namespace)
	if err := cl.Get(ctx, client.ObjectKeyFromObject(m), m); !apierrors.IsNotFound(err) {
		t.Fatalf("monitor still present: %v", err)
	}
	if err := cl.Get(ctx, client.ObjectKeyFromObject(c), c); err != nil {
		t.Fatal(err)
	}
	if controllerutil.ContainsFinalizer(c, MonitoringFinalizer) {
		t.Fatal("monitor cleanup marker remained")
	}
	r.Monitoring = &monitoring.Config{Namespace: "monitoring"}
	reconcile(t, r, c)
	reconcile(t, r, c)
	_ = get()
	if err := cl.Get(ctx, client.ObjectKeyFromObject(c), c); err != nil {
		t.Fatal(err)
	}
	if err := cl.Delete(ctx, c); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		reconcile(t, r, c)
	}
	if err := cl.Get(ctx, client.ObjectKeyFromObject(c), c); !apierrors.IsNotFound(err) {
		t.Fatalf("instance deletion did not complete: %v", err)
	}
	if err := cl.Get(ctx, client.ObjectKeyFromObject(m), m); !apierrors.IsNotFound(err) {
		t.Fatalf("deleted instance monitor remains: %v", err)
	}
}

type unavailableMonitoringReader struct{ client.Reader }

func (r unavailableMonitoringReader) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if obj.GetObjectKind().GroupVersionKind() == monitoring.GVK {
		return fmt.Errorf("monitoring API unavailable")
	}
	return r.Reader.Get(ctx, key, obj, opts...)
}
