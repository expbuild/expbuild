package controller

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
)

var newImage = "example.invalid/cache@sha256:" + strings.Repeat("b", 64)

func readWorkload(t *testing.T, r *Reconciler, c *cachev1.CacheInstance) appsv1.StatefulSet {
	t.Helper()
	var sts appsv1.StatefulSet
	if err := r.Get(context.Background(), client.ObjectKeyFromObject(c), &sts); err != nil {
		t.Fatal(err)
	}
	return sts
}
func readInstance(t *testing.T, r *Reconciler, c *cachev1.CacheInstance) {
	t.Helper()
	if err := r.Get(context.Background(), client.ObjectKeyFromObject(c), c); err != nil {
		t.Fatal(err)
	}
}
func assertReason(t *testing.T, c *cachev1.CacheInstance, want string) {
	t.Helper()
	condition := meta.FindStatusCondition(c.Status.Conditions, "Ready")
	if condition == nil || condition.Reason != want {
		t.Fatalf("Ready=%+v want %s", condition, want)
	}
}

// This deliberately bypasses admission in fake.Client to construct the state
// of a pre-upgrade CR, not to claim that a live immutable field may be removed.
func legacyFixture(t *testing.T) (*Reconciler, *cachev1.CacheInstance) {
	t.Helper()
	r, c := setup(t)
	reconcile(t, r, c)
	readInstance(t, r, c)
	c.Spec.ImageBindingMode = ""
	if err := r.Update(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	c.Status = cachev1.CacheInstanceStatus{}
	if err := r.Status().Update(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	return r, c
}

func TestBindingPersistsAcrossRestartMissingWorkloadAndDisabledDefaults(t *testing.T) {
	r, c := setup(t)
	reconcile(t, r, c)
	readInstance(t, r, c)
	bound := c.Status.ImageBinding.DeepCopy()
	before := readWorkload(t, r, c)
	if err := r.Delete(context.Background(), &before); err != nil {
		t.Fatal(err)
	}
	restarted := &Reconciler{Client: r.Client, Reader: r.Reader}
	reconcile(t, restarted, c)
	after := readWorkload(t, restarted, c)
	readInstance(t, restarted, c)
	if !reflect.DeepEqual(before.Spec.Template, after.Spec.Template) || !reflect.DeepEqual(bound, c.Status.ImageBinding) {
		t.Fatal("restart/recreation changed the binding or images")
	}
}

func TestBindingFirstAdoptionStrictlyRequiresCurrentApproval(t *testing.T) {
	for _, tc := range []struct {
		name, reason string
		change       func(*appsv1.StatefulSet)
	}{
		{name: "exact", change: func(*appsv1.StatefulSet) {}},
		{name: "different valid digest", reason: "LegacyImageApprovalRequired", change: func(s *appsv1.StatefulSet) { s.Spec.Template.Spec.Containers[0].Image = newImage }},
		{name: "extra sidecar", reason: "LegacyImageApprovalRequired", change: func(s *appsv1.StatefulSet) {
			s.Spec.Template.Spec.Containers = append(s.Spec.Template.Spec.Containers, corev1.Container{Name: "injected", Image: newImage})
		}},
		{name: "init container", reason: "LegacyImageApprovalRequired", change: func(s *appsv1.StatefulSet) {
			s.Spec.Template.Spec.InitContainers = []corev1.Container{{Name: "init", Image: newImage}}
		}},
		{name: "foreign controller", reason: "ImageBindingOwnershipRejected", change: func(s *appsv1.StatefulSet) { s.OwnerReferences[0].UID = "foreign" }},
		{name: "foreign project", reason: "ImageBindingOwnershipRejected", change: func(s *appsv1.StatefulSet) { s.Labels[ProjectLabel] = "foreign" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, c := legacyFixture(t)
			before := readWorkload(t, r, c)
			tc.change(&before)
			if err := r.Update(context.Background(), &before); err != nil {
				t.Fatal(err)
			}
			before = readWorkload(t, r, c)
			reconcile(t, r, c)
			after := readWorkload(t, r, c)
			readInstance(t, r, c)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("legacy adoption rewrote a workload")
			}
			if tc.reason != "" {
				assertReason(t, c, tc.reason)
				if c.Status.ImageBinding != nil {
					t.Fatal("unapproved legacy image was trusted")
				}
			} else if c.Status.ImageBinding == nil || string(c.Status.ImageBinding.Images["cache"]) != r.Image {
				t.Fatal("exact approved legacy instance was not bound")
			}
		})
	}
}

func TestLegacyMissingWorkloadNeverUsesGenerationAsNewIdentity(t *testing.T) {
	r, c := legacyFixture(t)
	sts := readWorkload(t, r, c)
	if err := r.Delete(context.Background(), &sts); err != nil {
		t.Fatal(err)
	}
	c.Generation = 1
	reconcile(t, r, c)
	readInstance(t, r, c)
	assertReason(t, c, "LegacyWorkloadMissing")
	if c.Status.ImageBinding != nil {
		t.Fatal("missing legacy workload acquired default images")
	}
	if err := r.Get(context.Background(), client.ObjectKeyFromObject(c), &sts); !apierrors.IsNotFound(err) {
		t.Fatal("legacy workload was recreated")
	}
}

func TestBoundImageAndBindingDriftRejectedWithoutRewrite(t *testing.T) {
	for _, which := range []string{"workload", "uid", "template", "format", "unknown image role", "missing image", "mutable image"} {
		t.Run(which, func(t *testing.T) {
			r, c := setup(t)
			reconcile(t, r, c)
			readInstance(t, r, c)
			before := readWorkload(t, r, c)
			switch which {
			case "workload":
				before.Spec.Template.Spec.Containers[0].Image = newImage
				if err := r.Update(context.Background(), &before); err != nil {
					t.Fatal(err)
				}
			case "uid":
				c.Status.ImageBinding.InstanceUID = "other"
			case "template":
				c.Status.ImageBinding.TemplateRef.Version = "9.0.0"
			case "format":
				c.Status.ImageBinding.Format = "v99"
			case "unknown image role":
				c.Status.ImageBinding.Images["injected"] = cachev1.ImageDigest(newImage)
			case "missing image":
				delete(c.Status.ImageBinding.Images, "cache")
			case "mutable image":
				c.Status.ImageBinding.Images["cache"] = "cache:latest"
			}
			if which != "workload" {
				if err := r.Status().Update(context.Background(), c); err != nil {
					t.Fatal(err)
				}
			}
			before = readWorkload(t, r, c)
			reconcile(t, r, c)
			after := readWorkload(t, r, c)
			readInstance(t, r, c)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("untrusted state rewrote workload")
			}
			want := "ImageBindingRejected"
			if which == "workload" {
				want = "WorkloadImageDrift"
			}
			assertReason(t, c, want)
		})
	}
}

