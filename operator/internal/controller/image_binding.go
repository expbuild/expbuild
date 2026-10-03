package controller

import (
	"context"
	"fmt"
	"reflect"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/templates"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const ImageBindingMode = "PinnedV1"

type imageBindingRejected struct{ reason, message string }

func (e *imageBindingRejected) Error() string    { return e.message }
func rejectBinding(reason, message string) error { return &imageBindingRejected{reason, message} }

func trustedBinding(c *cachev1.CacheInstance, binding *cachev1.ImageBinding) (templates.Adapter, error) {
	if binding == nil || binding.Format != "v1" || binding.InstanceUID == "" || binding.InstanceUID != string(c.UID) || binding.TemplateRef != c.Spec.TemplateRef {
		return templates.Adapter{}, fmt.Errorf("binding format, instance UID or template identity differs")
	}
	return templates.Bind(binding.TemplateRef, imageStrings(binding.Images))
}

func ownedWorkload(c *cachev1.CacheInstance, sts *appsv1.StatefulSet) error {
	owner := metav1.GetControllerOf(sts)
	if c.UID == "" || sts.Namespace != c.Namespace || sts.Name != c.Name ||
		sts.Labels[UIDLabel] != string(c.UID) || sts.Labels[InstanceLabel] != c.Spec.InstanceID ||
		sts.Labels[ProjectLabel] != c.Spec.ProjectID || sts.Labels["app.kubernetes.io/managed-by"] != "expbuild" ||
		owner == nil || owner.UID != c.UID || owner.Name != c.Name || owner.Kind != "CacheInstance" || owner.APIVersion != cachev1.GroupVersion.String() {
		return fmt.Errorf("workload is not controlled by this exact instance UID and project")
	}
	return nil
}

func podImages(spec corev1.PodSpec) (map[string]string, error) {
	if len(spec.InitContainers) != 0 || len(spec.EphemeralContainers) != 0 {
		return nil, fmt.Errorf("unexpected init or ephemeral containers")
	}
	images := map[string]string{}
	for _, c := range spec.Containers {
		if c.Name == "" || images[c.Name] != "" {
			return nil, fmt.Errorf("duplicate or unnamed container")
		}
		images[c.Name] = c.Image
	}
	return images, nil
}

func matchesImages(sts *appsv1.StatefulSet, images map[string]string) error {
	actual, err := podImages(sts.Spec.Template.Spec)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(actual, images) {
		return fmt.Errorf("workload container images differ from the trusted complete image set")
	}
	return nil
}

// Inspect live Pod specs as well as the controller template. A matching template
// cannot approve an older/different running revision or an injected sidecar.
func (r *Reconciler) verifyWorkloadPods(ctx context.Context, c *cachev1.CacheInstance, sts *appsv1.StatefulSet, images map[string]string) error {
	var pods corev1.PodList
	if err := r.Reader.List(ctx, &pods, client.InNamespace(c.Namespace)); err != nil {
		return err
	}
	for _, pod := range pods.Items {
		owner := metav1.GetControllerOf(&pod)
		relevant := pod.Labels[UIDLabel] == string(c.UID) || (sts != nil && owner != nil && owner.UID == sts.UID)
		for _, volume := range pod.Spec.Volumes {
			if volume.PersistentVolumeClaim != nil && volume.PersistentVolumeClaim.ClaimName == c.Name+"-data" {
				relevant = true
			}
		}
		if !relevant {
			continue
		}
		if sts == nil || sts.UID == "" || owner == nil || owner.UID != sts.UID || owner.Name != sts.Name || owner.Kind != "StatefulSet" || owner.APIVersion != appsv1.SchemeGroupVersion.String() ||
			pod.Labels[UIDLabel] != string(c.UID) || pod.Labels[ProjectLabel] != c.Spec.ProjectID || pod.Labels[InstanceLabel] != c.Spec.InstanceID {
			return rejectBinding("ImageBindingOwnershipRejected", "a cache Pod or volume reader is not controlled by the exact workload UID")
		}
		actual, err := podImages(pod.Spec)
		if err != nil || !reflect.DeepEqual(actual, images) {
			reason := "WorkloadImageDrift"
			if c.Status.ImageBinding == nil {
				reason = "LegacyImageApprovalRequired"
			}
			return rejectBinding(reason, "running Pod container images differ from the complete approved image set")
		}
	}
	return nil
}

// Persist trust before any rendered workload/configuration mutation. Status is
// operator-only in shipped RBAC and its write-once invariant is enforced by CEL.
// A digest-shaped string in a legacy StatefulSet is never sufficient approval.
func (r *Reconciler) resolveImageBinding(ctx context.Context, c *cachev1.CacheInstance) (templates.Adapter, bool, error) {
	var sts appsv1.StatefulSet
	err := r.Reader.Get(ctx, client.ObjectKeyFromObject(c), &sts)
	exists := err == nil
	if err != nil && !apierrors.IsNotFound(err) {
		return templates.Adapter{}, false, err
	}
	if exists {
		if err := ownedWorkload(c, &sts); err != nil {
			return templates.Adapter{}, false, rejectBinding("ImageBindingOwnershipRejected", err.Error())
		}
	}
	var workload *appsv1.StatefulSet
	if exists {
		workload = &sts
	}
	if c.Status.ImageBinding != nil {
		adapter, err := trustedBinding(c, c.Status.ImageBinding)
		if err != nil {
			return templates.Adapter{}, false, rejectBinding("ImageBindingRejected", err.Error())
		}
		if exists {
			if err := matchesImages(&sts, adapter.Images()); err != nil {
				return templates.Adapter{}, false, rejectBinding("WorkloadImageDrift", err.Error())
			}
		}
		if err := r.verifyWorkloadPods(ctx, c, workload, adapter.Images()); err != nil {
			return templates.Adapter{}, false, err
		}
		return adapter, false, nil
	}
	if c.Spec.ImageBindingMode != "" && c.Spec.ImageBindingMode != ImageBindingMode {
		return templates.Adapter{}, false, rejectBinding("ImageBindingRejected", "unknown image binding creation mode")
	}
	var adapter templates.Adapter
	if c.Spec.Storage.Reclaim != nil {
		adapter, err = r.retainedImageAdapter(ctx, c)
		if err != nil {
			return templates.Adapter{}, false, err
		}
	} else {
		adapter, err = templates.Resolve(c.Spec.TemplateRef, r.Image, r.WebDAVImage, r.StatsImage, r.GradleImage, r.TurborepoImage)
		if err != nil {
			return templates.Adapter{}, false, rejectBinding("ImageApprovalRequired", err.Error())
		}
		if !exists {
			if c.Spec.ImageBindingMode != ImageBindingMode {
				return templates.Adapter{}, false, rejectBinding("LegacyWorkloadMissing", "legacy workload is missing; recovery requires a verified binding, not current defaults")
			}
			var pvc corev1.PersistentVolumeClaim
			err := r.Reader.Get(ctx, types.NamespacedName{Namespace: c.Namespace, Name: c.Name + "-data"}, &pvc)
			if err == nil {
				return templates.Adapter{}, false, rejectBinding("ImageRecoveryRequired", "unbound instance already has a volume; current defaults cannot authorize recovery")
			}
			if !apierrors.IsNotFound(err) {
				return templates.Adapter{}, false, err
			}
		}
	}
	if exists {
		if err := matchesImages(&sts, adapter.Images()); err != nil {
			return templates.Adapter{}, false, rejectBinding("LegacyImageApprovalRequired", "first adoption requires exact current approval: "+err.Error())
		}
	}
	if err := r.verifyWorkloadPods(ctx, c, workload, adapter.Images()); err != nil {
		return templates.Adapter{}, false, err
	}
	// Validate the exact template and all rendering constraints before binding.
	if _, err := adapter.Render(config(c, ""), c.Spec.Eviction.EnginePolicy); err != nil {
		return templates.Adapter{}, false, rejectBinding("InvalidConfiguration", err.Error())
	}
	base := c.DeepCopy()
	c.Status.ImageBinding = &cachev1.ImageBinding{Format: "v1", InstanceUID: string(c.UID), TemplateRef: c.Spec.TemplateRef, Images: imageDigests(adapter.Images())}
	expected := c.Status.ImageBinding.DeepCopy()
	if err := r.Status().Patch(ctx, c, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{})); err != nil {
		return templates.Adapter{}, false, err
	}
	var persisted cachev1.CacheInstance
	if err := r.Reader.Get(ctx, client.ObjectKeyFromObject(c), &persisted); err != nil {
		return templates.Adapter{}, false, err
	}
	if persisted.UID != c.UID || !reflect.DeepEqual(persisted.Status.ImageBinding, expected) {
		return templates.Adapter{}, false, rejectBinding("ImageBindingPersistenceRequired", "binding was not retained by the API; install the compatible CRD before provisioning")
	}
	return adapter, true, nil
}

