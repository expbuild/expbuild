package controller

import (
	"context"
	"fmt"
	"strings"
	"testing"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/monitoring"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

type probeResult struct{ err error }

func TestNamespaceOwnershipRequiredBeforeProvisioning(t *testing.T) {
	for _, project := range []string{"", "another-project"} {
		t.Run("project="+project, func(t *testing.T) {
			r, c := setup(t)
			ctx := context.Background()
			var namespace corev1.Namespace
			if err := r.Get(ctx, types.NamespacedName{Name: c.Namespace}, &namespace); err != nil {
				t.Fatal(err)
			}
			namespace.Labels[ProjectLabel] = project
			if err := r.Update(ctx, &namespace); err != nil {
				t.Fatal(err)
			}
			reconcile(t, r, c)
			if err := r.Get(ctx, client.ObjectKeyFromObject(c), c); err != nil {
				t.Fatal(err)
			}
			if len(c.Finalizers) != 0 {
				t.Fatal("foreign namespace CR acquired a finalizer")
			}
			var workloads appsv1.StatefulSetList
			if err := r.List(ctx, &workloads); err != nil {
				t.Fatal(err)
			}
			if len(workloads.Items) != 0 {
				t.Fatal("provisioned into foreign namespace")
			}
		})
	}
}

func (p probeResult) Check(context.Context, *cachev1.CacheInstance, *corev1.Secret) error {
	return p.err
}

func TestReadyRequiresProtocolAndCurrentRevision(t *testing.T) {
	r, c := setup(t)
	ctx := context.Background()
	reconcile(t, r, c)
	var pvc corev1.PersistentVolumeClaim
	_ = r.Get(ctx, types.NamespacedName{Namespace: c.Namespace, Name: c.Name + "-data"}, &pvc)
	pvc.Status.Phase = corev1.ClaimBound
	if err := r.Status().Update(ctx, &pvc); err != nil {
		t.Fatal(err)
	}
	var sts appsv1.StatefulSet
	_ = r.Get(ctx, client.ObjectKeyFromObject(c), &sts)
	sts.Status.ObservedGeneration = sts.Generation
	sts.Status.ReadyReplicas = 1
	sts.Status.UpdatedReplicas = 1
	sts.Status.CurrentRevision = "v1"
	sts.Status.UpdateRevision = "v1"
	if err := r.Status().Update(ctx, &sts); err != nil {
		t.Fatal(err)
	}
	r.Probe = probeResult{err: fmt.Errorf("unauthorized")}
	reconcile(t, r, c)
	_ = r.Get(ctx, client.ObjectKeyFromObject(c), c)
	if meta.IsStatusConditionTrue(c.Status.Conditions, "Ready") {
		t.Fatal("ready despite failed authenticated probe")
	}
	r.Probe = probeResult{}
	reconcile(t, r, c)
	_ = r.Get(ctx, client.ObjectKeyFromObject(c), c)
	if !meta.IsStatusConditionTrue(c.Status.Conditions, "Ready") {
		t.Fatal("not ready after successful probe")
	}
	policy := meta.FindStatusCondition(c.Status.Conditions, "PolicyApplied")
	if policy == nil || policy.Status != metav1.ConditionTrue || policy.ObservedGeneration != c.Generation {
		t.Fatal("current engine policy not confirmed after authenticated verification")
	}
	if c.Status.AppliedConfigHash == "" || c.Status.CredentialRevision == "" {
		t.Fatal("missing applied revisions")
	}
	r.Probe = probeResult{err: fmt.Errorf("engine budget differs")}
	reconcile(t, r, c)
	_ = r.Get(ctx, client.ObjectKeyFromObject(c), c)
	policy = meta.FindStatusCondition(c.Status.Conditions, "PolicyApplied")
	if policy == nil || policy.Status != metav1.ConditionUnknown {
		t.Fatal("stale policy confirmation survived a failed probe")
	}
	r.Probe = probeResult{}
	r.Monitoring = &monitoring.Config{Namespace: "monitoring"}
	r.Reader = unavailableMonitoringReader{Reader: r.Reader}
	reconcile(t, r, c)
	_ = r.Get(ctx, client.ObjectKeyFromObject(c), c)
	if !meta.IsStatusConditionTrue(c.Status.Conditions, "Ready") {
		t.Fatal("monitoring outage blocked healthy cache")
	}
	if condition := meta.FindStatusCondition(c.Status.Conditions, "MonitoringConfigured"); condition == nil || condition.Status != metav1.ConditionFalse {
		t.Fatal("monitoring outage not reported separately")
	}
}

func setup(t *testing.T) (*Reconciler, *cachev1.CacheInstance) {
	t.Helper()
	s := runtime.NewScheme()
	_ = corev1.AddToScheme(s)
	_ = appsv1.AddToScheme(s)
	_ = cachev1.AddToScheme(s)
	c := &cachev1.CacheInstance{ObjectMeta: metav1.ObjectMeta{Name: "cache-demo", Namespace: "demo", UID: types.UID("uid-1"), Generation: 1}, Spec: cachev1.CacheInstanceSpec{
		InstanceID: "id-1", ProjectID: "project-1", TemplateRef: cachev1.TemplateRef{Name: "bazel-remote", Version: "0.1.0"}, DesiredState: "Running",
		Storage: cachev1.StorageSpec{ClassName: "standard", Capacity: "10Gi", DeletionPolicy: "Retain"}, Access: cachev1.AccessSpec{Exposure: "ClusterInternal", CredentialsSecretRef: "auth"}, Eviction: cachev1.EvictionSpec{EnginePolicy: "lru", MaxCacheGiB: 8},
		Resources: corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("100m"), corev1.ResourceMemory: resource.MustParse("128Mi")}, Limits: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("1"), corev1.ResourceMemory: resource.MustParse("512Mi")}},
	}}
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "auth", Namespace: "demo", Labels: map[string]string{InstanceLabel: "id-1", ProjectLabel: "project-1"}}, Data: map[string][]byte{"htpasswd": []byte("fixture-not-a-real-password")}}
	namespace := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: c.Namespace, Labels: map[string]string{"app.kubernetes.io/managed-by": "expbuild", ProjectLabel: c.Spec.ProjectID}}}
	cl := fake.NewClientBuilder().WithScheme(s).WithStatusSubresource(&cachev1.CacheInstance{}, &appsv1.StatefulSet{}, &corev1.PersistentVolumeClaim{}).WithObjects(c, secret, namespace).Build()
	return &Reconciler{Client: cl, Reader: cl, Image: "example.invalid/cache@sha256:" + strings.Repeat("a", 64)}, c
}

