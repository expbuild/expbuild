package controller

import (
	"context"
	"os"
	"reflect"
	"testing"

	cachev1 "github.com/expbuild/expbuild/operator/api/v1alpha1"
	apiextensions "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	crdvalidation "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/validation"
	"k8s.io/apiextensions-apiserver/pkg/apiserver/schema"
	"k8s.io/apiextensions-apiserver/pkg/apiserver/schema/cel"
	objectvalidation "k8s.io/apiextensions-apiserver/pkg/apiserver/validation"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/yaml"
)

// Real Kubernetes CEL evaluation, without pretending that fake.Client performs
// admission. The separate envtest suite still exercises real API subresources.
func TestImageBindingCELTrustBoundary(t *testing.T) {
	raw, err := os.ReadFile("../../config/crd/cache.expbuild.io_cacheinstances.yaml")
	if err != nil {
		t.Fatal(err)
	}
	chart, err := os.ReadFile("../../../deploy/charts/expbuild/crds/cache.expbuild.io_cacheinstances.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != string(chart) {
		t.Fatal("Helm and operator CRDs differ")
	}
	var crd apiextensionsv1.CustomResourceDefinition
	if err := yaml.Unmarshal(raw, &crd); err != nil {
		t.Fatal(err)
	}
	// Exercise the same CRD admission validation, including static CEL cost,
	// that kube-apiserver runs when installing this CRD.
	apiextensionsv1.SetDefaults_CustomResourceDefinition(&crd)
	var definition apiextensions.CustomResourceDefinition
	if err := apiextensionsv1.Convert_v1_CustomResourceDefinition_To_apiextensions_CustomResourceDefinition(&crd, &definition, nil); err != nil {
		t.Fatal(err)
	}
	if errs := crdvalidation.ValidateCustomResourceDefinition(context.Background(), &definition); len(errs) != 0 {
		t.Fatalf("CRD admission: %v", errs)
	}
	var internal apiextensions.JSONSchemaProps
	if err := apiextensionsv1.Convert_v1_JSONSchemaProps_To_apiextensions_JSONSchemaProps(crd.Spec.Versions[0].Schema.OpenAPIV3Schema, &internal, nil); err != nil {
		t.Fatal(err)
	}
	structural, err := schema.NewStructural(&internal)
	if err != nil {
		t.Fatal(err)
	}
	validator := cel.NewValidator(structural, true, 10_000_000)
	if validator == nil {
		t.Fatal("CEL validator missing")
	}
	r, c := setup(t)
	c.Spec.ImageBindingMode = ""
	object := func(c *cachev1.CacheInstance) map[string]interface{} {
		out, err := runtime.DefaultUnstructuredConverter.ToUnstructured(c)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}

	approved := c.DeepCopy()
	approved.Status.ImageBinding = &cachev1.ImageBinding{Format: "v1", InstanceUID: string(c.UID), TemplateRef: c.Spec.TemplateRef, Images: imageDigests(map[string]string{"cache": r.Image})}
	objectValidator, _, err := objectvalidation.NewSchemaValidator(&internal)
	if err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []string{"valid", "mutable image", "no images", "extra images", "unknown format", "unknown template"} {
		t.Run("object schema/"+mutation, func(t *testing.T) {
			value := approved.DeepCopy()
			switch mutation {
			case "mutable image":
				value.Status.ImageBinding.Images["cache"] = "cache:latest"
			case "no images":
				value.Status.ImageBinding.Images = map[string]cachev1.ImageDigest{}
			case "extra images":
				value.Status.ImageBinding.Images["one"] = cachev1.ImageDigest(r.Image)
				value.Status.ImageBinding.Images["two"] = cachev1.ImageDigest(r.Image)
			case "unknown format":
				value.Status.ImageBinding.Format = "v99"
			case "unknown template":
				value.Status.ImageBinding.TemplateRef.Name = "unknown"
			}
			errs := objectvalidation.ValidateCustomResource(field.NewPath("root"), object(value), objectValidator)
			if (len(errs) == 0) != (mutation == "valid") {
				t.Fatalf("unexpected schema acceptance: %v", errs)
			}
		})
	}
	validate := func(name string, old, next map[string]interface{}, want bool) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			errs, _ := validator.Validate(context.Background(), field.NewPath("root"), structural, next, old, 10_000_000)
			if (len(errs) == 0) != want {
				t.Fatalf("accepted=%v want=%v: %v", len(errs) == 0, want, errs)
			}
		})
	}
	validate("legacy creation", nil, object(c), true)
	validate("first binding", object(c), object(approved), true)
	validate("unchanged binding", object(approved), object(approved), true)
	changed := approved.DeepCopy()
	changed.Status.ImageBinding.Images["cache"] = cachev1.ImageDigest(newImage)
	validate("replace approved digest", object(approved), object(changed), false)
	changed = approved.DeepCopy()
	changed.Status.ImageBinding = nil
	validate("remove binding", object(approved), object(changed), false)
	removedStatus := object(approved)
	delete(removedStatus, "status")
	validate("remove entire status", object(approved), removedStatus, false)
	changed = c.DeepCopy()
	changed.Spec.ImageBindingMode = ImageBindingMode
	validate("legacy cannot opt in after creation", object(c), object(changed), false)
	validate("new creation can opt in", nil, object(changed), true)
	validate("new mode cannot be removed", object(changed), object(c), false)
	changed = approved.DeepCopy()
	changed.Spec.DesiredState = "Suspended"
	changed.Status.CredentialRevision = "rotation"
	validate("lifecycle and observation stay mutable", object(approved), object(changed), true)
	if reflect.DeepEqual(approved.Status.ImageBinding, c.Status.ImageBinding) {
		t.Fatal("binding fixture missing")
	}
}
