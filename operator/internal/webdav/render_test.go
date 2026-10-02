package webdav

import (
	"strings"
	"testing"

	"github.com/expbuild/expbuild/operator/internal/instance"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

func fixture() instance.Config {
	return instance.Config{Name: "dav-demo", Namespace: "demo", InstanceID: "dav", ProjectID: "project", Image: "example.invalid/httpd@sha256:" + strings.Repeat("a", 64), StorageClass: "standard", Capacity: "10Gi", CredentialsSecret: "dav-auth", DesiredState: "Running", Resources: corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("100m"), corev1.ResourceMemory: resource.MustParse("128Mi")}, Limits: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("1"), corev1.ResourceMemory: resource.MustParse("512Mi")}}}
}
func TestWebDAVResourceContract(t *testing.T) {
	c := fixture()
	objects, err := Render(c)
	if err != nil {
		t.Fatal(err)
	}
	pvc := objects[0].(*corev1.PersistentVolumeClaim)
	if len(pvc.OwnerReferences) != 0 {
		t.Fatal("volume must remain independently retainable")
	}
	cm := objects[1].(*corev1.ConfigMap)
	if cm.Immutable == nil || !*cm.Immutable {
		t.Fatal("configuration must be versioned")
	}
	service := objects[3].(*corev1.Service)
	if len(service.Spec.Ports) != 1 || service.Spec.Ports[0].Name != "http" {
		t.Fatal("WebDAV must not advertise gRPC")
	}
	workload := objects[4].(*appsv1.StatefulSet)
	if *workload.Spec.Template.Spec.SecurityContext.RunAsUser != 1000 || !*workload.Spec.Template.Spec.Containers[0].SecurityContext.ReadOnlyRootFilesystem {
		t.Fatal("expected restricted non-root workload")
	}
	c.DesiredState = "Suspended"
	objects, err = Render(c)
	if err != nil {
		t.Fatal(err)
	}
	if *objects[4].(*appsv1.StatefulSet).Spec.Replicas != 0 {
		t.Fatal("suspension must stop the workload")
	}
	c.MaxCacheGiB = 1
	if _, err := Render(c); err == nil {
		t.Fatal("unsupported capacity policy accepted")
	}
	c.MaxCacheGiB = 0
	c.Image = "httpd:latest"
	if _, err := Render(c); err == nil {
		t.Fatal("mutable image accepted")
	}
}

func TestWebDAVStatisticsVersionKeepsResourceBudgetAndReadOnlyAccess(t *testing.T) {
	c := fixture()
	c.StatsImage = "example.invalid/stats@sha256:" + strings.Repeat("a", 64)
	objects, err := RenderWithStats(c)
	if err != nil {
		t.Fatal(err)
	}
	svc := objects[3].(*corev1.Service)
	if len(svc.Spec.Ports) != 2 || svc.Spec.Ports[1].Name != "stats" || svc.Spec.Ports[1].Port != 9093 {
		t.Fatalf("statistics port missing: %+v", svc.Spec.Ports)
	}
	sts := objects[4].(*appsv1.StatefulSet)
	if len(sts.Spec.Template.Spec.Containers) != 2 {
		t.Fatal("statistics sidecar missing")
	}
	cache, stats := sts.Spec.Template.Spec.Containers[0], sts.Spec.Template.Spec.Containers[1]
	for _, name := range []corev1.ResourceName{corev1.ResourceCPU, corev1.ResourceMemory} {
		request := cache.Resources.Requests[name]
		request.Add(stats.Resources.Requests[name])
		original := c.Resources.Requests[name]
		if request.Cmp(original) != 0 {
			t.Fatalf("%s request exceeds project reservation", name)
		}
		limit := cache.Resources.Limits[name]
		limit.Add(stats.Resources.Limits[name])
		original = c.Resources.Limits[name]
		if limit.Cmp(original) != 0 {
			t.Fatalf("%s limit exceeds project reservation", name)
		}
	}
	if !stats.VolumeMounts[0].ReadOnly || !stats.VolumeMounts[1].ReadOnly || stats.SecurityContext.ReadOnlyRootFilesystem == nil || !*stats.SecurityContext.ReadOnlyRootFilesystem {
		t.Fatal("statistics sidecar must have only read-only mounts")
	}
	if len(sts.Spec.Template.Spec.Volumes[2].Secret.Items) != 3 {
		t.Fatal("probe credentials not mounted for statistics authentication")
	}
}