func TestBindingConflictCreatesNoRuntimeResources(t *testing.T) {
	r, c := setup(t)
	ctx := context.Background()
	c.Finalizers = []string{Finalizer}
	if err := r.Update(ctx, c); err != nil {
		t.Fatal(err)
	}
	underlying := r.Client
	fail := true
	r.Client = interceptor.NewClient(underlying.(client.WithWatch), interceptor.Funcs{SubResourcePatch: func(ctx context.Context, cl client.Client, sub string, obj client.Object, patch client.Patch, opts ...client.SubResourcePatchOption) error {
		if sub == "status" && fail {
			fail = false
			return apierrors.NewConflict(schema.GroupResource{Group: cachev1.GroupVersion.Group, Resource: "cacheinstances"}, c.Name, errors.New("concurrent write"))
		}
		return cl.SubResource(sub).Patch(ctx, obj, patch, opts...)
	}})
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(c)}); !apierrors.IsConflict(err) {
		t.Fatalf("expected conflict: %v", err)
	}
	for _, list := range []client.ObjectList{&appsv1.StatefulSetList{}, &corev1.PersistentVolumeClaimList{}, &corev1.ConfigMapList{}, &corev1.ServiceList{}} {
		if err := r.List(ctx, list); err != nil {
			t.Fatal(err)
		}
		items, err := meta.ExtractList(list)
		if err != nil || len(items) != 0 {
			t.Fatalf("runtime resources before binding: %T", list)
		}
	}
	reconcile(t, r, c)
	readInstance(t, r, c)
	if c.Status.ImageBinding == nil {
		t.Fatal("retry did not persist binding")
	}
}

