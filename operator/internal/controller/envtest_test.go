package controller

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	appsv1 "k8s.io/api/apps/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/yaml"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
)

func TestAPIServerContract(t *testing.T) {
	if os.Getenv("KUBEBUILDER_ASSETS") == "" {
		t.Skip("set KUBEBUILDER_ASSETS to run real API server contract tests")
	}
	e := &envtest.Environment{CRDDirectoryPaths: []string{filepath.Join("..", "..", "config", "crd")}, ErrorIfCRDPathMissing: true}
	e.ControlPlane.GetAPIServer().Configure().Set("authorization-mode", "RBAC")
	cfg, err := e.Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := e.Stop(); err != nil {
			t.Error(err)
		}
	})
	s := runtime.NewScheme()
	_ = corev1.AddToScheme(s)
	_ = appsv1.AddToScheme(s)
	_ = cachev1.AddToScheme(s)
	_ = authorizationv1.AddToScheme(s)
	cl, err := client.New(cfg, client.Options{Scheme: s})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	t.Run("deployment RBAC", func(t *testing.T) { checkRBAC(t, ctx, cl) })
	t.Run("Helm deployment", func(t *testing.T) { checkChart(t, ctx, cl) })
	if err = cl.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "demo", Labels: map[string]string{"app.kubernetes.io/managed-by": "expbuild", ProjectLabel: "project-1"}}}); err != nil {
		t.Fatal(err)
	}
	_, c := setup(t)
	c.UID = ""
	c.Generation = 0
	c.ResourceVersion = ""
	if err = cl.Create(ctx, c); err != nil {
		t.Fatal(err)
	}
	c.Spec.ProjectID = "other-project"
	if err = cl.Update(ctx, c); !apierrors.IsInvalid(err) {
		t.Fatalf("immutable project accepted: %v", err)
	}
	if err = cl.Get(ctx, client.ObjectKeyFromObject(c), c); err != nil {
		t.Fatal(err)
	}
	t.Run("retained volume identity is immutable", func(t *testing.T) {
		reclaimed := c.DeepCopy()
		reclaimed.Name = "reclaim-schema-check"
		reclaimed.UID = ""
		reclaimed.ResourceVersion = ""
		reclaimed.Generation = 0
		reclaimed.Status = cachev1.CacheInstanceStatus{}
		reclaimed.Spec.Storage.Reclaim = &cachev1.ReclaimSpec{PreviousInstanceUID: "old-instance", VolumeUID: "volume-one"}
		if err := cl.Create(ctx, reclaimed); err != nil {
			t.Fatal(err)
		}
		reclaimed.Spec.Storage.Reclaim.VolumeUID = "volume-two"
		if err := cl.Update(ctx, reclaimed); !apierrors.IsInvalid(err) {
			t.Fatalf("retained PVC identity mutation accepted: %v", err)
		}
	})
	c.Spec.DesiredState = "Suspended"
	if err = cl.Update(ctx, c); err != nil {
		t.Fatal(err)
	}
	if c.Generation != 2 {
		t.Fatalf("expected spec generation increment: %d", c.Generation)
	}
	c.Status.ObservedGeneration = c.Generation
	if err = cl.Status().Update(ctx, c); err != nil {
		t.Fatal(err)
	}
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "auth", Namespace: "demo", Labels: map[string]string{InstanceLabel: c.Spec.InstanceID, ProjectLabel: c.Spec.ProjectID}}, Data: map[string][]byte{"htpasswd": []byte("fixture")}}
	if err = cl.Create(ctx, secret); err != nil {
		t.Fatal(err)
	}
	local, _ := setup(t)
	r := &Reconciler{Client: cl, Reader: cl, Image: local.Image}
	reconcile(t, r, c)
	var sts appsv1.StatefulSet
	if err = cl.Get(ctx, client.ObjectKeyFromObject(c), &sts); err != nil {
		t.Fatal(err)
	}
	if *sts.Spec.Replicas != 0 || !metav1.IsControlledBy(&sts, c) {
		t.Fatal("unexpected reconciled workload")
	}
	t.Run("WebDAV capability validation", func(t *testing.T) {
		dav := c.DeepCopy()
		dav.Name = "dav-demo"
		dav.ResourceVersion = ""
		dav.UID = ""
		dav.Generation = 0
		dav.Finalizers = nil
		dav.Status = cachev1.CacheInstanceStatus{}
		dav.Spec.InstanceID = "dav-1"
		dav.Spec.TemplateRef.Name = "webdav-apache"
		dav.Spec.Eviction.EnginePolicy = "none"
		if err := cl.Create(ctx, dav); !apierrors.IsInvalid(err) {
			t.Fatalf("WebDAV cache budget was accepted: %v", err)
		}
		dav.Spec.Eviction.MaxCacheGiB = 0
		if err := cl.Create(ctx, dav); err != nil {
			t.Fatal(err)
		}
		credential := secret.DeepCopy()
		credential.ResourceVersion = ""
		credential.UID = ""
		credential.Name = "dav-auth"
		credential.Labels[InstanceLabel] = dav.Spec.InstanceID
		if err := cl.Create(ctx, credential); err != nil {
			t.Fatal(err)
		}
		dav.Spec.Access.CredentialsSecretRef = credential.Name
		if err := cl.Update(ctx, dav); err != nil {
			t.Fatal(err)
		}
		r.WebDAVImage = local.Image
		reconcile(t, r, dav)
		var service corev1.Service
		if err := cl.Get(ctx, client.ObjectKeyFromObject(dav), &service); err != nil {
			t.Fatal(err)
		}
		if len(service.Spec.Ports) != 1 || service.Spec.Ports[0].Name != "http" {
			t.Fatal("WebDAV incorrectly exposed additional protocols")
		}
	})
	t.Run("versioned WebDAV admission", func(t *testing.T) {
		valid := c.DeepCopy()
		valid.Name, valid.ResourceVersion, valid.UID = "dav-stats", "", ""
		valid.Generation = 0
		valid.Finalizers = nil
		valid.Status = cachev1.CacheInstanceStatus{}
		valid.Spec.InstanceID = "dav-stats"
		valid.Spec.TemplateRef = cachev1.TemplateRef{Name: "webdav-apache", Version: "0.2.0"}
		valid.Spec.Eviction.EnginePolicy = "none"
		valid.Spec.Eviction.MaxCacheGiB = 0
		if err := cl.Create(ctx, valid); err != nil {
			t.Fatalf("WebDAV 0.2.0 rejected: %v", err)
		}
		invalid := valid.DeepCopy()
		invalid.Name, invalid.ResourceVersion, invalid.UID = "invalid-bazel-version", "", ""
		invalid.Generation = 0
		invalid.Finalizers = nil
		invalid.Status = cachev1.CacheInstanceStatus{}
		invalid.Spec.InstanceID = "invalid-bazel-version"
		invalid.Spec.TemplateRef.Name = "bazel-remote"
		invalid.Spec.Eviction.EnginePolicy = "lru"
		invalid.Spec.Eviction.MaxCacheGiB = 1
		if err := cl.Create(ctx, invalid); !apierrors.IsInvalid(err) {
			t.Fatalf("unsupported bazel-remote version accepted: %v", err)
		}
	})
	t.Run("Gradle HTTP admission and isolated Service", func(t *testing.T) {
		gradle := c.DeepCopy()
		gradle.Name, gradle.ResourceVersion, gradle.UID = "gradle-cache", "", ""
		gradle.Generation = 0
		gradle.Finalizers = nil
		gradle.Status = cachev1.CacheInstanceStatus{}
		gradle.Spec.InstanceID = "gradle-cache"
		gradle.Spec.TemplateRef = cachev1.TemplateRef{Name: "gradle-http", Version: "0.1.0"}
		if err := cl.Create(ctx, gradle); err != nil {
			t.Fatalf("Gradle 0.1.0 rejected: %v", err)
		}
		credential := secret.DeepCopy()
		credential.ResourceVersion, credential.UID = "", ""
		credential.Name = "gradle-auth"
		credential.Labels[InstanceLabel] = gradle.Spec.InstanceID
		if err := cl.Create(ctx, credential); err != nil {
			t.Fatal(err)
		}
		gradle.Spec.Access.CredentialsSecretRef = credential.Name
		if err := cl.Update(ctx, gradle); err != nil {
			t.Fatal(err)
		}
		r.GradleImage = local.Image
		reconcile(t, r, gradle)
		var service corev1.Service
		if err := cl.Get(ctx, client.ObjectKeyFromObject(gradle), &service); err != nil {
			t.Fatal(err)
		}
		if len(service.Spec.Ports) != 1 || service.Spec.Ports[0].Name != "http" {
			t.Fatal("Gradle exposed unexpected ports")
		}
		invalid := gradle.DeepCopy()
		invalid.Name, invalid.ResourceVersion, invalid.UID = "invalid-gradle-version", "", ""
		invalid.Generation = 0
		invalid.Finalizers = nil
		invalid.Status = cachev1.CacheInstanceStatus{}
		invalid.Spec.InstanceID = "invalid-gradle-version"
		invalid.Spec.TemplateRef.Version = "0.3.0"
		if err := cl.Create(ctx, invalid); !apierrors.IsInvalid(err) {
			t.Fatalf("unsupported Gradle version accepted: %v", err)
		}
	})
}

