package turbocache

import (
	"context"
	"fmt"
	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAuthenticatedScopeAndBudgetProbe(t *testing.T) {
	c := &cachev1.CacheInstance{}
	c.Spec.InstanceID = "instance"
	c.Spec.Eviction.MaxCacheGiB = 1
	secret := &corev1.Secret{Data: map[string][]byte{"probe-username": []byte("health"), "probe-password": []byte("secret")}}
	for _, tc := range []struct {
		name, body string
		status     int
		ok         bool
	}{
		{"valid", `{"sizeBytes":4,"capacityBytes":1073741824,"entries":1,"team":"team_instance"}`, 200, true},
		{"wrong team", `{"sizeBytes":4,"capacityBytes":1073741824,"entries":1,"team":"team_other"}`, 200, false},
		{"wrong budget", `{"sizeBytes":4,"capacityBytes":16,"entries":1,"team":"team_instance"}`, 200, false},
		{"over capacity", `{"sizeBytes":1073741825,"capacityBytes":1073741824,"entries":1,"team":"team_instance"}`, 200, false},
		{"unauthorized", `{}`, 401, false},
		{"redirect", `{}`, 302, false},
		{"invalid body", `not json`, 200, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				u, p, ok := r.BasicAuth()
				if !ok || u != "health" || p != "secret" || r.URL.Path != "/status" {
					t.Error("probe auth/path changed")
				}
				w.Header().Set("Location", "/status")
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer server.Close()
			if err := CheckProtocol(context.Background(), c, secret, server.URL); (err == nil) != tc.ok {
				t.Fatalf("unexpected result: %v", err)
			}
		})
	}
	if err := CheckProtocol(context.Background(), c, &corev1.Secret{}, "http://invalid"); err == nil {
		t.Fatal("missing credentials accepted")
	}
}
