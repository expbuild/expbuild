package controller

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/gateway"
	"github.com/expbuild/expbuild/operator/internal/instance"
	"github.com/expbuild/expbuild/operator/internal/monitoring"
	"github.com/expbuild/expbuild/operator/internal/templates"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

const Finalizer = "cache.expbuild.io/cleanup"
const UIDLabel = "cache.expbuild.io/instance-uid"
const InstanceLabel = "cache.expbuild.io/instance-id"
const ProjectLabel = "cache.expbuild.io/project-id"

var errReclaimBindingPending = errors.New("retained volume transfer awaits durable instance binding")

type Reconciler struct {
	client.Client
	// Reader must bypass informer caches for rollout observations.
	Reader   client.Reader
	Recorder record.EventRecorder
	// Image is an administrator-supplied digest, not an instance spec field.
	Image       string
	WebDAVImage string
	GradleImage string
	StatsImage  string
	Probe       Probe
	Gateway     *gateway.Config
	Monitoring  *monitoring.Config
}

func (r *Reconciler) SetupWithManager(m ctrl.Manager) error {
	if r.Recorder == nil {
		r.Recorder = m.GetEventRecorderFor("expbuild-images")
	}
	builder := ctrl.NewControllerManagedBy(m).For(&cachev1.CacheInstance{}).
		Owns(&appsv1.StatefulSet{}).Owns(&corev1.Service{}).Owns(&corev1.ConfigMap{})
	if r.Gateway != nil {
		builder = builder.Owns(&gatewayv1.HTTPRoute{}).Owns(&gatewayv1.GRPCRoute{})
	}
	if r.Gateway != nil || r.Monitoring != nil {
		builder = builder.Owns(&networkingv1.NetworkPolicy{})
	}
	// Monitor resources use the periodic reconciliation path so an unavailable
	// optional monitoring API cannot prevent the cache controller from starting.
	return builder.Complete(r)
}

func config(c *cachev1.CacheInstance, image string) instance.Config {
	return instance.Config{Name: c.Name, Namespace: c.Namespace, InstanceID: c.Spec.InstanceID, ProjectID: c.Spec.ProjectID,
		Image: image, StorageClass: c.Spec.Storage.ClassName, Capacity: c.Spec.Storage.Capacity,
		MaxCacheGiB: c.Spec.Eviction.MaxCacheGiB, CredentialsSecret: c.Spec.Access.CredentialsSecretRef,
		DesiredState: c.Spec.DesiredState, Resources: c.Spec.Resources}
}