func checkRBAC(t *testing.T, ctx context.Context, cl client.Client) {
	t.Helper()
	if err := cl.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "expbuild-system"}}); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(filepath.Join("..", "..", "config", "rbac.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	decoder := yaml.NewYAMLOrJSONDecoder(f, 4096)
	for {
		var object unstructured.Unstructured
		if err := decoder.Decode(&object); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		if len(object.Object) == 0 {
			continue
		}
		if err := cl.Create(ctx, &object); err != nil {
			t.Fatal(err)
		}
	}
	for _, permission := range []struct {
		verb, group, resource, namespace string
		allowed                          bool
	}{
		{"get", "", "secrets", "demo", true},
		{"update", "", "secrets", "demo", false},
		{"delete", "", "persistentvolumes", "", false},
		{"create", "apps", "statefulsets", "demo", true},
		{"get", "", "namespaces", "", true},
		{"create", "coordination.k8s.io", "leases", "expbuild-system", true},
		{"create", "coordination.k8s.io", "leases", "demo", false},
	} {
		review := &authorizationv1.SubjectAccessReview{Spec: authorizationv1.SubjectAccessReviewSpec{
			User:               "system:serviceaccount:expbuild-system:expbuild-operator",
			ResourceAttributes: &authorizationv1.ResourceAttributes{Verb: permission.verb, Group: permission.group, Resource: permission.resource, Namespace: permission.namespace},
		}}
		if err := cl.Create(ctx, review); err != nil {
			t.Fatal(err)
		}
		if review.Status.Allowed != permission.allowed {
			t.Fatalf("unexpected permission %+v: %+v", permission, review.Status)
		}
	}
}
