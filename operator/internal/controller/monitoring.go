package controller

import (
	"context"
	"fmt"
	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/monitoring"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
)

const MonitoringFinalizer = "cache.expbuild.io/monitoring-cleanup"

func monitoringCondition(c *cachev1.CacheInstance, status metav1.ConditionStatus, reason, message string) {
	meta.SetStatusCondition(&c.Status.Conditions, metav1.Condition{Type: "MonitoringConfigured", Status: status, Reason: reason, Message: message, ObservedGeneration: c.Generation})
}
func (r *Reconciler) applyMonitoring(ctx context.Context, c *cachev1.CacheInstance) {
	objects, err := r.Monitoring.Render(c)
	if err == nil {
		for _, obj := range objects {
			if err = controllerutil.SetControllerReference(c, obj, r.Scheme()); err != nil {
				break
			}
			if err = r.apply(ctx, obj); err != nil {
				break
			}
		}
	}
	if err != nil {
		monitoringCondition(c, metav1.ConditionFalse, "ConfigurationFailed", "Cannot apply owned monitoring resources; cache availability is evaluated separately")
		return
	}
	monitoringCondition(c, metav1.ConditionTrue, "ResourcesApplied", "ServiceMonitor and network policy applied; actual sample collection is not verified")
}
func (r *Reconciler) removeMonitoring(ctx context.Context, c *cachev1.CacheInstance) (bool, error) {
	pending := false
	for _, obj := range []client.Object{monitoring.Monitor(c.Name+"-metrics", c.Namespace), &networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: c.Name + "-metrics", Namespace: c.Namespace}}} {
		if err := r.Reader.Get(ctx, client.ObjectKeyFromObject(obj), obj); err != nil {
			if apierrors.IsNotFound(err) {
				continue
			}
			return false, err
		}
		owner := metav1.GetControllerOf(obj)
		if obj.GetLabels()[UIDLabel] != string(c.UID) || owner == nil || owner.UID != c.UID {
			return false, fmt.Errorf("monitoring resource ownership conflict")
		}
		uid, rv := obj.GetUID(), obj.GetResourceVersion()
		if err := r.Delete(ctx, obj, client.Preconditions{UID: &uid, ResourceVersion: &rv}); client.IgnoreNotFound(err) != nil {
			return false, err
		}
		pending = true
	}
	return pending, nil
}
