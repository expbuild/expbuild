package controller

import (
	"context"
	"fmt"
	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"reflect"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

const GatewayFinalizer = "cache.expbuild.io/gateway-cleanup"

func (r *Reconciler) applyGateway(ctx context.Context, c *cachev1.CacheInstance) error {
	objects, err := r.Gateway.Render(c)
	if err != nil {
		return err
	}
	for _, obj := range objects {
		if err := controllerutil.SetControllerReference(c, obj, r.Scheme()); err != nil {
			return err
		}
		if err := r.apply(ctx, obj); err != nil {
			return err
		}
	}
	return nil
}
func (r *Reconciler) gatewayReady(ctx context.Context, c *cachev1.CacheInstance) (bool, error) {
	var g gatewayv1.Gateway
	if err := r.Reader.Get(ctx, types.NamespacedName{Namespace: r.Gateway.Namespace, Name: r.Gateway.Name}, &g); err != nil {
		if apierrors.IsNotFound(err) {
			return false, nil
		}
		return false, err
	}
	if !r.Gateway.Ready(&g) {
		return false, nil
	}
	objects, err := r.Gateway.Render(c)
	if err != nil {
		return false, err
	}
	for _, object := range objects {
		if _, ok := object.(*networkingv1.NetworkPolicy); ok {
			continue
		}
		desired := object.DeepCopyObject()
		if err := r.Reader.Get(ctx, client.ObjectKeyFromObject(object), object); err != nil {
			if apierrors.IsNotFound(err) {
				return false, nil
			}
			return false, err
		}
		owner := metav1.GetControllerOf(object)
		if object.GetDeletionTimestamp() != nil || object.GetLabels()[UIDLabel] != string(c.UID) || owner == nil || owner.UID != c.UID {
			return false, nil
		}
		switch route := object.(type) {
		case *gatewayv1.HTTPRoute:
			if !reflect.DeepEqual(route.Spec, desired.(*gatewayv1.HTTPRoute).Spec) || !r.Gateway.Accepted(route.Status.Parents, route.Generation) {
				return false, nil
			}
		case *gatewayv1.GRPCRoute:
			if !reflect.DeepEqual(route.Spec, desired.(*gatewayv1.GRPCRoute).Spec) || !r.Gateway.Accepted(route.Status.Parents, route.Generation) {
				return false, nil
			}
		}
	}
	return true, nil
}
func (r *Reconciler) removeGateway(ctx context.Context, c *cachev1.CacheInstance) (bool, error) {
	pending := false
	objects := []client.Object{&gatewayv1.HTTPRoute{ObjectMeta: metav1.ObjectMeta{Name: c.Name + "-http", Namespace: c.Namespace}}, &gatewayv1.GRPCRoute{ObjectMeta: metav1.ObjectMeta{Name: c.Name + "-grpc", Namespace: c.Namespace}}, &networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: c.Name + "-gateway", Namespace: c.Namespace}}}
	for _, object := range objects {
		if err := r.Reader.Get(ctx, client.ObjectKeyFromObject(object), object); err != nil {
			if apierrors.IsNotFound(err) {
				continue
			}
			return false, err
		}
		owner := metav1.GetControllerOf(object)
		if object.GetLabels()[UIDLabel] != string(c.UID) || owner == nil || owner.UID != c.UID {
			return false, fmt.Errorf("gateway resource ownership conflict")
		}
		uid, rv := object.GetUID(), object.GetResourceVersion()
		if err := r.Delete(ctx, object, client.Preconditions{UID: &uid, ResourceVersion: &rv}); client.IgnoreNotFound(err) != nil {
			return false, err
		}
		pending = true
	}
	return pending, nil
}
