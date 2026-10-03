package turbocache

import (
	"strings"
	"testing"

	"github.com/expbuild/expbuild/operator/internal/instance"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

func TestRenderTurborepoInstance(t *testing.T) {
	image := "registry.example/turborepo@sha256:" + strings.Repeat("a", 64)
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
	if container.Image != image || len(container.Args) != 3 || container.Args[0] != "--team=team_instance" || container.Args[1] != "--max-total-bytes=3221225472" || container.Args[2] != "--max-entry-bytes=268435456" {
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
	c.MaxCacheGiB = 1
	c.Capacity = "2Gi"
	objects, err = Render(c)
	if err != nil {
		t.Fatal(err)
	}
	if got := objects[3].(*appsv1.StatefulSet).Spec.Template.Spec.Containers[0].Args[2]; got != "--max-entry-bytes=268435456" {
		t.Fatalf("smallest budget cannot start: %s", got)
	}
	c.Capacity = "1073745920" // budget plus envelope only: no body staging room
	if _, err = Render(c); err == nil {
		t.Fatal("accepted PVC without upload headroom")
	}
	c.Capacity = "4Gi"
	c.MaxCacheGiB = 4
	if _, err = Render(c); err == nil {
		t.Fatal("accepted cache budget equal to volume")
	}
}