func reconcile(t *testing.T, r *Reconciler, c *cachev1.CacheInstance) {
	t.Helper()
	for i := 0; i < 2; i++ {
		if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(c)}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestReconcileIdempotentResources(t *testing.T) {
	r, c := setup(t)
	reconcile(t, r, c)
	reconcile(t, r, c)
	ctx := context.Background()
	var cms corev1.ConfigMapList
	if err := r.List(ctx, &cms); err != nil || len(cms.Items) != 1 {
		t.Fatalf("configs: %v %d", err, len(cms.Items))
	}
	var pvc corev1.PersistentVolumeClaim
	if err := r.Get(ctx, types.NamespacedName{Namespace: c.Namespace, Name: c.Name + "-data"}, &pvc); err != nil {
		t.Fatal(err)
	}
	if len(pvc.OwnerReferences) != 0 || pvc.Labels[UIDLabel] != string(c.UID) {
		t.Fatal("incorrect retained volume identity")
	}
	var sts appsv1.StatefulSet
	if err := r.Get(ctx, client.ObjectKeyFromObject(c), &sts); err != nil {
		t.Fatal(err)
	}
	if !metav1.IsControlledBy(&sts, c) {
		t.Fatal("missing workload owner")
	}
}

func TestForeignCredentialsRejected(t *testing.T) {
	r, c := setup(t)
	ctx := context.Background()
	var secret corev1.Secret
	_ = r.Get(ctx, types.NamespacedName{Namespace: "demo", Name: "auth"}, &secret)
	secret.Labels[InstanceLabel] = "other"
	if err := r.Update(ctx, &secret); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, c)
	_ = r.Get(ctx, client.ObjectKeyFromObject(c), c)
	cond := meta.FindStatusCondition(c.Status.Conditions, "Ready")
	if cond == nil || cond.Reason != "CredentialsRejected" {
		t.Fatalf("unexpected condition: %+v", cond)
	}
	var list appsv1.StatefulSetList
	_ = r.List(ctx, &list)
	if len(list.Items) != 0 {
		t.Fatal("workload created with foreign secret")
	}
}

