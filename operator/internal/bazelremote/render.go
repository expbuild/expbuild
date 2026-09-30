// Package bazelremote renders resources without performing cluster mutations.
package bazelremote

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
	"k8s.io/utils/ptr"
)

// Render produces a retained PVC, immutable config, headless Service, client
// Service and StatefulSet. Auth Secret provisioning and network policy are
// intentionally outside this renderer; callers must check Secret ownership.
func Render(c instance.Config) ([]runtime.Object, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	labels := func() map[string]string {
		return map[string]string{
			"app.kubernetes.io/managed-by":  "expbuild",
			"cache.expbuild.io/instance-id": c.InstanceID,
			"cache.expbuild.io/project-id":  c.ProjectID,
		}
	}
	meta := func(name string) metav1.ObjectMeta {
		return metav1.ObjectMeta{Name: name, Namespace: c.Namespace, Labels: labels()}
	}
	config := fmt.Sprintf("dir: /data\nmax_size: %d\nhttp_address: 0.0.0.0:8080\ngrpc_address: 0.0.0.0:9092\nhtpasswd_file: /auth/htpasswd\nallow_unauthenticated_reads: false\nenable_endpoint_metrics: true\n", c.MaxCacheGiB)
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(config)))
	configName := c.Name + "-cfg-" + hash[:12]
	immutable := true
	cm := &corev1.ConfigMap{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "ConfigMap"}, ObjectMeta: meta(configName), Immutable: &immutable, Data: map[string]string{"config.yaml": config}}
	// No ownerReference: deleting the instance must not garbage collect data.
	pvc := &corev1.PersistentVolumeClaim{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "PersistentVolumeClaim"}, ObjectMeta: meta(c.Name + "-data"), Spec: corev1.PersistentVolumeClaimSpec{
		AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce}, StorageClassName: &c.StorageClass,
		Resources: corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse(c.Capacity)}},
	}}
	ports := []corev1.ServicePort{{Name: "http", Port: 8080, TargetPort: intstr.FromString("http")}, {Name: "grpc", Port: 9092, AppProtocol: ptr.To("kubernetes.io/h2c"), TargetPort: intstr.FromString("grpc")}}
	svc := &corev1.Service{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Service"}, ObjectMeta: meta(c.Name), Spec: corev1.ServiceSpec{Selector: labels(), Ports: ports}}
	headless := svc.DeepCopy()
	headless.Name = c.Name + "-headless"
	headless.Spec.ClusterIP = corev1.ClusterIPNone
	replicas := int32(1)
	if c.DesiredState == "Suspended" {
		replicas = 0
	}
	no, yes := false, true
	uid := int64(1000)
	probe := func() *corev1.Probe {
		return &corev1.Probe{ProbeHandler: corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromString("grpc")}}, PeriodSeconds: 5, TimeoutSeconds: 2, FailureThreshold: 3}
	}
	startup := probe()
	startup.FailureThreshold = 120
	sts := &appsv1.StatefulSet{TypeMeta: metav1.TypeMeta{APIVersion: "apps/v1", Kind: "StatefulSet"}, ObjectMeta: meta(c.Name), Spec: appsv1.StatefulSetSpec{
		Replicas: &replicas, ServiceName: headless.Name, Selector: &metav1.LabelSelector{MatchLabels: labels()},
		Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels(), Annotations: map[string]string{"cache.expbuild.io/config-hash": hash}}, Spec: corev1.PodSpec{
			AutomountServiceAccountToken: &no,
			SecurityContext:              &corev1.PodSecurityContext{RunAsNonRoot: &yes, RunAsUser: &uid, RunAsGroup: &uid, FSGroup: &uid, SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault}},
			Containers: []corev1.Container{{Name: "cache", Image: c.Image, Args: []string{"--config_file=/config/config.yaml"}, Resources: *c.Resources.DeepCopy(),
				Ports:        []corev1.ContainerPort{{Name: "http", ContainerPort: 8080}, {Name: "grpc", ContainerPort: 9092}},
				VolumeMounts: []corev1.VolumeMount{{Name: "data", MountPath: "/data"}, {Name: "config", MountPath: "/config", ReadOnly: true}, {Name: "auth", MountPath: "/auth", ReadOnly: true}, {Name: "tmp", MountPath: "/tmp"}},
				StartupProbe: startup, ReadinessProbe: probe(), LivenessProbe: probe(),
				SecurityContext: &corev1.SecurityContext{AllowPrivilegeEscalation: &no, ReadOnlyRootFilesystem: &yes, Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}},
			}},
			Volumes: []corev1.Volume{
				{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: ptr.To(resource.MustParse("64Mi"))}}},
				{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: pvc.Name}}},
				{Name: "config", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: cm.Name}}}},
				{Name: "auth", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: c.CredentialsSecret, Items: []corev1.KeyToPath{{Key: "htpasswd", Path: "htpasswd"}}}}},
			},
		}},
	}}
	return []runtime.Object{pvc, cm, headless, svc, sts}, nil
}