func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var c cachev1.CacheInstance
	if err := r.Reader.Get(ctx, req.NamespacedName, &c); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	// The platform creates project namespaces. Cluster-wide watch permissions
	// must never let a CR provision resources into an unrelated namespace.
	var namespace corev1.Namespace
	if err := r.Reader.Get(ctx, types.NamespacedName{Name: c.Namespace}, &namespace); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if namespace.Labels["app.kubernetes.io/managed-by"] != "expbuild" || namespace.Labels[ProjectLabel] != c.Spec.ProjectID {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}
	if !c.DeletionTimestamp.IsZero() {
		return r.finalize(ctx, &c)
	}
	if !controllerutil.ContainsFinalizer(&c, Finalizer) {
		base := c.DeepCopy()
		controllerutil.AddFinalizer(&c, Finalizer)
		return ctrl.Result{Requeue: true}, r.Patch(ctx, &c, client.MergeFrom(base))
	}
	capabilities, capabilityErr := templates.Describe(c.Spec.TemplateRef)
	monitoringActive := r.Monitoring != nil && capabilityErr == nil && capabilities.MetricsPort > 0 && c.Spec.DesiredState == "Running"
	if previous := meta.FindStatusCondition(c.Status.Conditions, "MonitoringConfigured"); monitoringActive && (previous == nil || previous.ObservedGeneration != c.Generation) {
		monitoringCondition(&c, metav1.ConditionUnknown, "NotVerified", "Monitoring configuration has not been checked")
	}
	if monitoringActive && !controllerutil.ContainsFinalizer(&c, MonitoringFinalizer) {
		base := c.DeepCopy()
		controllerutil.AddFinalizer(&c, MonitoringFinalizer)
		return ctrl.Result{Requeue: true}, r.Patch(ctx, &c, client.MergeFrom(base))
	}
	if !monitoringActive {
		if !controllerutil.ContainsFinalizer(&c, MonitoringFinalizer) {
			monitoringCondition(&c, metav1.ConditionFalse, "Inactive", "Automatic monitoring is disabled, unsupported or the instance is suspended")
		} else {
			pending, cleanupErr := r.removeMonitoring(ctx, &c)
			if cleanupErr != nil || pending {
				monitoringCondition(&c, metav1.ConditionUnknown, "CleanupPending", "Monitoring cleanup has not completed")
			} else {
				base := c.DeepCopy()
				controllerutil.RemoveFinalizer(&c, MonitoringFinalizer)
				return ctrl.Result{Requeue: true}, r.Patch(ctx, &c, client.MergeFrom(base))
			}
		}
	}
	if (c.Spec.Access.Exposure != "ClusterInternal" && c.Spec.Access.Exposure != "Gateway") || (c.Spec.Storage.DeletionPolicy != "Retain" && c.Spec.Storage.DeletionPolicy != "Delete") {
		return r.report(ctx, &c, false, "InvalidConfiguration", "Unsupported template, exposure, policy or deletion mode")
	}
	if c.Spec.Access.Exposure == "Gateway" && c.Spec.DesiredState != "Suspended" && r.Gateway == nil {
		return r.report(ctx, &c, false, "InvalidConfiguration", "Gateway exposure is not configured")
	}
	// Track external access before creating any route. The marker is retained if
	// route cleanup fails, including after gateway support has been disabled.
	if c.Spec.Access.Exposure == "Gateway" && c.Spec.DesiredState == "Running" && !controllerutil.ContainsFinalizer(&c, GatewayFinalizer) {
		base := c.DeepCopy()
		controllerutil.AddFinalizer(&c, GatewayFinalizer)
		return ctrl.Result{Requeue: true}, r.Patch(ctx, &c, client.MergeFrom(base))
	}
	if controllerutil.ContainsFinalizer(&c, GatewayFinalizer) && (c.Spec.Access.Exposure != "Gateway" || c.Spec.DesiredState == "Suspended") {
		pending, err := r.removeGateway(ctx, &c)
		if err != nil {
			return ctrl.Result{}, err
		}
		if pending {
			return r.report(ctx, &c, false, "EndpointRemoving", "Waiting for external routes to be removed")
		}
		base := c.DeepCopy()
		controllerutil.RemoveFinalizer(&c, GatewayFinalizer)
		return ctrl.Result{Requeue: true}, r.Patch(ctx, &c, client.MergeFrom(base))
	}
	adapter, pendingBinding, err := r.resolveImageBinding(ctx, &c)
	if err != nil {
		var rejected *imageBindingRejected
		if !errors.As(err, &rejected) {
			return ctrl.Result{}, err
		}
		r.bindingCondition(&c, false, rejected.reason, rejected.message)
		if c.Spec.DesiredState == "Suspended" {
			return r.suspendBoundWorkload(ctx, &c, rejected.reason, rejected.message)
		}
		return r.report(ctx, &c, false, rejected.reason, rejected.message)
	}
	if pendingBinding {
		return ctrl.Result{Requeue: true}, nil
	}
	r.bindingCondition(&c, true, "Pinned", "Complete image set is durably bound to this instance and template")
	if c.Spec.DesiredState == "Suspended" {
		return r.suspendBoundWorkload(ctx, &c, "Suspended", "Workload stopped; persistent data and image binding retained")
	}
	objects, err := adapter.Render(config(&c, ""), c.Spec.Eviction.EnginePolicy)
	if err != nil {
		return r.report(ctx, &c, false, "InvalidConfiguration", err.Error())
	}
	var secret corev1.Secret
	if err = r.Reader.Get(ctx, types.NamespacedName{Namespace: c.Namespace, Name: c.Spec.Access.CredentialsSecretRef}, &secret); err != nil {
		if apierrors.IsNotFound(err) {
			return r.report(ctx, &c, false, "CredentialsMissing", "Credentials Secret does not exist")
		}
		return ctrl.Result{}, err
	}
	if secret.Labels[InstanceLabel] != c.Spec.InstanceID || secret.Labels[ProjectLabel] != c.Spec.ProjectID || len(secret.Data["htpasswd"]) == 0 {
		return r.report(ctx, &c, false, "CredentialsRejected", "Secret must belong to this instance/project and contain htpasswd")
	}
	if c.Spec.Storage.Reclaim != nil {
		if err := r.reclaimVolume(ctx, &c); err != nil {
			reason := "VolumeReclaimRejected"
			if errors.Is(err, errReclaimBindingPending) {
				reason = "VolumeReclaimPending"
			}
			return r.report(ctx, &c, false, reason, err.Error())
		}
	}
	if monitoringActive {
		r.applyMonitoring(ctx, &c)
	}
	for _, raw := range objects {
		desired := raw.(client.Object)
		labels := desired.GetLabels()
		labels[UIDLabel] = string(c.UID)
		desired.SetLabels(labels)
		if sts, ok := desired.(*appsv1.StatefulSet); ok {
			// Secret volume updates alone cannot prove the engine reloaded auth.
			sts.Spec.Template.Annotations["cache.expbuild.io/credential-revision"] = secret.ResourceVersion
			sts.Spec.Template.Labels[UIDLabel] = string(c.UID)
		}
		if _, isPVC := desired.(*corev1.PersistentVolumeClaim); !isPVC {
			if err = controllerutil.SetControllerReference(&c, desired, r.Scheme()); err != nil {
				return ctrl.Result{}, err
			}
		}
		if err = r.apply(ctx, desired); err != nil {
			if apierrors.IsConflict(err) {
				return ctrl.Result{}, err
			}
			return r.report(ctx, &c, false, "ApplyFailed", err.Error())
		}
	}
	if c.Spec.Access.Exposure == "Gateway" && c.Spec.DesiredState == "Running" {
		if err := r.applyGateway(ctx, &c); err != nil {
			return r.report(ctx, &c, false, "EndpointApplyFailed", err.Error())
		}
	}
	var sts appsv1.StatefulSet
	if err = r.Reader.Get(ctx, req.NamespacedName, &sts); err != nil {
		return ctrl.Result{}, err
	}
	var pvc corev1.PersistentVolumeClaim
	if err = r.Reader.Get(ctx, types.NamespacedName{Namespace: c.Namespace, Name: c.Name + "-data"}, &pvc); err != nil {
		return ctrl.Result{}, err
	}
	if pvc.Status.Phase != corev1.ClaimBound {
		return r.report(ctx, &c, false, "StoragePending", "Waiting for volume binding")
	}
	// Verify the current workload revision before probing the running engine.
	if sts.Status.ObservedGeneration < sts.Generation || sts.Status.ReadyReplicas != 1 || sts.Status.UpdatedReplicas != 1 || sts.Status.CurrentRevision == "" || sts.Status.CurrentRevision != sts.Status.UpdateRevision {
		return r.report(ctx, &c, false, "WorkloadPending", "Waiting for current StatefulSet revision")
	}
	if r.Probe == nil {
		return r.report(ctx, &c, false, "ProtocolVerificationPending", "No authenticated protocol probe configured")
	}
	if err := r.Probe.Check(ctx, &c, &secret); err != nil {
		return r.report(ctx, &c, false, "ProtocolVerificationFailed", err.Error())
	}
	if err := r.cleanupConfigs(ctx, &c, &sts); err != nil {
		return ctrl.Result{}, err
	}
	if c.Spec.Access.Exposure == "Gateway" {
		ready, err := r.gatewayReady(ctx, &c)
		if err != nil {
			return ctrl.Result{}, err
		}
		if !ready {
			return r.report(ctx, &c, false, "EndpointPending", "Waiting for current HTTPS Gateway and route acceptance")
		}
	}
	c.Status.AppliedConfigHash = sts.Spec.Template.Annotations["cache.expbuild.io/config-hash"]
	c.Status.CredentialRevision = secret.ResourceVersion
	c.Status.AppliedTemplateVersion = c.Spec.TemplateRef.Version
	c.Status.Endpoints = adapter.Endpoints(c.Name, c.Namespace)
	if c.Spec.Access.Exposure == "Gateway" {
		c.Status.Endpoints = r.Gateway.Endpoints(&c)
	}
	return r.report(ctx, &c, true, "Available", "Current workload revision and authenticated protocol probes succeeded")
}

