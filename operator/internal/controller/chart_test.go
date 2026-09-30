package controller

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/util/yaml"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func checkChart(t *testing.T, ctx context.Context, cl client.Client) {
	t.Helper()
	helm := os.Getenv("HELM_BIN")
	if helm == "" {
		t.Skip("set HELM_BIN to validate rendered deployment resources")
	}
	chart := filepath.Join("..", "..", "..", "deploy", "charts", "expbuild")
	values := filepath.Join(chart, "ci-values.yaml")
	args := []string{"template", "test", chart, "--namespace", "chart-test", "-f", values, "--include-crds", "--set", "bootstrap.enabled=true"}
	rendered, err := exec.Command(helm, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("helm template: %v\n%s", err, rendered)
	}
	if err := cl.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "chart-test"}}); err != nil {
		t.Fatal(err)
	}
	decoder := yaml.NewYAMLOrJSONDecoder(bytes.NewReader(rendered), 4096)
	counts := map[string]int{}
	for {
		var object unstructured.Unstructured
		if err := decoder.Decode(&object); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		if len(object.Object) == 0 {
			continue
		}
		counts[object.GetKind()]++
		if object.GetKind() == "CustomResourceDefinition" {
			continue
		} // Installed by envtest before this subtest.
		if object.GetKind() != "ClusterRole" && object.GetKind() != "ClusterRoleBinding" {
			object.SetNamespace("chart-test")
		}
		if err := cl.Create(ctx, &object, &client.CreateOptions{DryRun: []string{metav1.DryRunAll}}); err != nil {
			t.Fatalf("%s/%s is invalid: %v", object.GetKind(), object.GetName(), err)
		}
		// Install only identities and permissions in envtest, never workloads.
		switch object.GetKind() {
		case "ServiceAccount", "ClusterRole", "ClusterRoleBinding", "Role", "RoleBinding":
			object.SetResourceVersion("")
			if err := cl.Create(ctx, &object); err != nil {
				t.Fatalf("install test RBAC %s/%s: %v", object.GetKind(), object.GetName(), err)
			}
		}
	}
	checkChartPermissions(t, ctx, cl)
	for kind, want := range map[string]int{"Deployment": 3, "Service": 2, "Job": 2, "Ingress": 1, "CustomResourceDefinition": 1} {
		if counts[kind] != want {
			t.Fatalf("%s count=%d, want %d", kind, counts[kind], want)
		}
	}
	for _, invalid := range []string{"images.bazelRemote=example.invalid/cache:latest", "appOrigin=https://wrong.example.test", "secrets.bootstrap="} {
		badArgs := append(append([]string{}, args...), "--set", invalid)
		if output, err := exec.Command(helm, badArgs...).CombinedOutput(); err == nil {
			t.Fatalf("invalid setting %q accepted: %s", invalid, output)
		}
	}
}

func checkChartPermissions(t *testing.T, ctx context.Context, cl client.Client) {
	t.Helper()
	for _, p := range []struct {
		component, verb, group, resource, subresource, namespace string
		allowed                                                  bool
	}{
		{"operator", "get", "", "secrets", "", "project-a", true},
		{"operator", "watch", "", "secrets", "", "project-b", true},
		{"operator", "delete", "", "secrets", "", "project-a", false},
		{"operator", "create", "apps", "statefulsets", "", "project-a", true},
		{"operator", "patch", "cache.expbuild.io", "cacheinstances", "status", "project-b", true},
		{"operator", "delete", "", "persistentvolumeclaims", "", "project-a", true},
		{"operator", "delete", "", "persistentvolumes", "", "", false},
		{"operator", "create", "gateway.networking.k8s.io", "httproutes", "", "project-a", true},
		{"operator", "delete", "gateway.networking.k8s.io", "grpcroutes", "", "project-a", true},
		{"operator", "get", "gateway.networking.k8s.io", "gateways", "", "edge", true},
		{"operator", "update", "gateway.networking.k8s.io", "gateways", "", "edge", false},
		{"operator", "create", "networking.k8s.io", "networkpolicies", "", "project-a", true},
		{"api", "create", "gateway.networking.k8s.io", "httproutes", "", "project-a", false},
		{"operator", "create", "coordination.k8s.io", "leases", "", "chart-test", true},
		{"operator", "create", "coordination.k8s.io", "leases", "", "project-a", false},
		{"api", "create", "", "namespaces", "", "", true},
		{"api", "delete", "", "namespaces", "", "", false},
		{"api", "create", "", "secrets", "", "project-a", true},
		{"api", "delete", "", "secrets", "", "project-b", true},
		{"api", "list", "", "secrets", "", "project-a", false},
		{"api", "update", "cache.expbuild.io", "cacheinstances", "", "project-a", true},
		{"api", "update", "cache.expbuild.io", "cacheinstances", "status", "project-a", false},
		{"api", "create", "networking.k8s.io", "networkpolicies", "", "project-b", true},
		{"api", "create", "apps", "statefulsets", "", "project-a", false},
		{"api", "get", "", "persistentvolumeclaims", "", "project-a", true},
		{"api", "delete", "", "persistentvolumeclaims", "", "project-a", true},
		{"api", "create", "", "persistentvolumeclaims", "", "project-a", false},
		{"api", "delete", "", "persistentvolumes", "", "", false},
		{"api", "list", "", "pods", "", "project-a", true},
		{"api", "delete", "", "pods", "", "project-a", false},
		{"api", "get", "", "pods", "exec", "project-a", false},
		{"api", "create", "rbac.authorization.k8s.io", "clusterrolebindings", "", "", false},
		{"web", "get", "", "secrets", "", "project-a", false},
		{"web", "get", "cache.expbuild.io", "cacheinstances", "", "project-a", false},
	} {
		t.Run(p.component+"/"+p.verb+"/"+p.resource+"/"+p.subresource+"/"+p.namespace, func(t *testing.T) {
			review := &authorizationv1.SubjectAccessReview{Spec: authorizationv1.SubjectAccessReviewSpec{
				User:               "system:serviceaccount:chart-test:test-expbuild-" + p.component,
				ResourceAttributes: &authorizationv1.ResourceAttributes{Verb: p.verb, Group: p.group, Resource: p.resource, Subresource: p.subresource, Namespace: p.namespace},
			}}
			if err := cl.Create(ctx, review); err != nil {
				t.Fatal(err)
			}
			if review.Status.Allowed != p.allowed {
				t.Fatalf("allowed=%v, want %v: %+v", review.Status.Allowed, p.allowed, review.Status)
			}
		})
	}
}

func TestChartCRDMatchesSource(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "config", "crd", "cache.expbuild.io_cacheinstances.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	chart, err := os.ReadFile(filepath.Join("..", "..", "..", "deploy", "charts", "expbuild", "crds", "cache.expbuild.io_cacheinstances.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(source, chart) {
		t.Fatal("chart CRD is stale; run make generate")
	}
}