func TestExistingForeignVolumeNotAdopted(t *testing.T) {
	r, c := setup(t)
	ctx := context.Background()
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: c.Name + "-data", Namespace: c.Namespace, Labels: map[string]string{UIDLabel: "old-uid"}}}
	if err := r.Create(ctx, pvc); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, c)
	_ = r.Get(ctx, client.ObjectKeyFromObject(c), c)
	if meta.FindStatusCondition(c.Status.Conditions, "Ready").Reason != "ApplyFailed" {
		t.Fatal("foreign resource accepted")
	}
	_ = r.Get(ctx, client.ObjectKeyFromObject(pvc), pvc)
	if pvc.Labels[UIDLabel] != "old-uid" {
		t.Fatal("foreign PVC changed")
	}
}

func TestRetainedVolumeReclaimRequiresExactIdentityAndNoPodReference(t *testing.T) {
	for _, tc := range []struct {
		name        string
		volumeUID   string
		previousUID string
		pod         bool
		accepted    bool
	}{
		{name: "exact retained claim", volumeUID: "volume-1", previousUID: "old-uid", accepted: true},
		{name: "replaced claim", volumeUID: "different-volume", previousUID: "old-uid"},
		{name: "another instance", volumeUID: "volume-1", previousUID: "other-uid"},
		{name: "claim in use", volumeUID: "volume-1", previousUID: "old-uid", pod: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, c := setup(t)
			ctx := context.Background()
			pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{
				Name: c.Name + "-data", Namespace: c.Namespace, UID: types.UID("volume-1"),
				Labels: map[string]string{UIDLabel: "old-uid", InstanceLabel: c.Spec.InstanceID, ProjectLabel: c.Spec.ProjectID, "app.kubernetes.io/managed-by": "expbuild"},
			}, Spec: corev1.PersistentVolumeClaimSpec{
				StorageClassName: ptr.To("standard"),
				AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
				Resources:        corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("10Gi")}},
			}}
			if err := r.Create(ctx, pvc); err != nil {
				t.Fatal(err)
			}
			pvc.Status.Phase = corev1.ClaimBound
			pvc.Status.Capacity = corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("10Gi")}
			if err := r.Status().Update(ctx, pvc); err != nil {
				t.Fatal(err)
			}
			if tc.pod {
				pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "external-reader", Namespace: c.Namespace}, Spec: corev1.PodSpec{Volumes: []corev1.Volume{{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: pvc.Name}}}}}}
				if err := r.Create(ctx, pod); err != nil {
					t.Fatal(err)
				}
			}
			if err := r.Get(ctx, client.ObjectKeyFromObject(c), c); err != nil {
				t.Fatal(err)
			}
			c.Spec.Storage.Reclaim = &cachev1.ReclaimSpec{PreviousInstanceUID: tc.previousUID, VolumeUID: tc.volumeUID}
			if tc.pod {
				if c.Annotations == nil {
					c.Annotations = map[string]string{}
				}
				c.Annotations["cache.expbuild.io/reclaim-bound-uid"] = string(c.UID)
			}
			if err := r.Update(ctx, c); err != nil {
				t.Fatal(err)
			}
			if tc.accepted {
				reconcile(t, r, c)
				if err := r.Get(ctx, client.ObjectKeyFromObject(pvc), pvc); err != nil {
					t.Fatal(err)
				}
				if pvc.Labels[UIDLabel] != "old-uid" {
					t.Fatal("PVC transferred before durable binding approval")
				}
				if err := r.Get(ctx, client.ObjectKeyFromObject(c), c); err != nil {
					t.Fatal(err)
				}
				if meta.FindStatusCondition(c.Status.Conditions, "Ready").Reason != "VolumeReclaimPending" {
					t.Fatal("missing durable binding was not reported as pending")
				}
				if c.Annotations == nil {
					c.Annotations = map[string]string{}
				}
				c.Annotations["cache.expbuild.io/reclaim-bound-uid"] = string(c.UID)
				if err := r.Update(ctx, c); err != nil {
					t.Fatal(err)
				}
			}
			reconcile(t, r, c)
			if err := r.Get(ctx, client.ObjectKeyFromObject(pvc), pvc); err != nil {
				t.Fatal(err)
			}
			if tc.accepted {
				if pvc.Labels[UIDLabel] != string(c.UID) || pvc.Annotations["cache.expbuild.io/reclaimed-from-uid"] != "old-uid" || string(pvc.UID) != "volume-1" {
					t.Fatalf("retained volume transfer incomplete: %#v", pvc.ObjectMeta)
				}
				reconcile(t, r, c)
			} else {
				if pvc.Labels[UIDLabel] != "old-uid" {
					t.Fatal("unverified retained volume changed")
				}
				if err := r.Get(ctx, client.ObjectKeyFromObject(c), c); err != nil {
					t.Fatal(err)
				}
				if meta.FindStatusCondition(c.Status.Conditions, "Ready").Reason != "VolumeReclaimRejected" {
					t.Fatal("unsafe volume reclaim was not reported")
				}
			}
		})
	}
}