func (r *Reconciler) reclaimVolume(ctx context.Context, c *cachev1.CacheInstance) error {
	claim := c.Spec.Storage.Reclaim
	if claim == nil {
		return nil
	}
	if claim.PreviousInstanceUID == "" || claim.VolumeUID == "" || claim.PreviousInstanceUID == string(c.UID) {
		return fmt.Errorf("invalid retained volume identity")
	}
	var pvc corev1.PersistentVolumeClaim
	key := types.NamespacedName{Namespace: c.Namespace, Name: c.Name + "-data"}
	if err := r.Reader.Get(ctx, key, &pvc); err != nil {
		return fmt.Errorf("retained volume not available: %w", err)
	}
	if string(pvc.UID) != claim.VolumeUID || pvc.DeletionTimestamp != nil || len(pvc.OwnerReferences) != 0 ||
		pvc.Labels[ProjectLabel] != c.Spec.ProjectID || pvc.Labels[InstanceLabel] != c.Spec.InstanceID ||
		pvc.Labels["app.kubernetes.io/managed-by"] != "expbuild" || pvc.Status.Phase != corev1.ClaimBound {
		return fmt.Errorf("retained volume identity or state changed")
	}
	if pvc.Spec.StorageClassName == nil || *pvc.Spec.StorageClassName != c.Spec.Storage.ClassName {
		return fmt.Errorf("retained volume storage class differs")
	}
	if len(pvc.Spec.AccessModes) != 1 || pvc.Spec.AccessModes[0] != corev1.ReadWriteOnce {
		return fmt.Errorf("retained volume access mode differs")
	}
	requested, err := resource.ParseQuantity(c.Spec.Storage.Capacity)
	volumeRequest, requestPresent := pvc.Spec.Resources.Requests[corev1.ResourceStorage]
	allocated, capacityPresent := pvc.Status.Capacity[corev1.ResourceStorage]
	if err != nil || !requestPresent || !capacityPresent || volumeRequest.Cmp(requested) > 0 || allocated.Cmp(requested) > 0 {
		return fmt.Errorf("retained volume capacity would shrink or is invalid")
	}
	if pvc.Labels[UIDLabel] != string(c.UID) && pvc.Labels[UIDLabel] != claim.PreviousInstanceUID {
		return fmt.Errorf("retained volume belongs to another instance UID")
	}
	// The management worker writes this marker only after durably binding the
	// new CR UID. A lost create response must leave the PVC with its old owner.
	if c.Annotations["cache.expbuild.io/reclaim-bound-uid"] != string(c.UID) {
		return errReclaimBindingPending
	}
	if pvc.Labels[UIDLabel] == string(c.UID) {
		return nil // An earlier reconciliation already transferred this exact PVC.
	}
	var pods corev1.PodList
	if err := r.Reader.List(ctx, &pods, client.InNamespace(c.Namespace)); err != nil {
		return err
	}
	for _, pod := range pods.Items {
		for _, volume := range pod.Spec.Volumes {
			if volume.PersistentVolumeClaim != nil && volume.PersistentVolumeClaim.ClaimName == pvc.Name {
				return fmt.Errorf("retained volume is still referenced by a Pod")
			}
		}
	}
	base := pvc.DeepCopy()
	pvc.Labels[UIDLabel] = string(c.UID)
	if pvc.Annotations == nil {
		pvc.Annotations = map[string]string{}
	}
	pvc.Annotations["cache.expbuild.io/reclaimed-from-uid"] = claim.PreviousInstanceUID
	return r.Patch(ctx, &pvc, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{}))
}

