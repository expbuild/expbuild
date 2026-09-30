// Package instance defines the first, deliberately narrow engine contract.
package instance

import (
	"fmt"
	"regexp"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/util/validation"
)

// Config is input to the renderer, not the future Kubernetes CRD.
// Image is supplied by the trusted template registry, never by an end user.
type Config struct {
	Name              string                      `json:"name"`
	Namespace         string                      `json:"namespace"`
	InstanceID        string                      `json:"instanceId"`
	ProjectID         string                      `json:"projectId"`
	Image             string                      `json:"image"`
	StorageClass      string                      `json:"storageClass"`
	Capacity          string                      `json:"capacity"`
	MaxCacheGiB       int64                       `json:"maxCacheGiB"`
	CredentialsSecret string                      `json:"credentialsSecret"`
	DesiredState      string                      `json:"desiredState"`
	Resources         corev1.ResourceRequirements `json:"resources"`
}

var pinnedImage = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`)

func (c Config) ValidateCommon() error {
	// Leave space for resource suffixes and StatefulSet ordinal names.
	if len(c.Name) > 40 || len(validation.IsDNS1123Label(c.Name)) != 0 {
		return fmt.Errorf("name must be a DNS label of at most 40 characters")
	}
	if len(validation.IsDNS1123Label(c.Namespace)) != 0 {
		return fmt.Errorf("invalid namespace")
	}
	for key, value := range map[string]string{"instanceId": c.InstanceID, "projectId": c.ProjectID} {
		if value == "" || len(validation.IsValidLabelValue(value)) != 0 {
			return fmt.Errorf("invalid %s", key)
		}
	}
	if !pinnedImage.MatchString(c.Image) {
		return fmt.Errorf("image must be pinned to a lowercase sha256 digest")
	}
	if len(validation.IsDNS1123Subdomain(c.CredentialsSecret)) != 0 {
		return fmt.Errorf("credentialsSecret is required and must be a valid Secret name")
	}
	if c.StorageClass == "" || len(validation.IsDNS1123Subdomain(c.StorageClass)) != 0 {
		return fmt.Errorf("storageClass must be explicitly selected")
	}
	if c.DesiredState != "Running" && c.DesiredState != "Suspended" {
		return fmt.Errorf("desiredState must be Running or Suspended")
	}
	capacity, err := resource.ParseQuantity(c.Capacity)
	if err != nil || capacity.Sign() <= 0 {
		return fmt.Errorf("capacity must be a positive Kubernetes quantity")
	}
	for _, name := range []corev1.ResourceName{corev1.ResourceCPU, corev1.ResourceMemory} {
		request, ok := c.Resources.Requests[name]
		if !ok || request.Sign() <= 0 {
			return fmt.Errorf("positive %s request required", name)
		}
		limit, ok := c.Resources.Limits[name]
		if !ok || limit.Sign() <= 0 || limit.Cmp(request) < 0 {
			return fmt.Errorf("%s limit must be positive and at least its request", name)
		}
	}
	if len(c.Resources.Requests) != 2 || len(c.Resources.Limits) != 2 || len(c.Resources.Claims) != 0 {
		return fmt.Errorf("only cpu and memory resources are supported")
	}
	return nil
}

// Validate adds bazel-remote cache budget requirements to shared instance checks.
func (c Config) Validate() error {
	if err := c.ValidateCommon(); err != nil {
		return err
	}
	capacity, _ := resource.ParseQuantity(c.Capacity)
	if c.MaxCacheGiB <= 0 {
		return fmt.Errorf("maxCacheGiB must be positive")
	}
	budget := resource.MustParse(fmt.Sprintf("%dGi", c.MaxCacheGiB))
	if budget.Cmp(capacity) >= 0 {
		return fmt.Errorf("cache budget must be smaller than volume capacity")
	}
	return nil
}
