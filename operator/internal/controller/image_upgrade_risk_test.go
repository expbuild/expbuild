package controller

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/templates"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// Operator rollout and workload statistics approval are independent values.
func TestHelmStatisticsImageHasIndependentDigestApproval(t *testing.T) {
	helm := os.Getenv("HELM_BIN")
	if helm == "" {
		t.Skip("set HELM_BIN for chart approval checks")
	}
	chart := filepath.Join("..", "..", "..", "deploy", "charts", "expbuild")
	stats := "example.invalid/statistics@sha256:" + strings.Repeat("a", 64)
	for _, operator := range []string{"example.invalid/operator:one", "example.invalid/operator:two"} {
		args := []string{"template", "binding-test", chart, "--kube-version", "1.32.0", "-f", filepath.Join(chart, "ci-values.yaml"), "--set-string", "images.operator=" + operator, "--set-string", "images.webdav=" + stats, "--set-string", "images.webdavStats=" + stats}
		rendered, err := exec.Command(helm, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("helm: %v\n%s", err, rendered)
		}
		if !bytes.Contains(rendered, []byte("--webdav-stats-image="+stats)) || bytes.Contains(rendered, []byte("--webdav-stats-image="+operator)) {
			t.Fatal("statistics approval coupled to operator image")
		}
		for _, bad := range []string{"", "example.invalid/stats:latest"} {
			invalid := append(append([]string{}, args...), "--set-string", "images.webdavStats="+bad)
			if _, err := exec.Command(helm, invalid...).CombinedOutput(); err == nil {
				t.Fatal("missing/mutable statistics image accepted")
			}
		}
	}
}

