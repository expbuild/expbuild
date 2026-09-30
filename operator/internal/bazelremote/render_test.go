package bazelremote

import (
	"reflect"
	"strings"
	"testing"

	"github.com/expbuild/expbuild/operator/internal/instance"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

func fixture() instance.Config {
	return instance.Config{
		Name: "cache-123", Namespace: "team-a", InstanceID: "123", ProjectID: "team-a",
		Image:        "example.invalid/bazel-remote@sha256:" + strings.Repeat("a", 64),
		StorageClass: "standard", Capacity: "10Gi", MaxCacheGiB: 8, CredentialsSecret: "cache-123-auth", DesiredState: "Running",
		Resources: corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("100m"), corev1.ResourceMemory: resource.MustParse("128Mi")}, Limits: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("1"), corev1.ResourceMemory: resource.MustParse("512Mi")}},
	}
}

func TestRejectUnsafeConfiguration(t *testing.T) {
	cases := map[string]func(*instance.Config){
		"floating image":    func(c *instance.Config) { c.Image = "example.invalid/cache:latest" },
		"no credentials":    func(c *instance.Config) { c.CredentialsSecret = "" },
		"full volume":       func(c *instance.Config) { c.MaxCacheGiB = 10 },
		"negative budget":   func(c *instance.Config) { c.MaxCacheGiB = -1 },
		"invalid capacity":  func(c *instance.Config) { c.Capacity = "wat" },
		"unknown state":     func(c *instance.Config) { c.DesiredState = "Deleted" },
		"bad name":          func(c *instance.Config) { c.Name = "../../other" },
		"resource mismatch": func(c *instance.Config) { c.Resources.Limits[corev1.ResourceMemory] = resource.MustParse("1Mi") },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			c := fixture()
			mutate(&c)
			if _, err := Render(c); err == nil {
				t.Fatal("unsafe input accepted")
			}
		})
	}
}

func TestRetainedStorageAndAuthentication(t *testing.T) {
	objects, err := Render(fixture())
	if err != nil {
		t.Fatal(err)
	}
	pvc := objects[0].(*corev1.PersistentVolumeClaim)
	if len(pvc.OwnerReferences) != 0 {
		t.Fatal("retained PVC has owner reference")
	}
	cm := objects[1].(*corev1.ConfigMap)
	if !strings.Contains(cm.Data["config.yaml"], "allow_unauthenticated_reads: false") {
		t.Fatal("anonymous reads allowed")
	}
	sts := objects[4].(*appsv1.StatefulSet)
	if *sts.Spec.Template.Spec.AutomountServiceAccountToken {
		t.Fatal("engine has API token")
	}
	if sts.Spec.Template.Spec.Volumes[2].Secret.SecretName != "cache-123-auth" {
		t.Fatal("wrong credential binding")
	}
	if sts.Spec.Template.Spec.Volumes[0].PersistentVolumeClaim.ClaimName != pvc.Name {
		t.Fatal("volume not bound")
	}
}

func TestSuspendKeepsStorage(t *testing.T) {
	c := fixture()
	running, _ := Render(c)
	c.DesiredState = "Suspended"
	suspended, err := Render(c)
	if err != nil {
		t.Fatal(err)
	}
	if *suspended[4].(*appsv1.StatefulSet).Spec.Replicas != 0 {
		t.Fatal("not suspended")
	}
	if !reflect.DeepEqual(running[0], suspended[0]) {
		t.Fatal("suspend changed storage")
	}
}

func TestDeterministicAndConfigRollout(t *testing.T) {
	c := fixture()
	a, _ := Render(c)
	b, _ := Render(c)
	if !reflect.DeepEqual(a, b) {
		t.Fatal("render is not deterministic")
	}
	c.MaxCacheGiB = 7
	updated, _ := Render(c)
	if a[1].(*corev1.ConfigMap).Name == updated[1].(*corev1.ConfigMap).Name {
		t.Fatal("config change did not get immutable revision")
	}
	if reflect.DeepEqual(a[4].(*appsv1.StatefulSet).Spec.Template, updated[4].(*appsv1.StatefulSet).Spec.Template) {
		t.Fatal("config change will not roll pods")
	}
	if !reflect.DeepEqual(a[0], updated[0]) {
		t.Fatal("cache budget changed storage identity")
	}
}