// apply refuses to adopt any existing resource without this CR's exact UID.
func (r *Reconciler) apply(ctx context.Context, desired client.Object) error {
	current := desired.DeepCopyObject().(client.Object)
	err := r.Reader.Get(ctx, client.ObjectKeyFromObject(desired), current)
	if apierrors.IsNotFound(err) {
		return r.Create(ctx, desired)
	}
	if err != nil {
		return err
	}
	if current.GetLabels()[UIDLabel] != desired.GetLabels()[UIDLabel] {
		return fmt.Errorf("resource %s is not owned by this instance UID", desired.GetName())
	}
	if _, isPVC := desired.(*corev1.PersistentVolumeClaim); !isPVC {
		owner, expected := metav1.GetControllerOf(current), metav1.GetControllerOf(desired)
		if owner == nil || expected == nil || owner.UID != expected.UID || owner.Name != expected.Name || owner.Kind != expected.Kind || owner.APIVersion != expected.APIVersion {
			return fmt.Errorf("resource %s has a conflicting controller owner", desired.GetName())
		}
	}
	base := current.DeepCopyObject().(client.Object)
	switch d := desired.(type) {
	case *corev1.PersistentVolumeClaim:
		p := current.(*corev1.PersistentVolumeClaim)
		if len(p.OwnerReferences) > 0 {
			return fmt.Errorf("retained PVC unexpectedly has an owner")
		}
		if !reflect.DeepEqual(p.Spec.StorageClassName, d.Spec.StorageClassName) {
			return fmt.Errorf("storage class cannot change")
		}
		old := p.Spec.Resources.Requests[corev1.ResourceStorage]
		next := d.Spec.Resources.Requests[corev1.ResourceStorage]
		if next.Cmp(old) < 0 {
			return fmt.Errorf("volume shrinking is not supported")
		}
		p.Spec.Resources.Requests[corev1.ResourceStorage] = next
	case *corev1.ConfigMap:
		p := current.(*corev1.ConfigMap)
		if !reflect.DeepEqual(p.Data, d.Data) {
			return fmt.Errorf("immutable configuration collision")
		}
		return nil
	case *corev1.Service:
		p := current.(*corev1.Service)
		p.Spec.Ports = d.Spec.Ports
		p.Spec.Selector = d.Spec.Selector
	case *unstructured.Unstructured:
		if d.GroupVersionKind() != monitoring.GVK {
			return fmt.Errorf("unsupported unstructured resource")
		}
		spec, _, err := unstructured.NestedMap(d.Object, "spec")
		if err != nil {
			return err
		}
		if err = unstructured.SetNestedMap(current.(*unstructured.Unstructured).Object, spec, "spec"); err != nil {
			return err
		}
	case *gatewayv1.HTTPRoute:
		current.(*gatewayv1.HTTPRoute).Spec = d.Spec
	case *gatewayv1.GRPCRoute:
		current.(*gatewayv1.GRPCRoute).Spec = d.Spec
	case *networkingv1.NetworkPolicy:
		current.(*networkingv1.NetworkPolicy).Spec = d.Spec
	case *appsv1.StatefulSet:
		p := current.(*appsv1.StatefulSet)
		// Repeat the image check at the optimistic write boundary: a concurrent
		// external edit after binding verification must not be overwritten.
		images, err := podImages(d.Spec.Template.Spec)
		if err != nil {
			return err
		}
		if err := matchesImages(p, images); err != nil {
			return err
		}
		p.Spec.Replicas = d.Spec.Replicas
		p.Spec.Template = d.Spec.Template
	default:
		return fmt.Errorf("unsupported managed resource %T", desired)
	}
	if reflect.DeepEqual(base, current) {
		return nil
	}
	return r.Patch(ctx, current, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{}))
}

