// +kubebuilder:object:generate=true
// +groupName=cache.expbuild.io
package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

var GroupVersion = schema.GroupVersion{Group: "cache.expbuild.io", Version: "v1alpha1"}

func AddToScheme(s *runtime.Scheme) error {
	s.AddKnownTypes(GroupVersion, &CacheInstance{}, &CacheInstanceList{})
	metav1.AddToGroupVersion(s, GroupVersion)
	return nil
}

type TemplateRef struct {
	// +kubebuilder:validation:Enum=bazel-remote;webdav-apache
	Name string `json:"name"`
	// +kubebuilder:validation:Enum="0.1.0"
	Version string `json:"version"`
}

type StorageSpec struct {
	ClassName string `json:"className"`
	Capacity  string `json:"capacity"`
	// +kubebuilder:validation:Enum=Retain;Delete
	// +kubebuilder:default=Retain
	DeletionPolicy string `json:"deletionPolicy"`
}

type AccessSpec struct {
	// +kubebuilder:validation:Enum=ClusterInternal;Gateway
	Exposure             string `json:"exposure"`
	CredentialsSecretRef string `json:"credentialsSecretRef"`
}

type EvictionSpec struct {
	// +kubebuilder:validation:Minimum=0
	MaxCacheGiB int64 `json:"maxCacheGiB"`
	// +kubebuilder:validation:Enum=lru;none
	EnginePolicy string `json:"enginePolicy"`
}

// +kubebuilder:validation:XValidation:rule="self.instanceId == oldSelf.instanceId",message="instanceId is immutable"
// +kubebuilder:validation:XValidation:rule="self.projectId == oldSelf.projectId",message="projectId is immutable"
// +kubebuilder:validation:XValidation:rule="self.templateRef == oldSelf.templateRef",message="template changes require a supported upgrade operation"
// +kubebuilder:validation:XValidation:rule="self.storage.className == oldSelf.storage.className",message="storage class is immutable"
// +kubebuilder:validation:XValidation:rule="self.templateRef.name == 'bazel-remote' ? (self.eviction.enginePolicy == 'lru' && self.eviction.maxCacheGiB > 0) : (self.eviction.enginePolicy == 'none' && self.eviction.maxCacheGiB == 0)",message="eviction policy must match engine capabilities"
type CacheInstanceSpec struct {
	// +kubebuilder:validation:MinLength=1
	InstanceID string `json:"instanceId"`
	// +kubebuilder:validation:MinLength=1
	ProjectID   string      `json:"projectId"`
	TemplateRef TemplateRef `json:"templateRef"`
	// +kubebuilder:validation:Enum=Running;Suspended
	// +kubebuilder:default=Running
	DesiredState string                      `json:"desiredState"`
	Storage      StorageSpec                 `json:"storage"`
	Access       AccessSpec                  `json:"access"`
	Eviction     EvictionSpec                `json:"eviction"`
	Resources    corev1.ResourceRequirements `json:"resources"`
}

type Endpoint struct {
	Protocol string `json:"protocol"`
	URL      string `json:"url"`
}

type CacheInstanceStatus struct {
	ObservedGeneration     int64      `json:"observedGeneration,omitempty"`
	AppliedConfigHash      string     `json:"appliedConfigHash,omitempty"`
	CredentialRevision     string     `json:"credentialRevision,omitempty"`
	AppliedTemplateVersion string     `json:"appliedTemplateVersion,omitempty"`
	Endpoints              []Endpoint `json:"endpoints,omitempty"`
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="State",type=string,JSONPath=`.spec.desiredState`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
type CacheInstance struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              CacheInstanceSpec   `json:"spec"`
	Status            CacheInstanceStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type CacheInstanceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []CacheInstance `json:"items"`
}