func TestDeleteRetainsVolumeAndWaitsForPods(t *testing.T) {
	r, c := setup(t)
	ctx := context.Background()
	reconcile(t, r, c)
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: c.Name + "-0", Namespace: c.Namespace, Labels: map[string]string{UIDLabel: string(c.UID)}}}
	if err := r.Create(ctx, pod); err != nil {
		t.Fatal(err)
	}
	if err := r.Delete(ctx, c); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, c)
	var current cachev1.CacheInstance
	if err := r.Get(ctx, client.ObjectKeyFromObject(c), &current); err != nil {
		t.Fatal("finalizer removed while pod exists", err)
	}
	if err := r.Delete(ctx, pod); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, c)
	var pvc corev1.PersistentVolumeClaim
	if err := r.Get(ctx, types.NamespacedName{Namespace: c.Namespace, Name: c.Name + "-data"}, &pvc); err != nil {
		t.Fatal("retained volume removed", err)
	}
}

func TestPolicyNotConfirmedForUnsupportedOrStoppedEngines(t *testing.T) {
	for _, template := range []string{"bazel-remote", "webdav-apache"} {
		t.Run(template, func(t *testing.T) {
			r, c := setup(t)
			c.Spec.TemplateRef.Name = template
			c.Spec.DesiredState = "Suspended"
			if _, err := r.report(context.Background(), c, false, "Suspended", "Stopped"); err != nil {
				t.Fatal(err)
			}
			if err := r.Get(context.Background(), client.ObjectKeyFromObject(c), c); err != nil {
				t.Fatal(err)
			}
			policy := meta.FindStatusCondition(c.Status.Conditions, "PolicyApplied")
			if policy == nil || policy.Status != metav1.ConditionUnknown {
				t.Fatal("stopped/unsupported policy must not be confirmed")
			}
			if template == "webdav-apache" && policy.Reason != "NotSupported" {
				t.Fatal("unsupported eviction must be explicit")
			}
		})
	}
}