func (r *Reconciler) report(ctx context.Context, c *cachev1.CacheInstance, ready bool, reason, message string) (ctrl.Result, error) {
	// Retrieve current status for an optimistic patch; the original object is
	// retained so concurrent spec changes cannot be reported as observed.
	var current cachev1.CacheInstance
	if err := r.Reader.Get(ctx, client.ObjectKeyFromObject(c), &current); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if current.Generation != c.Generation || current.UID != c.UID {
		return ctrl.Result{Requeue: true}, nil
	}
	base := current.DeepCopy()
	current.Status = c.Status
	// A concurrent successful binding cannot be cleared by a stale report.
	current.Status.ImageBinding = base.Status.ImageBinding
	current.Status.ObservedGeneration = c.Generation
	value := metav1.ConditionFalse
	if ready {
		value = metav1.ConditionTrue
	}
	meta.SetStatusCondition(&current.Status.Conditions, metav1.Condition{Type: "Ready", Status: value, Reason: reason, Message: message, ObservedGeneration: c.Generation})
	policy := metav1.Condition{Type: "PolicyApplied", Status: metav1.ConditionUnknown, Reason: "VerificationPending", Message: "Current running engine policy has not been verified", ObservedGeneration: c.Generation}
	enginePolicy, policyErr := templates.Policy(c.Spec.TemplateRef)
	if policyErr == nil && enginePolicy == "none" {
		policy.Reason = "NotSupported"
		policy.Message = "This template does not support automatic eviction"
	} else if policyErr == nil && ready && enginePolicy == "lru" {
		policy.Status = metav1.ConditionTrue
		policy.Reason = "EngineBudgetVerified"
		policy.Message = "Authenticated engine status confirms the requested native LRU cache budget"
	}
	meta.SetStatusCondition(&current.Status.Conditions, policy)
	if c.Spec.Access.Exposure == "Gateway" {
		meta.SetStatusCondition(&current.Status.Conditions, metav1.Condition{Type: "EndpointReady", Status: value, Reason: reason, Message: "HTTPS Gateway, route acceptance and backend readiness; external reachability is a separate check", ObservedGeneration: c.Generation})
		meta.SetStatusCondition(&current.Status.Conditions, metav1.Condition{Type: "ExternalReachability", Status: metav1.ConditionUnknown, Reason: "NotProbed", Message: "External DNS, certificate trust and client connectivity have not been probed", ObservedGeneration: c.Generation})
	} else {
		meta.RemoveStatusCondition(&current.Status.Conditions, "EndpointReady")
		meta.RemoveStatusCondition(&current.Status.Conditions, "ExternalReachability")
	}
	if !ready {
		current.Status.Endpoints = nil
		current.Status.AppliedConfigHash = ""
		current.Status.CredentialRevision = ""
		current.Status.AppliedTemplateVersion = ""
	}
	if reflect.DeepEqual(base.Status, current.Status) {
		return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
	}
	err := r.Status().Patch(ctx, &current, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{}))
	return ctrl.Result{RequeueAfter: 10 * time.Second}, err
}

