package main

import (
	"flag"
	"fmt"
	"os"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	"github.com/expbuild/expbuild/operator/internal/controller"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
)

func main() {
	image := flag.String("bazel-remote-image", "", "administrator-approved digest-pinned engine image")
	webdavImage := flag.String("webdav-image", "", "optional approved digest-pinned Apache WebDAV image")
	namespace := flag.String("namespace", "", "optional single project namespace; empty watches all managed projects")
	leaderNamespace := flag.String("leader-election-namespace", "expbuild-system", "control plane namespace for leader election")
	leader := flag.Bool("leader-elect", true, "enable leader election")
	flag.Parse()
	if *image == "" || *leaderNamespace == "" {
		fmt.Fprintln(os.Stderr, "--bazel-remote-image and a leader election namespace are required")
		os.Exit(2)
	}
	ctrl.SetLogger(zap.New())
	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		panic(err)
	}
	if err := cachev1.AddToScheme(scheme); err != nil {
		panic(err)
	}
	cacheOptions := cache.Options{}
	if *namespace != "" {
		cacheOptions.DefaultNamespaces = map[string]cache.Config{*namespace: {}}
	}
	m, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme: scheme, Cache: cacheOptions,
		LeaderElection: *leader, LeaderElectionID: "expbuild-cache-operator", LeaderElectionNamespace: *leaderNamespace,
		HealthProbeBindAddress: ":8081", Metrics: metricsserver.Options{BindAddress: "0"},
	})
	if err != nil {
		panic(err)
	}
	r := &controller.Reconciler{Client: m.GetClient(), Reader: m.GetAPIReader(), Image: *image, WebDAVImage: *webdavImage, Probe: controller.ProtocolProbe{}}
	if err = r.SetupWithManager(m); err != nil {
		panic(err)
	}
	if err = m.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		panic(err)
	}
	if err = m.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		panic(err)
	}
	if err = m.Start(ctrl.SetupSignalHandler()); err != nil {
		ctrl.Log.Error(err, "operator stopped")
		os.Exit(1)
	}
}
