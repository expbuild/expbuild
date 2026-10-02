package controller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"reflect"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/templates"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const retainedImagesName = "cache.expbuild.io/retained-images-name"
const retainedImagesUID = "cache.expbuild.io/retained-images-uid"
const retainedImagesPurpose = "retained-images-v1"

type retainedImages struct {
	Namespace  string               `json:"namespace"`
	ProjectID  string               `json:"projectId"`
	InstanceID string               `json:"instanceId"`
	VolumeUID  string               `json:"volumeUID"`
	Binding    cachev1.ImageBinding `json:"binding"`
}

// Ownerless immutable records deliberately survive CR garbage collection. The
// PVC pins the record UID; delete/recreate at the same name is not trusted.
func (r *Reconciler) retainImages(ctx context.Context, c *cachev1.CacheInstance, pvc *corev1.PersistentVolumeClaim, sts *appsv1.StatefulSet) error {
	adapter, err := trustedBinding(c, c.Status.ImageBinding)
	if err != nil || (sts != nil && matchesImages(sts, adapter.Images()) != nil) {
		// Migration must not deadlock an explicit Retain deletion. No trustworthy
		// receipt means future reclaim is blocked, rather than defaulting images.
		if r.Recorder != nil {
			r.Recorder.Event(c, corev1.EventTypeWarning, "RetainedImagesUnverified", "Volume retained without a trusted image recovery record; automatic reclaim will be rejected")
		}
		return nil
	}
	if pvc.UID == "" {
		return fmt.Errorf("retained volume has no durable UID")
	}
	receipt := retainedImages{Namespace: c.Namespace, ProjectID: c.Spec.ProjectID, InstanceID: c.Spec.InstanceID, VolumeUID: string(pvc.UID), Binding: *c.Status.ImageBinding.DeepCopy()}
	raw, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(string(c.UID) + "/" + string(pvc.UID)))
	name := "retained-images-" + hex.EncodeToString(digest[:16])
	desired := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: c.Namespace, Labels: map[string]string{UIDLabel: string(c.UID), InstanceLabel: c.Spec.InstanceID, ProjectLabel: c.Spec.ProjectID, "app.kubernetes.io/managed-by": "expbuild", "cache.expbuild.io/purpose": retainedImagesPurpose}}, Immutable: ptr.To(true), Data: map[string]string{"binding.json": string(raw)}}
	var record corev1.ConfigMap
	if err := r.Reader.Get(ctx, client.ObjectKeyFromObject(desired), &record); apierrors.IsNotFound(err) {
		if err := r.Create(ctx, desired); err != nil && !apierrors.IsAlreadyExists(err) {
			return err
		}
		if err := r.Reader.Get(ctx, client.ObjectKeyFromObject(desired), &record); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	if record.UID == "" || record.Immutable == nil || !*record.Immutable || len(record.OwnerReferences) > 0 || !record.DeletionTimestamp.IsZero() ||
		!reflect.DeepEqual(record.Data, desired.Data) || len(record.BinaryData) > 0 || !reflect.DeepEqual(record.Labels, desired.Labels) {
		if r.Recorder != nil {
			r.Recorder.Event(c, corev1.EventTypeWarning, "RetainedImagesRejected", "Recovery record has conflicting identity; retained volume requires administrator verification")
		}
		return nil // Preserve the volume and finish deletion; never overwrite trust.
	}
	if pvc.Annotations[retainedImagesName] == record.Name && pvc.Annotations[retainedImagesUID] == string(record.UID) {
		return nil
	}
	base := pvc.DeepCopy()
	if pvc.Annotations == nil {
		pvc.Annotations = map[string]string{}
	}
	pvc.Annotations[retainedImagesName] = record.Name
	pvc.Annotations[retainedImagesUID] = string(record.UID)
	return r.Patch(ctx, pvc, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{}))
}

func (r *Reconciler) retainedImageAdapter(ctx context.Context, c *cachev1.CacheInstance) (templates.Adapter, error) {
	fail := func(message string) (templates.Adapter, error) {
		return templates.Adapter{}, rejectBinding("RetainedImagesRejected", message)
	}
	claim := c.Spec.Storage.Reclaim
	var pvc corev1.PersistentVolumeClaim
	if err := r.Reader.Get(ctx, types.NamespacedName{Namespace: c.Namespace, Name: c.Name + "-data"}, &pvc); err != nil {
		if apierrors.IsNotFound(err) {
			return fail("retained volume is missing")
		}
		return templates.Adapter{}, err
	}
	if claim == nil || claim.PreviousInstanceUID == "" || claim.PreviousInstanceUID == string(c.UID) || claim.VolumeUID != string(pvc.UID) ||
		!pvc.DeletionTimestamp.IsZero() || len(pvc.OwnerReferences) > 0 || pvc.Labels[ProjectLabel] != c.Spec.ProjectID || pvc.Labels[InstanceLabel] != c.Spec.InstanceID ||
		pvc.Labels["app.kubernetes.io/managed-by"] != "expbuild" || (pvc.Labels[UIDLabel] != claim.PreviousInstanceUID && pvc.Labels[UIDLabel] != string(c.UID)) {
		return fail("retained volume identity differs")
	}
	name, uid := pvc.Annotations[retainedImagesName], pvc.Annotations[retainedImagesUID]
	if name == "" || uid == "" {
		return fail("retained volume lacks a trusted image record; current defaults cannot authorize recovery")
	}
	var record corev1.ConfigMap
	if err := r.Reader.Get(ctx, types.NamespacedName{Namespace: c.Namespace, Name: name}, &record); err != nil {
		if apierrors.IsNotFound(err) {
			return fail("retained image record is missing")
		}
		return templates.Adapter{}, err
	}
	if string(record.UID) != uid || record.Immutable == nil || !*record.Immutable || !record.DeletionTimestamp.IsZero() || len(record.OwnerReferences) > 0 ||
		record.Labels[UIDLabel] != claim.PreviousInstanceUID || record.Labels[ProjectLabel] != c.Spec.ProjectID || record.Labels[InstanceLabel] != c.Spec.InstanceID ||
		record.Labels["app.kubernetes.io/managed-by"] != "expbuild" || record.Labels["cache.expbuild.io/purpose"] != retainedImagesPurpose || len(record.Data) != 1 || len(record.BinaryData) > 0 {
		return fail("retained image record identity or immutability differs")
	}
	raw := record.Data["binding.json"]
	if len(raw) > 8192 {
		return fail("retained image record is oversized")
	}
	var receipt retainedImages
	decoder := json.NewDecoder(bytes.NewBufferString(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&receipt); err != nil {
		return fail("invalid retained image record")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return fail("invalid retained image record suffix")
	}
	if receipt.Namespace != c.Namespace || receipt.ProjectID != c.Spec.ProjectID || receipt.InstanceID != c.Spec.InstanceID || receipt.VolumeUID != claim.VolumeUID ||
		receipt.Binding.InstanceUID != claim.PreviousInstanceUID || receipt.Binding.TemplateRef != c.Spec.TemplateRef || receipt.Binding.Format != "v1" {
		return fail("retained image record does not match the requested template and volume identity")
	}
	adapter, err := templates.Bind(receipt.Binding.TemplateRef, imageStrings(receipt.Binding.Images))
	if err != nil {
		return fail(err.Error())
	}
	return adapter, nil
}
