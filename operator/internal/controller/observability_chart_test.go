package controller

import (
	"bytes"
	"io"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/util/yaml"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestObservabilityChart(t *testing.T) {
	helm := os.Getenv("HELM_BIN")
	if helm == "" {
		t.Skip("set HELM_BIN")
	}
	chart := filepath.Join("..", "..", "..", "deploy", "charts", "expbuild")
	base := []string{"template", "test", chart, "-f", filepath.Join(chart, "ci-values.yaml"), "--namespace", "test"}
	defaults, err := exec.Command(helm, base...).CombinedOutput()
	if err != nil {
		t.Fatalf("default: %v %s", err, defaults)
	}
	for _, s := range []string{"kind: ServiceMonitor", "kind: PrometheusRule", "METRICS_SCRAPE_TOKEN"} {
		if bytes.Contains(defaults, []byte(s)) {
			t.Fatalf("enabled by default: %s", s)
		}
	}
	args := append(append([]string{}, base...), "--set", "monitoring.platform.enabled=true,monitoring.platform.tokenSecret=metrics-auth,monitoring.platform.serviceMonitor=true,monitoring.platform.rules=true,monitoring.clusterId=testing")
	data, err := exec.Command(helm, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("enabled: %v %s", err, data)
	}
	decoder := yaml.NewYAMLOrJSONDecoder(bytes.NewReader(data), 4096)
	monitors, rules, tokenRefs := 0, 0, 0
	for {
		var obj unstructured.Unstructured
		if err := decoder.Decode(&obj); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		switch obj.GetKind() {
		case "ServiceMonitor":
			monitors++
			endpoints, _, _ := unstructured.NestedSlice(obj.Object, "spec", "endpoints")
			if len(endpoints) != 1 {
				t.Fatal("endpoint count")
			}
			endpoint := endpoints[0].(map[string]interface{})
			ref, _, _ := unstructured.NestedStringMap(endpoint, "authorization", "credentials")
			if ref["name"] != "metrics-auth" || ref["key"] != "bearer-token" {
				t.Fatal("scrape credential must be a Secret reference")
			}
			if endpoint["followRedirects"] != false || endpoint["honorLabels"] != false {
				t.Fatal("unsafe collection flags")
			}
		case "PrometheusRule":
			rules++
		case "Deployment":
			containers, _, _ := unstructured.NestedSlice(obj.Object, "spec", "template", "spec", "containers")
			for _, raw := range containers {
				env, _, _ := unstructured.NestedSlice(raw.(map[string]interface{}), "env")
				for _, e := range env {
					item := e.(map[string]interface{})
					if item["name"] == "METRICS_SCRAPE_TOKEN" {
						tokenRefs++
						if _, inline := item["value"]; inline {
							t.Fatal("inline scrape secret")
						}
					}
				}
			}
		}
	}
	if monitors != 2 || rules != 1 || tokenRefs != 2 {
		t.Fatalf("monitors=%d rules=%d tokenRefs=%d", monitors, rules, tokenRefs)
	}
	for _, invalid := range []string{"monitoring.platform.tokenSecret=", "monitoring.clusterId=bad/name", "monitoring.platform.enabled=false"} {
		if _, err := exec.Command(helm, append(append([]string{}, args...), "--set", invalid)...).CombinedOutput(); err == nil {
			t.Fatalf("accepted %s", invalid)
		}
	}
}
