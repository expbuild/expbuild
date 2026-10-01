// Package webdav renders an Apache mod_dav instance. It does not promise a
// cache-aware LRU policy or a filesystem quota that Apache cannot enforce.
package webdav

import (
	"crypto/sha256"
	_ "embed"
	"fmt"
	"strconv"

	"github.com/expbuild/expbuild/operator/internal/instance"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// Configuration keeps lock state outside the DAV document root. All methods,
// including reads, require credentials. No CGI, indexes or symlinks are enabled.
//
//go:embed httpd.conf
var Configuration string

func Render(c instance.Config) ([]runtime.Object, error) {
	if err := c.ValidateCommon(); err != nil {
		return nil, err
	}
	if c.MaxCacheGiB != 0 {
		return nil, fmt.Errorf("WebDAV does not support an engine cache budget; maxCacheGiB must be zero")
	}
	labels := func() map[string]string {
		return map[string]string{"app.kubernetes.io/managed-by": "expbuild", "cache.expbuild.io/instance-id": c.InstanceID, "cache.expbuild.io/project-id": c.ProjectID}
	}
	meta := func(name string) metav1.ObjectMeta {
		return metav1.ObjectMeta{Name: name, Namespace: c.Namespace, Labels: labels()}
	}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(Configuration)))
	yes, no := true, false
	cm := &corev1.ConfigMap{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "ConfigMap"}, ObjectMeta: meta(c.Name + "-cfg-" + hash[:12]), Immutable: &yes, Data: map[string]string{"httpd.conf": Configuration}}
	pvc := &corev1.PersistentVolumeClaim{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "PersistentVolumeClaim"}, ObjectMeta: meta(c.Name + "-data"), Spec: corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce}, StorageClassName: &c.StorageClass, Resources: corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse(c.Capacity)}}}}
	svc := &corev1.Service{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Service"}, ObjectMeta: meta(c.Name), Spec: corev1.ServiceSpec{Selector: labels(), Ports: []corev1.ServicePort{{Name: "http", Port: 8080, TargetPort: intstr.FromString("http")}}}}
	headless := svc.DeepCopy()
	headless.Name = c.Name + "-headless"
	headless.Spec.ClusterIP = corev1.ClusterIPNone
	replicas := int32(1)
	if c.DesiredState == "Suspended" {
		replicas = 0
	}
	uid := int64(1000)
	probe := func() *corev1.Probe {
		return &corev1.Probe{ProbeHandler: corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromString("http")}}, PeriodSeconds: 5, TimeoutSeconds: 2, FailureThreshold: 3}
	}
	startup := probe()
	startup.FailureThreshold = 120
	sts := &appsv1.StatefulSet{TypeMeta: metav1.TypeMeta{APIVersion: "apps/v1", Kind: "StatefulSet"}, ObjectMeta: meta(c.Name), Spec: appsv1.StatefulSetSpec{Replicas: &replicas, ServiceName: headless.Name, Selector: &metav1.LabelSelector{MatchLabels: labels()}, Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels(), Annotations: map[string]string{"cache.expbuild.io/config-hash": hash}}, Spec: corev1.PodSpec{
		AutomountServiceAccountToken: &no,
		SecurityContext:              &corev1.PodSecurityContext{RunAsNonRoot: &yes, RunAsUser: &uid, RunAsGroup: &uid, FSGroup: &uid, SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault}},
		Containers:                   []corev1.Container{{Name: "cache", Image: c.Image, Command: []string{"/bin/sh"}, Args: []string{"-ec", "mkdir -p /data/content /data/locks; exec httpd -DFOREGROUND -f /config/httpd.conf"}, Resources: *c.Resources.DeepCopy(), Ports: []corev1.ContainerPort{{Name: "http", ContainerPort: 8080}}, StartupProbe: startup, ReadinessProbe: probe(), LivenessProbe: probe(), SecurityContext: &corev1.SecurityContext{AllowPrivilegeEscalation: &no, ReadOnlyRootFilesystem: &yes, Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}}, VolumeMounts: []corev1.VolumeMount{{Name: "data", MountPath: "/data"}, {Name: "config", MountPath: "/config", ReadOnly: true}, {Name: "auth", MountPath: "/auth", ReadOnly: true}, {Name: "tmp", MountPath: "/tmp"}}}},
		Volumes:                      []corev1.Volume{{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: pvc.Name}}}, {Name: "config", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: cm.Name}}}}, {Name: "auth", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: c.CredentialsSecret, Items: []corev1.KeyToPath{{Key: "htpasswd", Path: "htpasswd"}}}}}, {Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: quantity("64Mi")}}}},
	}}}}
	return []runtime.Object{pvc, cm, headless, svc, sts}, nil
}

