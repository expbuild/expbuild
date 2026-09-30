// Package webdav renders an Apache mod_dav instance. It does not promise a
// cache-aware LRU policy or a filesystem quota that Apache cannot enforce.
package webdav

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

// Configuration keeps lock state outside the DAV document root. All methods,
// including reads, require credentials. No CGI, indexes or symlinks are enabled.
const Configuration = `ServerRoot "/usr/local/apache2"
ServerName localhost
Listen 0.0.0.0:8080
PidFile /tmp/httpd.pid
DefaultRuntimeDir /tmp
LoadModule mpm_event_module modules/mod_mpm_event.so
<IfModule !unixd_module>
    LoadModule unixd_module modules/mod_unixd.so
</IfModule>
LoadModule authn_core_module modules/mod_authn_core.so
LoadModule authz_core_module modules/mod_authz_core.so
LoadModule authn_file_module modules/mod_authn_file.so
LoadModule authz_user_module modules/mod_authz_user.so
LoadModule auth_basic_module modules/mod_auth_basic.so
LoadModule dav_module modules/mod_dav.so
LoadModule dav_fs_module modules/mod_dav_fs.so
User "#1000"
Group "#1000"
ErrorLog /proc/self/fd/2
LogLevel warn
ServerTokens Prod
ServerSignature Off
TraceEnable Off
Timeout 60
KeepAlive On
MaxKeepAliveRequests 100
KeepAliveTimeout 5
StartServers 1
ServerLimit 2
ThreadsPerChild 25
MaxRequestWorkers 50
DocumentRoot "/data/content"
DavLockDB "/data/locks/DavLock"
DavDepthInfinity Off
LimitXMLRequestBody 1048576
<Directory />
    AllowOverride None
    Require all denied
</Directory>
<Directory "/data/content">
    Options None
    AllowOverride None
    Dav On
    AuthType Basic
    AuthName "expbuild WebDAV"
    AuthBasicProvider file
    AuthUserFile "/auth/htpasswd"
    Require valid-user
</Directory>
`

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

func quantity(value string) *resource.Quantity { q := resource.MustParse(value); return &q }