func TestCredentialAndResourceUpdatesKeepImageBinding(t *testing.T) {
	r, c := setup(t)
	reconcile(t, r, c)
	readInstance(t, r, c)
	before := readWorkload(t, r, c)
	binding := c.Status.ImageBinding.DeepCopy()
	ctx := context.Background()
	var secret corev1.Secret
	if err := r.Get(ctx, types.NamespacedName{Namespace: c.Namespace, Name: c.Spec.Access.CredentialsSecretRef}, &secret); err != nil {
		t.Fatal(err)
	}
	secret.Data["htpasswd"] = []byte("rotated-fixture")
	if err := r.Update(ctx, &secret); err != nil {
		t.Fatal(err)
	}
	c.Spec.Resources.Limits[corev1.ResourceMemory] = resource.MustParse("1Gi")
	c.Generation++
	if err := r.Update(ctx, c); err != nil {
		t.Fatal(err)
	}
	r.Image = newImage
	reconcile(t, r, c)
	after := readWorkload(t, r, c)
	readInstance(t, r, c)
	if !reflect.DeepEqual(binding, c.Status.ImageBinding) || after.Spec.Template.Spec.Containers[0].Image != before.Spec.Template.Spec.Containers[0].Image {
		t.Fatal("normal update changed trusted images")
	}
	if after.Spec.Template.Annotations["cache.expbuild.io/credential-revision"] == before.Spec.Template.Annotations["cache.expbuild.io/credential-revision"] {
		t.Fatal("credential rotation did not roll workload")
	}
	if after.Spec.Template.Spec.Containers[0].Resources.Limits.Memory().String() != "1Gi" {
		t.Fatal("resource change did not apply")
	}
}

func TestExplicitSuspendAndDeleteAreNotBlockedByLegacyMigration(t *testing.T) {
	for _, deletion := range []string{"Retain", "Delete"} {
		t.Run(deletion, func(t *testing.T) {
			r, c := legacyFixture(t)
			ctx := context.Background()
			sts := readWorkload(t, r, c)
			sts.Spec.Template.Spec.Containers[0].Image = newImage
			if err := r.Update(ctx, &sts); err != nil {
				t.Fatal(err)
			}
			before := sts.Spec.Template.DeepCopy()
			c.Spec.DesiredState = "Suspended"
			c.Spec.Storage.DeletionPolicy = deletion
			if err := r.Update(ctx, c); err != nil {
				t.Fatal(err)
			}
			var secret corev1.Secret
			if err := r.Get(ctx, types.NamespacedName{Namespace: c.Namespace, Name: "auth"}, &secret); err != nil {
				t.Fatal(err)
			}
			if err := r.Delete(ctx, &secret); err != nil {
				t.Fatal(err)
			}
			reconcile(t, r, c)
			sts = readWorkload(t, r, c)
			if sts.Spec.Replicas == nil || *sts.Spec.Replicas != 0 || !reflect.DeepEqual(*before, sts.Spec.Template) {
				t.Fatal("suspension rewrote images or did not stop workload")
			}
			readInstance(t, r, c)
			if err := r.Delete(ctx, c); err != nil {
				t.Fatal(err)
			}
			reconcile(t, r, c)
			if err := r.Get(ctx, client.ObjectKeyFromObject(c), c); !apierrors.IsNotFound(err) {
				t.Fatal("migration deadlocked deletion")
			}
			var pvc corev1.PersistentVolumeClaim
			err := r.Get(ctx, types.NamespacedName{Namespace: c.Namespace, Name: c.Name + "-data"}, &pvc)
			if deletion == "Retain" {
				if err != nil {
					t.Fatal(err)
				}
				if pvc.Annotations[retainedImagesUID] != "" {
					t.Fatal("unverified legacy images produced a trusted recovery record")
				}
			} else if !apierrors.IsNotFound(err) {
				t.Fatal("Delete retained volume")
			}
		})
	}
}

func TestConcurrentWorkloadImageEditIsRejectedAtApply(t *testing.T) {
	r, c := setup(t)
	reconcile(t, r, c)
	desired := readWorkload(t, r, c)
	current := desired.DeepCopy()
	current.Spec.Template.Spec.Containers[0].Image = newImage
	if err := r.Update(context.Background(), current); err != nil {
		t.Fatal(err)
	}
	desired.Spec.Replicas = ptr.To(int32(0))
	if err := r.apply(context.Background(), &desired); err == nil {
		t.Fatal("concurrent image mutation was overwritten")
	}
	after := readWorkload(t, r, c)
	if after.Spec.Template.Spec.Containers[0].Image != newImage || *after.Spec.Replicas != 1 {
		t.Fatal("failed image check mutated workload")
	}
}

