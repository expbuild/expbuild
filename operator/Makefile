GO ?= go

.PHONY: test check render generate build
test:
	$(GO) test ./...

check:
	$(GO) vet ./...
	test -z "$$($(GO) fmt ./...)"

render:
	$(GO) run ./cmd/render -f examples/bazel-remote.yaml

generate:
	controller-gen object paths=./api/... crd output:crd:artifacts:config=config/crd
	cp config/crd/cache.expbuild.io_cacheinstances.yaml ../deploy/charts/expbuild/crds/

build:
	$(GO) build -o bin/expbuild-operator ./cmd/operator