// RenderWithStats is a new template version. The original renderer remains
// available for instances pinned to webdav-apache@0.1.0.
func RenderWithStats(c instance.Config) ([]runtime.Object, error) {
	if c.StatsImage == "" {
		return nil, fmt.Errorf("WebDAV statistics image is not configured")
	}
	objects, err := Render(c)
	if err != nil {
		return nil, err
	}
	capacity, err := resource.ParseQuantity(c.Capacity)
	if err != nil || capacity.Value() <= 0 || capacity.Value() > 1<<50 {
		return nil, fmt.Errorf("unsupported WebDAV statistics capacity")
	}
	const statsCPU, statsMemory = "25m", "32Mi"
	mainResources := c.Resources.DeepCopy()
	statsResources := corev1.ResourceRequirements{Requests: corev1.ResourceList{}, Limits: corev1.ResourceList{}}
	for name, amount := range map[corev1.ResourceName]string{corev1.ResourceCPU: statsCPU, corev1.ResourceMemory: statsMemory} {
		part := resource.MustParse(amount)
		request := mainResources.Requests[name]
		limit := mainResources.Limits[name]
		request.Sub(part)
		limit.Sub(part)
		if request.Sign() <= 0 || limit.Cmp(request) < 0 {
			return nil, fmt.Errorf("insufficient %s for WebDAV statistics sidecar", name)
		}
		mainResources.Requests[name], mainResources.Limits[name] = request, limit
		statsResources.Requests[name], statsResources.Limits[name] = part, part
	}
	svc := objects[3].(*corev1.Service)
	svc.Spec.Ports = append(svc.Spec.Ports, corev1.ServicePort{Name: "stats", Port: 9093, TargetPort: intstr.FromString("stats")})
	sts := objects[4].(*appsv1.StatefulSet)
	sts.Spec.Template.Spec.Containers[0].Resources = *mainResources
	yes, no := true, false
	sts.Spec.Template.Spec.Containers = append(sts.Spec.Template.Spec.Containers, corev1.Container{
		Name: "statistics", Image: c.StatsImage,
		Command:         []string{"/webdav-stats"},
		Args:            []string{"-capacity-bytes=" + strconv.FormatInt(capacity.Value(), 10)},
		Resources:       statsResources,
		Ports:           []corev1.ContainerPort{{Name: "stats", ContainerPort: 9093}},
		ReadinessProbe:  &corev1.Probe{ProbeHandler: corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromString("stats")}}, PeriodSeconds: 5},
		SecurityContext: &corev1.SecurityContext{AllowPrivilegeEscalation: &no, ReadOnlyRootFilesystem: &yes, Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}},
		VolumeMounts:    []corev1.VolumeMount{{Name: "data", MountPath: "/data", ReadOnly: true}, {Name: "auth", MountPath: "/auth", ReadOnly: true}},
	})
	sts.Spec.Template.Spec.Volumes[2].VolumeSource.Secret.Items = append(sts.Spec.Template.Spec.Volumes[2].VolumeSource.Secret.Items,
		corev1.KeyToPath{Key: "probe-username", Path: "probe-username"}, corev1.KeyToPath{Key: "probe-password", Path: "probe-password"})
	return objects, nil
}

func quantity(value string) *resource.Quantity { q := resource.MustParse(value); return &q }
