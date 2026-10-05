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
	// +kubebuilder:validation:Enum=bazel-remote;webdav-apache;gradle-http;turborepo-http;nx-http;go-cacheprog
	// +kubebuilder:validation:MaxLength=32
	Name string `json:"name"`
	// +kubebuilder:validation:Enum="0.1.0";"0.2.0"
	// +kubebuilder:validation:MaxLength=16
	Version string `json:"version"`
}

type StorageSpec struct {
	ClassName string `json:"className"`
	Capacity  string `json:"capacity"`
	// +kubebuilder:validation:Enum=Retain;Delete
	// +kubebuilder:default=Retain
	DeletionPolicy string `json:"deletionPolicy"`
	// Reclaim authorizes a single retained PVC transfer from a previous CR UID.
	// The PVC UID pins the exact volume, so a same-name replacement is rejected.
	Reclaim *ReclaimSpec `json:"reclaim,omitempty"`
}

type ReclaimSpec struct {
	// +kubebuilder:validation:MinLength=1
	PreviousInstanceUID string `json:"previousInstanceUID"`
	// +kubebuilder:validation:MinLength=1
	VolumeUID string `json:"volumeUID"`
}

type AccessSpec struct {
	// ReadOnly is a server-enforced cacheprog policy; other templates reject true.
	ReadOnly bool `json:"readOnly,omitempty"`
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
// +kubebuilder:validation:XValidation:rule="has(self.imageBindingMode) == has(oldSelf.imageBindingMode) && (!has(self.imageBindingMode) || self.imageBindingMode == oldSelf.imageBindingMode)",message="image binding creation mode is immutable"
// +kubebuilder:validation:XValidation:rule="self.templateRef.name != 'bazel-remote' || self.templateRef.version == '0.1.0'",message="unsupported bazel-remote template version"
// +kubebuilder:validation:XValidation:rule="self.templateRef.name != 'turborepo-http' || self.templateRef.version == '0.1.0'",message="unsupported turborepo-http template version"
// +kubebuilder:validation:XValidation:rule="self.templateRef.name != 'nx-http' || self.templateRef.version == '0.1.0'",message="unsupported nx-http template version"
// +kubebuilder:validation:XValidation:rule="self.templateRef.name != 'go-cacheprog' || self.templateRef.version == '0.1.0'",message="unsupported go-cacheprog template version"
// +kubebuilder:validation:XValidation:rule="self.templateRef.name != 'gradle-http' || self.templateRef.version in ['0.1.0','0.2.0']",message="unsupported gradle-http template version"
// +kubebuilder:validation:XValidation:rule="self.storage.className == oldSelf.storage.className",message="storage class is immutable"
// +kubebuilder:validation:XValidation:rule="has(self.storage.reclaim) == has(oldSelf.storage.reclaim) && (!has(self.storage.reclaim) || self.storage.reclaim == oldSelf.storage.reclaim)",message="retained volume identity is immutable"
// +kubebuilder:validation:XValidation:rule="self.templateRef.name == 'bazel-remote' || self.templateRef.name == 'gradle-http' || self.templateRef.name == 'turborepo-http' || self.templateRef.name == 'nx-http' || self.templateRef.name == 'go-cacheprog' ? (self.eviction.enginePolicy == 'lru' && self.eviction.maxCacheGiB > 0) : (self.eviction.enginePolicy == 'none' && self.eviction.maxCacheGiB == 0)",message="eviction policy must match engine capabilities"
// +kubebuilder:validation:XValidation:rule="!has(self.access.readOnly) || !self.access.readOnly || self.templateRef.name == 'go-cacheprog'",message="server readOnly is supported only by go-cacheprog"
type CacheInstanceSpec struct {
	// No default: absence identifies pre-binding instances. Creation-only opt-in.
	// +kubebuilder:validation:Enum=PinnedV1
	ImageBindingMode string `json:"imageBindingMode,omitempty"`
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
	ImageBinding           *ImageBinding `json:"imageBinding,omitempty"`
	ObservedGeneration     int64         `json:"observedGeneration,omitempty"`
	AppliedConfigHash      string        `json:"appliedConfigHash,omitempty"`
	CredentialRevision     string        `json:"credentialRevision,omitempty"`
	AppliedTemplateVersion string        `json:"appliedTemplateVersion,omitempty"`
	Endpoints              []Endpoint    `json:"endpoints,omitempty"`
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:validation:MaxLength=512
// +kubebuilder:validation:Pattern=`^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`
type ImageDigest string

// ImageBinding is operator-owned trust, never end-user image selection.
type ImageBinding struct {
	// +kubebuilder:validation:Enum=v1
	Format string `json:"format"`
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	InstanceUID string      `json:"instanceUID"`
	TemplateRef TemplateRef `json:"templateRef"`
	// +kubebuilder:validation:MinProperties=1
	// +kubebuilder:validation:MaxProperties=2
	Images map[string]ImageDigest `json:"images"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:validation:XValidation:rule="!has(oldSelf.status) || !has(oldSelf.status.imageBinding) || (has(self.status) && has(self.status.imageBinding) && self.status.imageBinding == oldSelf.status.imageBinding)",message="image binding is immutable, including removal"
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
