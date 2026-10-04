package nxcache

import (
	"crypto/sha256"
	"fmt"

	"github.com/expbuild/expbuild/operator/internal/instance"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// Render creates one authenticated Nx cache process with a dedicated PVC.
// The engine's budget remains below the requested volume capacity.
func Render(c instance.Config) ([]runtime.Object, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	if c.MaxCacheGiB > (1<<63-1)/(1<<30) {
		return nil, fmt.Errorf("Nx cache budget overflows bytes")
	}
	budget := c.MaxCacheGiB * (1 << 30)
	entryLimit := budget - headerSize
	if entryLimit > 256<<20 {
		entryLimit = 256 << 20
	}
	capacity, _ := resource.ParseQuantity(c.Capacity)
	volumeBytes, exact := capacity.AsInt64()
	if !exact {
		return nil, fmt.Errorf("Nx PVC capacity must fit whole bytes")
	}
	// Reserve space for one bounded upload envelope in addition to committed
	// entries; the staged body is not part of the engine's committed budget.
	stagingLimit := volumeBytes - budget - headerSize
	if stagingLimit <= 0 {
		return nil, fmt.Errorf("Nx PVC requires upload staging headroom")
	}
	if entryLimit > stagingLimit {
		entryLimit = stagingLimit
	}
	args := []string{"--namespace=" + c.InstanceID, fmt.Sprintf("--max-total-bytes=%d", budget), fmt.Sprintf("--max-entry-bytes=%d", entryLimit)}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprint(args))))
	labels := func() map[string]string {
		return map[string]string{"app.kubernetes.io/managed-by": "expbuild", "cache.expbuild.io/project-id": c.ProjectID, "cache.expbuild.io/instance-id": c.InstanceID}
	}
	meta := func(name string) metav1.ObjectMeta {
		return metav1.ObjectMeta{Name: name, Namespace: c.Namespace, Labels: labels()}
	}
	pvc := &corev1.PersistentVolumeClaim{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "PersistentVolumeClaim"}, ObjectMeta: meta(c.Name + "-data"), Spec: corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce}, StorageClassName: &c.StorageClass, Resources: corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse(c.Capacity)}}}}
	svc := &corev1.Service{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Service"}, ObjectMeta: meta(c.Name), Spec: corev1.ServiceSpec{Selector: labels(), Ports: []corev1.ServicePort{{Name: "http", Port: 8080, TargetPort: intstr.FromString("http")}}}}
	headless := svc.DeepCopy()
	headless.Name = c.Name + "-headless"
	headless.Spec.ClusterIP = corev1.ClusterIPNone
	replicas := int32(1)
	if c.DesiredState == "Suspended" {
		replicas = 0
	}
	yes, no := true, false
	uid := int64(1000)
	probe := func() *corev1.Probe {
		return &corev1.Probe{ProbeHandler: corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromString("http")}}, PeriodSeconds: 5, TimeoutSeconds: 2, FailureThreshold: 3}
	}
	startup := probe()
	startup.FailureThreshold = 120
	sts := &appsv1.StatefulSet{TypeMeta: metav1.TypeMeta{APIVersion: "apps/v1", Kind: "StatefulSet"}, ObjectMeta: meta(c.Name), Spec: appsv1.StatefulSetSpec{Replicas: &replicas, ServiceName: headless.Name, Selector: &metav1.LabelSelector{MatchLabels: labels()}, Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels(), Annotations: map[string]string{"cache.expbuild.io/config-hash": hash}}, Spec: corev1.PodSpec{
		AutomountServiceAccountToken: &no, SecurityContext: &corev1.PodSecurityContext{RunAsNonRoot: &yes, RunAsUser: &uid, RunAsGroup: &uid, FSGroup: &uid, SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault}},
		Containers: []corev1.Container{{Name: "cache", Image: c.Image, Args: args, Resources: *c.Resources.DeepCopy(), Ports: []corev1.ContainerPort{{Name: "http", ContainerPort: 8080}}, StartupProbe: startup, ReadinessProbe: probe(), LivenessProbe: probe(), SecurityContext: &corev1.SecurityContext{AllowPrivilegeEscalation: &no, ReadOnlyRootFilesystem: &yes, Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}}, VolumeMounts: []corev1.VolumeMount{{Name: "data", MountPath: "/data"}, {Name: "auth", MountPath: "/auth", ReadOnly: true}}}},
		Volumes:    []corev1.Volume{{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: pvc.Name}}}, {Name: "auth", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: c.CredentialsSecret, Items: []corev1.KeyToPath{{Key: "htpasswd", Path: "htpasswd"}}}}}},
	}}}}
	return []runtime.Object{pvc, headless, svc, sts}, nil
}
