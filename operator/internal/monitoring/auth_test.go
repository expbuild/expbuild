package monitoring

import (
	"github.com/go-logr/logr"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetricsEndpointRequiresDedicatedCredential(t *testing.T) {
	if _, err := MetricsOptions("0", ""); err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{"", "short", strings.Repeat("x", 32) + "\n"} {
		if _, err := MetricsOptions(":9090", token); err == nil {
			t.Fatal("accepted invalid credential")
		}
	}
	token := strings.Repeat("dedicated-token-", 3)
	options, err := MetricsOptions(":9090", token)
	if err != nil {
		t.Fatal(err)
	}
	factory, err := options.FilterProvider(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := factory(logr.Discard(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("metrics")) }))
	if err != nil {
		t.Fatal(err)
	}
	for _, auth := range []string{"", "Bearer wrong", "Basic " + token, "Bearer " + token} {
		req := httptest.NewRequest("GET", "/metrics", nil)
		req.Header.Set("Authorization", auth)
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		expected := http.StatusUnauthorized
		if auth == "Bearer "+token {
			expected = http.StatusOK
		}
		if res.Code != expected {
			t.Fatalf("status=%d expected=%d", res.Code, expected)
		}
		if strings.Contains(res.Body.String(), token) {
			t.Fatal("response leaked credential")
		}
	}
}