func TestLivePodsMustMatchImagesAndWorkloadIdentity(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		for _, mutation := range []string{"none", "image", "sidecar", "init", "owner UID", "owner kind", "missing UID label", "missing workload"} {
			t.Run(fmt.Sprintf("legacy=%v/%s", legacy, mutation), func(t *testing.T) {
				r, c := setup(t)
				if legacy {
					r, c = legacyFixture(t)
				} else {
					reconcile(t, r, c)
					readInstance(t, r, c)
				}
				sts := readWorkload(t, r, c)
				pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: c.Name + "-0", Namespace: c.Namespace, Labels: sts.Spec.Template.DeepCopy().Labels, OwnerReferences: []metav1.OwnerReference{{APIVersion: appsv1.SchemeGroupVersion.String(), Kind: "StatefulSet", Name: sts.Name, UID: sts.UID, Controller: ptr.To(true)}}}, Spec: *sts.Spec.Template.Spec.DeepCopy()}
				switch mutation {
				case "image":
					pod.Spec.Containers[0].Image = newImage
				case "sidecar":
					pod.Spec.Containers = append(pod.Spec.Containers, corev1.Container{Name: "injected", Image: newImage})
				case "init":
					pod.Spec.InitContainers = []corev1.Container{{Name: "init", Image: newImage}}
				case "owner UID":
					pod.OwnerReferences[0].UID = "other"
				case "owner kind":
					pod.OwnerReferences[0].Kind = "Deployment"
				case "missing UID label":
					delete(pod.Labels, UIDLabel)
				case "missing workload":
					if err := r.Delete(context.Background(), &sts); err != nil {
						t.Fatal(err)
					}
				}
				if err := r.Create(context.Background(), pod); err != nil {
					t.Fatal(err)
				}
				before := pod.DeepCopy()
				reconcile(t, r, c)
				readInstance(t, r, c)
				if mutation == "none" {
					if c.Status.ImageBinding == nil {
						t.Fatal("approved live Pod did not bind")
					}
				} else {
					reason := "ImageBindingOwnershipRejected"
					if mutation == "image" || mutation == "sidecar" || mutation == "init" {
						reason = "WorkloadImageDrift"
						if legacy {
							reason = "LegacyImageApprovalRequired"
						}
					} else if legacy && mutation == "missing workload" {
						reason = "LegacyWorkloadMissing"
					}
					assertReason(t, c, reason)
					if legacy && c.Status.ImageBinding != nil {
						t.Fatal("unapproved Pod was adopted")
					}
				}
				var after corev1.Pod
				if err := r.Get(context.Background(), client.ObjectKeyFromObject(pod), &after); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(before, &after) {
					t.Fatal("image validation modified live Pod")
				}
				if mutation == "missing workload" {
					if err := r.Get(context.Background(), client.ObjectKeyFromObject(c), &appsv1.StatefulSet{}); !apierrors.IsNotFound(err) {
						t.Fatal("recreated workload while old Pod remains")
					}
				} else if after := readWorkload(t, r, c); !reflect.DeepEqual(sts.Spec.Template, after.Spec.Template) {
					t.Fatal("Pod validation rewrote workload template")
				}
			})
		}
	}
}

func TestPrunedBindingNeverCreatesRuntimeResources(t *testing.T) {
	r, c := setup(t)
	ctx := context.Background()
	underlying := r.Client
	r.Client = interceptor.NewClient(underlying.(client.WithWatch), interceptor.Funcs{SubResourcePatch: func(ctx context.Context, cl client.Client, sub string, obj client.Object, patch client.Patch, opts ...client.SubResourcePatchOption) error {
		if err := cl.SubResource(sub).Patch(ctx, obj, patch, opts...); err != nil {
			return err
		}
		if sub == "status" {
			// Simulate an old CRD pruning the new status field after a write.
			var pruned cachev1.CacheInstance
			if err := cl.Get(ctx, client.ObjectKeyFromObject(obj), &pruned); err != nil {
				return err
			}
			pruned.Status.ImageBinding = nil
			return cl.Status().Update(ctx, &pruned)
		}
		return nil
	}})
	reconcile(t, r, c)
	readInstance(t, r, c)
	assertReason(t, c, "ImageBindingPersistenceRequired")
	if c.Status.ImageBinding != nil {
		t.Fatal("pruned binding was treated as durable")
	}
	for _, list := range []client.ObjectList{&appsv1.StatefulSetList{}, &corev1.PersistentVolumeClaimList{}, &corev1.ConfigMapList{}, &corev1.ServiceList{}} {
		if err := r.List(ctx, list); err != nil {
			t.Fatal(err)
		}
		items, err := meta.ExtractList(list)
		if err != nil || len(items) != 0 {
			t.Fatalf("runtime resources created without durable binding: %T", list)
		}
	}
}