func (r *Reconciler) bindingCondition(c *cachev1.CacheInstance, ok bool, reason, message string) {
	value := metav1.ConditionFalse
	if ok {
		value = metav1.ConditionTrue
	}
	previous := meta.FindStatusCondition(c.Status.Conditions, "ImagesBound")
	if !ok && r.Recorder != nil && (previous == nil || previous.Reason != reason || previous.Status != value) {
		r.Recorder.Event(c, corev1.EventTypeWarning, reason, message)
	}
	meta.SetStatusCondition(&c.Status.Conditions, metav1.Condition{Type: "ImagesBound", Status: value, Reason: reason, Message: message, ObservedGeneration: c.Generation})
}

// An explicit suspension never requires trusting new images, valid credentials,
// or a successful legacy migration. It only scales an exact owned workload.
func (r *Reconciler) suspendBoundWorkload(ctx context.Context, c *cachev1.CacheInstance, reason, message string) (ctrl.Result, error) {
	var sts appsv1.StatefulSet
	err := r.Reader.Get(ctx, client.ObjectKeyFromObject(c), &sts)
	if err == nil {
		if err := ownedWorkload(c, &sts); err != nil {
			return r.report(ctx, c, false, "SuspensionOwnershipRejected", err.Error())
		}
		if sts.Spec.Replicas == nil || *sts.Spec.Replicas != 0 {
			base := sts.DeepCopy()
			zero := int32(0)
			sts.Spec.Replicas = &zero
			if err := r.Patch(ctx, &sts, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{})); err != nil {
				return ctrl.Result{}, err
			}
		}
	} else if !apierrors.IsNotFound(err) {
		return ctrl.Result{}, err
	}
	pods, err := r.pods(ctx, c)
	if err != nil {
		return ctrl.Result{}, err
	}
	if len(pods.Items) > 0 {
		return r.report(ctx, c, false, "Suspending", "Waiting for cache Pods to stop; "+message)
	}
	return r.report(ctx, c, false, reason, message)
}

func imageStrings(images map[string]cachev1.ImageDigest) map[string]string {
	out := map[string]string{}
	for k, v := range images {
		out[k] = string(v)
	}
	return out
}
func imageDigests(images map[string]string) map[string]cachev1.ImageDigest {
	out := map[string]cachev1.ImageDigest{}
	for k, v := range images {
		out[k] = cachev1.ImageDigest(v)
	}
	return out
}