func (r *Reconciler) pods(ctx context.Context, c *cachev1.CacheInstance) (corev1.PodList, error) {
	var pods corev1.PodList
	err := r.Reader.List(ctx, &pods, client.InNamespace(c.Namespace), client.MatchingLabels{UIDLabel: string(c.UID)})
	return pods, err
}

func (r *Reconciler) finalize(ctx context.Context, c *cachev1.CacheInstance) (ctrl.Result, error) {
	if !controllerutil.ContainsFinalizer(c, Finalizer) {
		return ctrl.Result{}, nil
	}
	if controllerutil.ContainsFinalizer(c, GatewayFinalizer) {
		pending, err := r.removeGateway(ctx, c)
		if err != nil {
			return ctrl.Result{}, err
		}
		if pending {
			return ctrl.Result{RequeueAfter: time.Second}, nil
		}
	}
	if controllerutil.ContainsFinalizer(c, MonitoringFinalizer) {
		pending, err := r.removeMonitoring(ctx, c)
		if err != nil {
			return ctrl.Result{}, err
		}
		if pending {
			return ctrl.Result{RequeueAfter: time.Second}, nil
		}
	}
	// Remove access before stopping the workload. Only delete exact owned UIDs.
	for _, name := range []string{c.Name, c.Name + "-headless"} {
		var svc corev1.Service
		if err := r.Reader.Get(ctx, types.NamespacedName{Namespace: c.Namespace, Name: name}, &svc); err == nil {
			if svc.Labels[UIDLabel] != string(c.UID) {
				return ctrl.Result{}, fmt.Errorf("service ownership conflict during deletion")
			}
			if err = r.Delete(ctx, &svc, client.Preconditions{UID: &svc.UID}); client.IgnoreNotFound(err) != nil {
				return ctrl.Result{}, err
			}
		} else if !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
	}
	var sts appsv1.StatefulSet
	var retainedWorkload *appsv1.StatefulSet
	if err := r.Reader.Get(ctx, client.ObjectKeyFromObject(c), &sts); err == nil {
		if err := ownedWorkload(c, &sts); err != nil {
			return ctrl.Result{}, err
		}
		retainedWorkload = &sts
		if sts.Spec.Replicas == nil || *sts.Spec.Replicas != 0 {
			base := sts.DeepCopy()
			zero := int32(0)
			sts.Spec.Replicas = &zero
			return ctrl.Result{RequeueAfter: time.Second}, r.Patch(ctx, &sts, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{}))
		}
	} else if !apierrors.IsNotFound(err) {
		return ctrl.Result{}, err
	}
	pods, err := r.pods(ctx, c)
	if err != nil {
		return ctrl.Result{}, err
	}
	if len(pods.Items) > 0 {
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}
	var pvc corev1.PersistentVolumeClaim
	err = r.Reader.Get(ctx, types.NamespacedName{Namespace: c.Namespace, Name: c.Name + "-data"}, &pvc)
	if err == nil {
		if pvc.Labels[UIDLabel] != string(c.UID) {
			return ctrl.Result{}, fmt.Errorf("volume ownership conflict during deletion")
		}
		if c.Spec.Storage.DeletionPolicy == "Delete" {
			if err = r.Delete(ctx, &pvc, client.Preconditions{UID: &pvc.UID}); client.IgnoreNotFound(err) != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: time.Second}, nil
		}
		if c.Spec.Storage.DeletionPolicy != "Retain" {
			return ctrl.Result{}, fmt.Errorf("unknown volume deletion policy")
		}
		if err := r.retainImages(ctx, c, &pvc, retainedWorkload); err != nil {
			return ctrl.Result{}, err
		}
	} else if !apierrors.IsNotFound(err) {
		return ctrl.Result{}, err
	}
	base := c.DeepCopy()
	controllerutil.RemoveFinalizer(c, Finalizer)
	controllerutil.RemoveFinalizer(c, MonitoringFinalizer)
	controllerutil.RemoveFinalizer(c, GatewayFinalizer)
	return ctrl.Result{}, r.Patch(ctx, c, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{}))
}
