package controller

import (
	"context"
	"testing"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func TestCleanupKeepsPodReferencesAndForeignResources(t *testing.T) {
	r, instance := setup(t)
	ctx := context.Background()
	reconcile(t, r, instance)
	var workload appsv1.StatefulSet
	if err := r.Get(ctx, client.ObjectKeyFromObject(instance), &workload); err != nil {
		t.Fatal(err)
	}
	immutable, control := true, true
	owner := metav1.OwnerReference{APIVersion: cachev1.GroupVersion.String(), Kind: "CacheInstance", Name: instance.Name, UID: instance.UID, Controller: &control}
	for _, name := range []string{"obsolete", "mounted", "environment", "projected", "foreign", "mutable"} {
		config := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: instance.Namespace, UID: types.UID(name), Labels: map[string]string{UIDLabel: string(instance.UID)}, OwnerReferences: []metav1.OwnerReference{owner}}, Immutable: &immutable}
		if name == "foreign" {
			config.OwnerReferences[0].UID = "other-instance"
		}
		if name == "mutable" {
			value := false
			config.Immutable = &value
		}
		if err := r.Create(ctx, config); err != nil {
			t.Fatal(err)
		}
	}
	// Include a Pod without instance labels: references still protect its config.
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "reader", Namespace: instance.Namespace}, Spec: corev1.PodSpec{
		Volumes: []corev1.Volume{
			{Name: "one", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: "mounted"}}}},
			{Name: "two", VolumeSource: corev1.VolumeSource{Projected: &corev1.ProjectedVolumeSource{Sources: []corev1.VolumeProjection{{ConfigMap: &corev1.ConfigMapProjection{LocalObjectReference: corev1.LocalObjectReference{Name: "projected"}}}}}}},
		},
		InitContainers: []corev1.Container{{Name: "init", EnvFrom: []corev1.EnvFromSource{{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "environment"}}}}}},
	}}
	if err := r.Create(ctx, pod); err != nil {
		t.Fatal(err)
	}
	if err := r.cleanupConfigs(ctx, instance, &workload); err != nil {
		t.Fatal(err)
	}
	var configs corev1.ConfigMapList
	if err := r.List(ctx, &configs); err != nil {
		t.Fatal(err)
	}
	if len(configs.Items) != 6 {
		t.Fatalf("expected current and five protected configurations, got %d", len(configs.Items))
	}
	var removed corev1.ConfigMap
	if err := r.Get(ctx, types.NamespacedName{Name: "obsolete", Namespace: instance.Namespace}, &removed); !apierrors.IsNotFound(err) {
		t.Fatalf("obsolete config remains: %v", err)
	}
}

func TestCleanupStopsWhenInstanceGenerationChanges(t *testing.T) {
	r, instance := setup(t)
	ctx := context.Background()
	reconcile(t, r, instance)
	var workload appsv1.StatefulSet
	if err := r.Get(ctx, client.ObjectKeyFromObject(instance), &workload); err != nil {
		t.Fatal(err)
	}
	var configs corev1.ConfigMapList
	if err := r.List(ctx, &configs); err != nil {
		t.Fatal(err)
	}
	old := configs.Items[0].DeepCopy()
	old.Name, old.ResourceVersion, old.UID = "obsolete", "", "obsolete-uid"
	if err := r.Create(ctx, old); err != nil {
		t.Fatal(err)
	}
	var current cachev1.CacheInstance
	if err := r.Get(ctx, client.ObjectKeyFromObject(instance), &current); err != nil {
		t.Fatal(err)
	}
	current.Generation++
	if err := r.Update(ctx, &current); err != nil {
		t.Fatal(err)
	}
	if err := r.cleanupConfigs(ctx, instance, &workload); err == nil {
		t.Fatal("cleanup accepted an outdated instance generation")
	}
	if err := r.Get(ctx, client.ObjectKeyFromObject(old), old); err != nil {
		t.Fatalf("outdated snapshot deleted config: %v", err)
	}
}
