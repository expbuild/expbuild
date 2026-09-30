package monitoring

import (
	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"testing"
)

func TestBoundIdentityCredentialsAndNarrowIngress(t *testing.T) {
	c := &cachev1.CacheInstance{ObjectMeta: metav1.ObjectMeta{Name: "cache-a", Namespace: "project-a", UID: "uid-a"}, Spec: cachev1.CacheInstanceSpec{ProjectID: "project-a", InstanceID: "instance-a", TemplateRef: cachev1.TemplateRef{Name: "bazel-remote"}, Access: cachev1.AccessSpec{CredentialsSecretRef: "auth-v2"}}}
	objects, err := (Config{Namespace: "monitoring"}).Render(c)
	if err != nil {
		t.Fatal(err)
	}
	m := objects[0].(*unstructured.Unstructured)
	endpoints, _, _ := unstructured.NestedSlice(m.Object, "spec", "endpoints")
	endpoint := endpoints[0].(map[string]any)
	auth := endpoint["basicAuth"].(map[string]any)
	if auth["password"].(map[string]any)["name"] != "auth-v2" || endpoint["honorLabels"] != false || endpoint["followRedirects"] != false {
		t.Fatal("unsafe credentials or label semantics")
	}
	relabel := endpoint["relabelings"].([]any)
	if relabel[0].(map[string]any)["regex"] != "cache-a" {
		t.Fatal("headless target not excluded")
	}
	p := objects[1].(*networkingv1.NetworkPolicy)
	rule := p.Spec.Ingress[0]
	if len(rule.From) != 1 || rule.From[0].NamespaceSelector.MatchLabels["kubernetes.io/metadata.name"] != "monitoring" || rule.From[0].PodSelector.MatchLabels["cache.expbuild.io/monitoring"] != "true" || len(rule.Ports) != 1 || rule.Ports[0].Port.IntVal != 8080 {
		t.Fatal("monitoring ingress is too broad")
	}
	c.Spec.TemplateRef.Name = "webdav-apache"
	if _, err := (Config{Namespace: "monitoring"}).Render(c); err == nil {
		t.Fatal("unsupported engine accepted")
	}
}
