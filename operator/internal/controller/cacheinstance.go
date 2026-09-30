package controller

import (
	"context"
	"fmt"
	"reflect"
	"time"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/bazelremote"
	"github.com/expbuild/expbuild/operator/internal/gateway"
	"github.com/expbuild/expbuild/operator/internal/instance"
	"github.com/expbuild/expbuild/operator/internal/monitoring"
	"github.com/expbuild/expbuild/operator/internal/webdav"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

const Finalizer = "cache.expbuild.io/cleanup"
const UIDLabel = "cache.expbuild.io/instance-uid"
const InstanceLabel = "cache.expbuild.io/instance-id"
const ProjectLabel = "cache.expbuild.io/project-id"

type Reconciler struct {
	client.Client
	// Reader must bypass informer caches for rollout observations.
	Reader client.Reader
	// Image is an administrator-supplied digest, not an instance spec field.
	Image       string
	WebDAVImage string
	Probe       Probe
	Gateway     *gateway.Config
	Monitoring  *monitoring.Config
}

func (r *Reconciler) SetupWithManager(m ctrl.Manager) error {
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
	if err := r.Get(ctx, req.NamespacedName, &c); err != nil {
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
	monitoringActive := r.Monitoring != nil && c.Spec.TemplateRef.Name == "bazel-remote" && c.Spec.DesiredState == "Running"
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
	if c.Spec.TemplateRef.Version != "0.1.0" || (c.Spec.Access.Exposure != "ClusterInternal" && c.Spec.Access.Exposure != "Gateway") || (c.Spec.Storage.DeletionPolicy != "Retain" && c.Spec.Storage.DeletionPolicy != "Delete") {
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
	render := bazelremote.Render
	image := r.Image
	switch c.Spec.TemplateRef.Name {
	case "bazel-remote":
		if c.Spec.Eviction.EnginePolicy != "lru" {
			return r.report(ctx, &c, false, "InvalidConfiguration", "Bazel Remote requires lru eviction")
		}
	case "webdav-apache":
		if c.Spec.Eviction.EnginePolicy != "none" || c.Spec.Eviction.MaxCacheGiB != 0 || r.WebDAVImage == "" {
			return r.report(ctx, &c, false, "InvalidConfiguration", "WebDAV requires an approved image and no engine eviction policy")
		}
		render, image = webdav.Render, r.WebDAVImage
	default:
		return r.report(ctx, &c, false, "InvalidConfiguration", "Unsupported template")
	}
	objects, err := render(config(&c, image))
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
	if c.Spec.DesiredState == "Suspended" {
		pods, err := r.pods(ctx, &c)
		if err != nil {
			return ctrl.Result{}, err
		}
		if len(pods.Items) > 0 {
			return r.report(ctx, &c, false, "Suspending", "Waiting for cache Pods to stop")
		}
		if err := r.cleanupConfigs(ctx, &c, &sts); err != nil {
			return ctrl.Result{}, err
		}
		return r.report(ctx, &c, false, "Suspended", "Workload stopped; persistent data retained")
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
	c.Status.Endpoints = []cachev1.Endpoint{{Protocol: "reapi", URL: fmt.Sprintf("grpc://%s.%s.svc:9092", c.Name, c.Namespace)}, {Protocol: "bazel-http", URL: fmt.Sprintf("http://%s.%s.svc:8080", c.Name, c.Namespace)}}
	if c.Spec.TemplateRef.Name == "webdav-apache" {
		c.Status.Endpoints = []cachev1.Endpoint{{Protocol: "webdav", URL: fmt.Sprintf("http://%s.%s.svc:8080/", c.Name, c.Namespace)}}
	}
	if c.Spec.Access.Exposure == "Gateway" {
		c.Status.Endpoints = r.Gateway.Endpoints(&c)
	}
	return r.report(ctx, &c, true, "Available", "Current workload revision and authenticated protocol probes succeeded")
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
		if owner == nil || expected == nil || owner.UID != expected.UID {
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
	current.Status.ObservedGeneration = c.Generation
	value := metav1.ConditionFalse
	if ready {
		value = metav1.ConditionTrue
	}
	meta.SetStatusCondition(&current.Status.Conditions, metav1.Condition{Type: "Ready", Status: value, Reason: reason, Message: message, ObservedGeneration: c.Generation})
	policy := metav1.Condition{Type: "PolicyApplied", Status: metav1.ConditionUnknown, Reason: "VerificationPending", Message: "Current running engine policy has not been verified", ObservedGeneration: c.Generation}
	if c.Spec.TemplateRef.Name == "webdav-apache" {
		policy.Reason = "NotSupported"
		policy.Message = "This template does not support automatic eviction"
	} else if ready && c.Spec.TemplateRef.Name == "bazel-remote" {
		policy.Status = metav1.ConditionTrue
		policy.Reason = "EngineBudgetVerified"
		policy.Message = "Current workload uses native LRU and the authenticated engine status confirms the requested cache budget"
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
	if err := r.Reader.Get(ctx, client.ObjectKeyFromObject(c), &sts); err == nil {
		if sts.Labels[UIDLabel] != string(c.UID) {
			return ctrl.Result{}, fmt.Errorf("workload ownership conflict during deletion")
		}
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
	} else if !apierrors.IsNotFound(err) {
		return ctrl.Result{}, err
	}
	base := c.DeepCopy()
	controllerutil.RemoveFinalizer(c, Finalizer)
	controllerutil.RemoveFinalizer(c, MonitoringFinalizer)
	controllerutil.RemoveFinalizer(c, GatewayFinalizer)
	return ctrl.Result{}, r.Patch(ctx, c, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{}))
}
