package controller

import (
	"context"
	"fmt"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// Invoked only after rollout readiness or a confirmed suspension. ConfigMaps
// referenced by any Pod in the namespace (including terminating Pods) survive.
func (r *Reconciler) cleanupConfigs(ctx context.Context, instance *cachev1.CacheInstance, workload *appsv1.StatefulSet) error {
	keep := map[string]bool{}
	configReferences(workload.Spec.Template.Spec, keep)
	var configs corev1.ConfigMapList
	if err := r.Reader.List(ctx, &configs, client.InNamespace(instance.Namespace), client.MatchingLabels{UIDLabel: string(instance.UID)}); err != nil {
		return err
	}
	if len(configs.Items) == 0 || (len(configs.Items) == 1 && keep[configs.Items[0].Name]) {
		return nil
	}
	var pods corev1.PodList
	if err := r.Reader.List(ctx, &pods, client.InNamespace(instance.Namespace)); err != nil {
		return err
	}
	for _, pod := range pods.Items {
		configReferences(pod.Spec, keep)
	}
	for _, config := range configs.Items {
		owner := metav1.GetControllerOf(&config)
		if keep[config.Name] || config.Immutable == nil || !*config.Immutable || owner == nil || owner.UID != instance.UID || owner.Kind != "CacheInstance" || owner.Name != instance.Name || owner.APIVersion != cachev1.GroupVersion.String() {
			continue
		}
		// A concurrent configuration change invalidates this cleanup snapshot.
		var current cachev1.CacheInstance
		if err := r.Reader.Get(ctx, client.ObjectKeyFromObject(instance), &current); err != nil {
			return err
		}
		if current.UID != instance.UID || current.Generation != instance.Generation || !current.DeletionTimestamp.IsZero() {
			return fmt.Errorf("configuration changed during cleanup")
		}
		var latest appsv1.StatefulSet
		if err := r.Reader.Get(ctx, client.ObjectKeyFromObject(workload), &latest); err != nil {
			return err
		}
		if latest.UID != workload.UID || latest.ResourceVersion != workload.ResourceVersion {
			return fmt.Errorf("workload changed during cleanup")
		}
		if err := r.Delete(ctx, &config, client.Preconditions{UID: &config.UID, ResourceVersion: &config.ResourceVersion}); client.IgnoreNotFound(err) != nil {
			return err
		}
	}
	return nil
}

func configReferences(spec corev1.PodSpec, keep map[string]bool) {
	for _, volume := range spec.Volumes {
		if volume.ConfigMap != nil {
			keep[volume.ConfigMap.Name] = true
		}
		if volume.Projected != nil {
			for _, source := range volume.Projected.Sources {
				if source.ConfigMap != nil {
					keep[source.ConfigMap.Name] = true
				}
			}
		}
	}
	environment := func(env []corev1.EnvVar, from []corev1.EnvFromSource) {
		for _, variable := range env {
			if variable.ValueFrom != nil && variable.ValueFrom.ConfigMapKeyRef != nil {
				keep[variable.ValueFrom.ConfigMapKeyRef.Name] = true
			}
		}
		for _, source := range from {
			if source.ConfigMapRef != nil {
				keep[source.ConfigMapRef.Name] = true
			}
		}
	}
	for _, container := range spec.Containers {
		environment(container.Env, container.EnvFrom)
	}
	for _, container := range spec.InitContainers {
		environment(container.Env, container.EnvFrom)
	}
	for _, container := range spec.EphemeralContainers {
		environment(container.Env, container.EnvFrom)
	}
}
