package gradlecache

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/instance"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

func TestRenderGradleInstance(t *testing.T) {
	image := "registry.example/gradle@sha256:" + strings.Repeat("a", 64)
	resources := corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("200m"), corev1.ResourceMemory: resource.MustParse("256Mi")}
	c := instance.Config{Name: "cache", Namespace: "project", InstanceID: "instance", ProjectID: "project", Image: image, StorageClass: "standard", Capacity: "4Gi", MaxCacheGiB: 3, CredentialsSecret: "auth", DesiredState: "Running", Resources: corev1.ResourceRequirements{Requests: resources, Limits: resources}}
	objects, err := Render(c)
	if err != nil {
		t.Fatal(err)
	}
	if len(objects) != 4 {
		t.Fatalf("resources=%d", len(objects))
	}
	pvc := objects[0].(*corev1.PersistentVolumeClaim)
	volumeRequest := pvc.Spec.Resources.Requests[corev1.ResourceStorage]
	if volumeRequest.String() != "4Gi" {
		t.Fatal("wrong PVC capacity")
	}
	svc := objects[2].(*corev1.Service)
	if len(svc.Spec.Ports) != 1 || svc.Spec.Ports[0].Port != 8080 {
		t.Fatal("unexpected exposed protocol")
	}
	sts := objects[3].(*appsv1.StatefulSet)
	container := sts.Spec.Template.Spec.Containers[0]
	if container.Image != image || len(container.Args) != 2 || container.Args[0] != "--max-total-bytes=3221225472" || container.Args[1] != "--max-entry-bytes=1073741824" {
		t.Fatalf("engine arguments: %+v", container.Args)
	}
	if container.SecurityContext == nil || container.SecurityContext.ReadOnlyRootFilesystem == nil || !*container.SecurityContext.ReadOnlyRootFilesystem || sts.Spec.Template.Spec.AutomountServiceAccountToken == nil || *sts.Spec.Template.Spec.AutomountServiceAccountToken {
		t.Fatal("workload security boundary weakened")
	}
	c.DesiredState = "Suspended"
	objects, err = Render(c)
	if err != nil || *objects[3].(*appsv1.StatefulSet).Spec.Replicas != 0 {
		t.Fatalf("suspend: %v", err)
	}
	c.MaxCacheGiB = 4
	if _, err = Render(c); err == nil {
		t.Fatal("accepted cache budget equal to volume")
	}
}

func TestAuthenticatedBudgetProbe(t *testing.T) {
	engine := fixture(t, filepath.Join(t.TempDir(), "entries"), 8, 16)
	server := httptest.NewServer(engine)
	defer server.Close()
	c := &cachev1.CacheInstance{}
	c.Spec.Eviction.MaxCacheGiB = 1
	secret := &corev1.Secret{Data: map[string][]byte{"probe-username": []byte("builder"), "probe-password": []byte("secret")}}
	if err := CheckProtocol(context.Background(), c, secret, server.URL); err == nil || !strings.Contains(err.Error(), "budget") {
		t.Fatalf("accepted wrong budget: %v", err)
	}
	matching := fixture(t, filepath.Join(t.TempDir(), "matching"), 8, 1<<30)
	matchingServer := httptest.NewServer(matching)
	defer matchingServer.Close()
	if err := CheckProtocol(context.Background(), c, secret, matchingServer.URL); err != nil {
		t.Fatalf("valid probe: %v", err)
	}
	c.Spec.Eviction.MaxCacheGiB = 0
	if err := CheckProtocol(context.Background(), c, secret, server.URL); err == nil {
		t.Fatal("accepted zero budget")
	}
	secret.Data["probe-password"] = []byte("wrong")
	if err := CheckProtocol(context.Background(), c, secret, server.URL); err == nil {
		t.Fatal("accepted wrong credentials")
	}
}
