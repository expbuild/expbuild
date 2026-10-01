package monitoring

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"regexp"

	"github.com/go-logr/logr"
	"k8s.io/client-go/rest"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
)

// MetricsOptions keeps the endpoint disabled unless an explicit bind address and
// a dedicated installation credential are provided. No Kubernetes RBAC expansion.
func MetricsOptions(address, token string) (metricsserver.Options, error) {
	options := metricsserver.Options{BindAddress: address}
	if address == "0" {
		return options, nil
	}
	if address == "" || len(token) < 32 || len(token) > 8192 || !regexp.MustCompile(`^[a-zA-Z0-9._~+/-]+=*$`).MatchString(token) {
		return options, fmt.Errorf("metrics require a bind address and valid METRICS_SCRAPE_TOKEN")
	}
	options.FilterProvider = func(_ *rest.Config, _ *http.Client) (metricsserver.Filter, error) {
		return func(_ logr.Logger, handler http.Handler) (http.Handler, error) {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
					http.Error(w, "metrics authentication required", http.StatusUnauthorized)
					return
				}
				w.Header().Set("Cache-Control", "no-store")
				handler.ServeHTTP(w, r)
			}), nil
		}, nil
	}
	return options, nil
}
