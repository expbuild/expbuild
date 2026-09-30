package gradlecache

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
)

// CheckProtocol confirms authentication and the budget applied by this exact
// process. The TCP Pod probe alone cannot establish either property.
func CheckProtocol(ctx context.Context, c *cachev1.CacheInstance, secret *corev1.Secret, base string) error {
	username, password := string(secret.Data["probe-username"]), string(secret.Data["probe-password"])
	if username == "" || password == "" {
		return fmt.Errorf("probe credentials are missing")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/status", nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(username, password)
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("Gradle HTTP status probe failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Gradle HTTP status probe returned %d", response.StatusCode)
	}
	var state struct {
		SizeBytes, CapacityBytes int64
		Entries                  int
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&state); err != nil {
		return fmt.Errorf("invalid Gradle HTTP status")
	}
	if c.Spec.Eviction.MaxCacheGiB <= 0 || c.Spec.Eviction.MaxCacheGiB > (1<<63-1)/(1<<30) || state.CapacityBytes != c.Spec.Eviction.MaxCacheGiB*(1<<30) || state.SizeBytes < 0 || state.SizeBytes > state.CapacityBytes || state.Entries < 0 {
		return fmt.Errorf("Gradle HTTP budget is not applied")
	}
	return nil
}
