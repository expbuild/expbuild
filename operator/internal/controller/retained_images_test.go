package controller

import (
	"context"
	"reflect"
	"testing"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func seedRetainedImages(t *testing.T, r *Reconciler, c *cachev1.CacheInstance, pvc *corev1.PersistentVolumeClaim) {
	t.Helper()
	previous := c.DeepCopy()
	previous.UID = "old-uid"
	previous.Status.ImageBinding = &cachev1.ImageBinding{Format: "v1", InstanceUID: "old-uid", TemplateRef: c.Spec.TemplateRef, Images: imageDigests(map[string]string{"cache": r.Image})}
	if err := r.retainImages(context.Background(), previous, pvc, nil); err != nil {
		t.Fatal(err)
	}
}

func TestRetainRecoveryKeepsApprovedImagesAfterDefaultsChange(t *testing.T) {
	ctx := context.Background()
	r, c := setup(t)
	reconcile(t, r, c)
	readInstance(t, r, c)
	binding := c.Status.ImageBinding.DeepCopy()
	oldUID := c.UID
	var pvc corev1.PersistentVolumeClaim
	key := types.NamespacedName{Namespace: c.Namespace, Name: c.Name + "-data"}
	if err := r.Get(ctx, key, &pvc); err != nil {
		t.Fatal(err)
	}
	pvc.Status.Phase = corev1.ClaimBound
	pvc.Status.Capacity = corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("10Gi")}
	if err := r.Status().Update(ctx, &pvc); err != nil {
		t.Fatal(err)
	}
	if err := r.Delete(ctx, c); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, c)
	if err := r.Get(ctx, client.ObjectKeyFromObject(c), c); !apierrors.IsNotFound(err) {
		t.Fatal("Retain deletion did not finish")
	}
	if err := r.Get(ctx, key, &pvc); err != nil {
		t.Fatal(err)
	}
	if pvc.Annotations[retainedImagesUID] == "" {
		t.Fatal("no durable image record")
	}
	var record corev1.ConfigMap
	if err := r.Get(ctx, types.NamespacedName{Namespace: c.Namespace, Name: pvc.Annotations[retainedImagesName]}, &record); err != nil {
		t.Fatal(err)
	}
	if record.Immutable == nil || !*record.Immutable || len(record.OwnerReferences) > 0 {
		t.Fatal("recovery record will mutate or be garbage collected")
	}
	// fake.Client has no garbage collector; remove only the old CR's dependents.
	for _, obj := range []client.Object{&appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: c.Name, Namespace: c.Namespace}}, &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: c.Name, Namespace: c.Namespace}}, &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: c.Name + "-headless", Namespace: c.Namespace}}} {
		if err := r.Delete(ctx, obj); client.IgnoreNotFound(err) != nil {
			t.Fatal(err)
		}
	}
	var cms corev1.ConfigMapList
	if err := r.List(ctx, &cms, client.InNamespace(c.Namespace)); err != nil {
		t.Fatal(err)
	}
	for i := range cms.Items {
		if len(cms.Items[i].OwnerReferences) > 0 {
			if err := r.Delete(ctx, &cms.Items[i]); err != nil {
				t.Fatal(err)
			}
		}
	}
	c.UID = "new-uid"
	c.ResourceVersion = ""
	c.Generation = 1
	c.DeletionTimestamp = nil
	c.Finalizers = nil
	c.Status = cachev1.CacheInstanceStatus{}
	c.Annotations = map[string]string{"cache.expbuild.io/reclaim-bound-uid": "new-uid"}
	c.Spec.Storage.Reclaim = &cachev1.ReclaimSpec{PreviousInstanceUID: string(oldUID), VolumeUID: string(pvc.UID)}
	if err := r.Create(ctx, c); err != nil {
		t.Fatal(err)
	}
	r.Image = newImage
	reconcile(t, r, c)
	readInstance(t, r, c)
	sts := readWorkload(t, r, c)
	if sts.Spec.Template.Spec.Containers[0].Image != string(binding.Images["cache"]) || c.Status.ImageBinding.InstanceUID != "new-uid" || !reflect.DeepEqual(c.Status.ImageBinding.Images, binding.Images) {
		t.Fatal("retained data restarted under current defaults")
	}
	if err := r.Get(ctx, key, &pvc); err != nil {
		t.Fatal(err)
	}
	if pvc.Labels[UIDLabel] != "new-uid" {
		t.Fatal("verified volume did not transfer")
	}
}

func TestRetainRecoveryRejectsMissingReplacedAndAlteredRecords(t *testing.T) {
	for _, which := range []string{"missing receipt", "replaced record UID", "mutable record", "wrong volume", "unknown template", "wrong source UID"} {
		t.Run(which, func(t *testing.T) {
			r, c := setup(t)
			ctx := context.Background()
			pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: c.Name + "-data", Namespace: c.Namespace, UID: "volume-1", Labels: map[string]string{UIDLabel: "old-uid", InstanceLabel: c.Spec.InstanceID, ProjectLabel: c.Spec.ProjectID, "app.kubernetes.io/managed-by": "expbuild"}}}
			if err := r.Create(ctx, pvc); err != nil {
				t.Fatal(err)
			}
			seedRetainedImages(t, r, c, pvc)
			var record corev1.ConfigMap
			if err := r.Get(ctx, types.NamespacedName{Namespace: c.Namespace, Name: pvc.Annotations[retainedImagesName]}, &record); err != nil {
				t.Fatal(err)
			}
			switch which {
			case "missing receipt":
				delete(pvc.Annotations, retainedImagesUID)
				if err := r.Update(ctx, pvc); err != nil {
					t.Fatal(err)
				}
			case "replaced record UID":
				if err := r.Delete(ctx, &record); err != nil {
					t.Fatal(err)
				}
				record.UID = "replacement"
				record.ResourceVersion = ""
				if err := r.Create(ctx, &record); err != nil {
					t.Fatal(err)
				}
			case "mutable record":
				no := false
				record.Immutable = &no
				if err := r.Update(ctx, &record); err != nil {
					t.Fatal(err)
				}
			case "wrong volume":
				pvc.UID = "another-volume"
				if err := r.Update(ctx, pvc); err != nil {
					t.Fatal(err)
				}
			case "unknown template":
				c.Spec.TemplateRef.Version = "9.0.0"
			case "wrong source UID":
				record.Labels[UIDLabel] = "other"
				if err := r.Update(ctx, &record); err != nil {
					t.Fatal(err)
				}
			}
			c.Spec.Storage.Reclaim = &cachev1.ReclaimSpec{PreviousInstanceUID: "old-uid", VolumeUID: "volume-1"}
			if err := r.Update(ctx, c); err != nil {
				t.Fatal(err)
			}
			reconcile(t, r, c)
			readInstance(t, r, c)
			assertReason(t, c, "RetainedImagesRejected")
			var sts appsv1.StatefulSet
			if err := r.Get(ctx, client.ObjectKeyFromObject(c), &sts); !apierrors.IsNotFound(err) {
				t.Fatal("unverified restore created workload")
			}
			if c.Status.ImageBinding != nil {
				t.Fatal("unverified record became trusted")
			}
		})
	}
}