// Positive regression: defaults affect new instances, never existing bindings.
func TestInstallationImageChangeKeepsExistingWorkload(t *testing.T) {
	for _, tc := range []struct {
		name, version, container string
		statsOnly                bool
	}{
		{name: "bazel-remote", version: "0.1.0", container: "cache"},
		{name: "gradle-http", version: "0.1.0", container: "cache"},
		{name: "turborepo-http", version: "0.1.0", container: "cache"},
		{name: "gradle-http", version: "0.2.0", container: "cache"},
		{name: "webdav-apache", version: "0.1.0", container: "cache"},
		{name: "webdav-apache", version: "0.2.0", container: "cache"},
		{name: "webdav-apache", version: "0.2.0", container: "statistics", statsOnly: true},
	} {
		t.Run(tc.name+"@"+tc.version+"/"+tc.container, func(t *testing.T) {
			ctx := context.Background()
			r, c := setup(t)
			c.Spec.TemplateRef = cachev1.TemplateRef{Name: tc.name, Version: tc.version}
			if tc.name == "webdav-apache" {
				c.Spec.Eviction = cachev1.EvictionSpec{EnginePolicy: "none"}
			}
			if err := r.Update(ctx, c); err != nil {
				t.Fatal(err)
			}
			oldImage := "example.invalid/cache@sha256:" + strings.Repeat("a", 64)
			newImage := "example.invalid/cache@sha256:" + strings.Repeat("b", 64)
			r.Image, r.WebDAVImage, r.GradleImage, r.StatsImage, r.TurborepoImage = oldImage, oldImage, oldImage, oldImage, oldImage
			reconcile(t, r, c)
			var before appsv1.StatefulSet
			key := client.ObjectKeyFromObject(c)
			if err := r.Get(ctx, key, &before); err != nil {
				t.Fatal(err)
			}
			imageOf := func(sts *appsv1.StatefulSet, name string) string {
				t.Helper()
				for _, container := range sts.Spec.Template.Spec.Containers {
					if container.Name == name {
						return container.Image
					}
				}
				t.Fatalf("container %s missing", name)
				return ""
			}
			if imageOf(&before, tc.container) != oldImage {
				t.Fatal("fixture did not create the initial image")
			}
			var initial cachev1.CacheInstance
			if err := r.Get(ctx, key, &initial); err != nil {
				t.Fatal(err)
			}
			capabilities, err := templates.Describe(initial.Spec.TemplateRef)
			if err != nil {
				t.Fatal(err)
			}
			// Simulate new Helm-provided operator flags without mutating the CR.
			if tc.statsOnly {
				r.StatsImage = newImage
			} else {
				switch tc.name {
				case "bazel-remote":
					r.Image = newImage
				case "gradle-http":
					r.GradleImage = newImage
				case "turborepo-http":
					r.TurborepoImage = newImage
				case "webdav-apache":
					r.WebDAVImage = newImage
				}
			}
			reconcile(t, r, c)
			var after appsv1.StatefulSet
			if err := r.Get(ctx, key, &after); err != nil {
				t.Fatal(err)
			}
			if imageOf(&after, tc.container) != oldImage {
				t.Fatal("installation defaults changed a bound workload")
			}
			if tc.statsOnly && imageOf(&after, "cache") != oldImage {
				t.Fatal("sidecar-only scenario also changed the engine image")
			}
			if !reflect.DeepEqual(before.Spec.Template, after.Spec.Template) {
				t.Fatal("bound pod template changed with installation defaults")
			}
			if err := r.Get(ctx, key, c); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(initial.Spec, c.Spec) || initial.Generation != c.Generation {
				t.Fatal("test changed the instance spec or generation")
			}
			afterCapabilities, err := templates.Describe(c.Spec.TemplateRef)
			if err != nil || afterCapabilities != capabilities {
				t.Fatal("exact-version capabilities changed")
			}
			next := c.DeepCopy()
			next.Name, next.UID, next.ResourceVersion, next.Generation = "cache-next", "uid-next", "", 1
			next.Finalizers = nil
			next.Status = cachev1.CacheInstanceStatus{}
			next.Spec.InstanceID = "id-next"
			next.Spec.Access.CredentialsSecretRef = "auth-next"
			secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "auth-next", Namespace: c.Namespace, Labels: map[string]string{InstanceLabel: "id-next", ProjectLabel: c.Spec.ProjectID}}, Data: map[string][]byte{"htpasswd": []byte("fixture")}}
			if err := r.Create(ctx, secret); err != nil {
				t.Fatal(err)
			}
			if err := r.Create(ctx, next); err != nil {
				t.Fatal(err)
			}
			reconcile(t, r, next)
			var fresh appsv1.StatefulSet
			if err := r.Get(ctx, client.ObjectKeyFromObject(next), &fresh); err != nil {
				t.Fatal(err)
			}
			if imageOf(&fresh, tc.container) != newImage {
				t.Fatal("new instance did not use newly approved defaults")
			}

		})
	}
}

func TestHelmTurborepoImageRequiresExplicitApproval(t *testing.T) {
	helm := os.Getenv("HELM_BIN")
	if helm == "" {
		t.Skip("set HELM_BIN for chart approval checks")
	}
	chart := filepath.Join("..", "..", "..", "deploy", "charts", "expbuild")
	args := []string{"template", "turbo-test", chart, "--kube-version", "1.32.0", "-f", filepath.Join(chart, "ci-values.yaml")}
	for _, tc := range []struct {
		image          string
		valid, enabled bool
	}{
		{"", true, false}, {"example.invalid/turbo:latest", false, false}, {"example.invalid/turbo@sha256:" + strings.Repeat("a", 64), true, true},
	} {
		out, err := exec.Command(helm, append(append([]string{}, args...), "--set-string", "images.turborepo="+tc.image)...).CombinedOutput()
		if (err == nil) != tc.valid {
			t.Fatalf("approval validation %q: %v %s", tc.image, err, out)
		}
		expectedFlag := `TURBOREPO_ENABLED, value: "false"`
		if tc.enabled {
			expectedFlag = `TURBOREPO_ENABLED, value: "true"`
		}
		if tc.valid && (bytes.Contains(out, []byte("--turborepo-image=")) != tc.enabled || !bytes.Contains(out, []byte(expectedFlag))) {
			t.Fatal("image approval and feature availability disagree")
		}
	}
}
