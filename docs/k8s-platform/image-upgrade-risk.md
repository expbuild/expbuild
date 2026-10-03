# Instance image bindings and initial trust migration

Baseline `7c7e461f95ef48dd1baf6b13c8cf96423e5a827f` has an implicit image-upgrade path:
`templates.Resolve` reads installation-level images by engine name, and reconciliation overwrites existing StatefulSet pod templates.
Changing only the installation digest, without changing the CR spec, generation, or templateRef, also rewrites existing workloads.
The WebDAV 0.2 statistics image is additionally coupled to the Operator image. Six fake-client reproduction scenarios demonstrate
that the template changes; this is not equated with an actual rollout, service interruption, or data corruption.

This implementation chooses **A: persistent image bindings**. templateRef continues to declare the compiled-in capability contract;
the same template can bind different administrator-approved builds. It does not add user-selected images, a dynamic SDK, or an upgrade operation.

## Trust and behavior

- New CRs explicitly carry `spec.imageBindingMode: PinnedV1`, with no CRD default; it cannot be added, removed, or changed after creation.
  API creation and example manifests include this marker; updates preserve the original marker or its absence, remaining compatible with updates in old queues.
  CRs without the marker are legacy instances; generation 1 does not prove that an instance is new.
- The Operator first writes `status.imageBinding` with optimistic concurrency and rereads it; runtime resources are created only after persistence is confirmed.
  The record includes its format, CR UID, exact templateRef, and complete set of container digests. CRD CEL prohibits rewriting or deleting the record,
  including clearing all of status. If an old CRD prunes this field, reconciliation blocks with `ImageBindingPersistenceRequired`.
- Legacy instances are automatically adopted only when the complete image sets of both the StatefulSet and existing Pods strictly match the current administrator-approved values.
  Checks cover namespace, project and instance labels, and controller kind/name/API version/UID; actual Pod specs are inspected,
  rejecting extra sidecars, init/ephemeral containers, other volume users, and leftover Pods from an old StatefulSet UID.
  Failed conditions update only status/Warning events; they do not proactively stop or delete running resources.
- Missing legacy workloads report `LegacyWorkloadMissing`; an unbound CR with the new marker that already has a PVC reports
  `ImageRecoveryRequired`. Neither guesses historical images from current defaults.
- Rendering, restarts, and recovery after StatefulSet loss for bound instances use the persisted record, even if installation defaults change or are disabled.
  Template or Pod image drift blocks reconciliation; images are checked again at the StatefulSet optimistic-write boundary, refusing to overwrite concurrent changes.
  Reading multiple Kubernetes objects is not an atomic transaction: this check does not replace cluster permissions restricting direct writes to Pods/StatefulSets.
- WebDAV 0.2 binds both `cache` and `statistics`; other existing templates bind `cache`.
  Helm's `images.webdavStats` / the Operator's `--webdav-stats-image` is a separate digest that must be approved.
  Upgrading the controller image no longer implicitly replaces statistics. The chart requires this value when WebDAV is enabled.
- Configuration changes, resource changes, and credential rotation continue to work while preserving image bindings. Explicit pause scales only the precisely owned StatefulSet to 0,
  without rewriting its pod template; stopping remains possible even if a legacy instance cannot migrate or credentials are lost. The deletion path runs before binding checks.

`status.imageBinding` is a trust record, not an ordinary observation cache that can be freely cleared and rebuilt.
Under existing RBAC, only the Operator can write status; the API cannot modify status, PVC metadata, or ConfigMaps.
No RBAC permissions are added. Protection depends on the CRD and a trusted control plane; it cannot resist a cluster administrator removing CEL, broadening permissions, or tampering with backups.
Checking digests in Pod specs is also not proof of runtime bytes; real acceptance must still record kubelet imageID and image platform digests.

## Retain and recovery

Retain deletion saves an ownerless, immutable ConfigMap after stopping instance Pods. It contains the complete binding,
namespace/project/instance, original CR UID, and PVC UID; a PVC annotation also pins the record's name and UID.
This keeps the record independent of garbage collection for the original CR. Recovery must pass both the existing volume-transfer authorization and image-record validation.
Missing records, same-name replacements, identity mismatches, or unknown templates never fall back to current default images.

Unbound instances or instances with template drift can still complete explicit Retain deletion, but no trusted recovery record is produced;
automatic reclaim is subsequently rejected until an administrator verifies the data and historical images. Unknown state must not be “repaired” into current defaults.
Delete semantics continue to follow the original explicit volume-deletion policy. Retained image records are not automatically garbage-collected: an administrator
cleans them up after confirming that the corresponding PVC and backup-recovery needs no longer exist. The API cannot delete these trust records.

## Validation

```sh
cd operator
HELM_BIN=/path/to/helm go test ./... -count=1
make check build
go test -race ./...
```

Regression coverage includes old instances retaining A while new instances use B across six engine/historical-version/sidecar scenarios;
binding conflicts, pruning by old CRDs, restart, deletion and recreation, running-Pod drift and identity, strict legacy adoption,
credential and resource changes, pause/deletion, Retain recovery, and rejection of tampering.
Tests that previously asserted implicit upgrades now assert safe behavior instead.

CRD tests invoke full CRD admission validation from Kubernetes v0.32.1 (including static CEL cost),
JSON schema object validation, and real CEL evaluation; fake clients do not perform admission.
envtest separately covers actual `/status` immutability, creation markers, and deployment RBAC.
All local Go, race, vet/fmt/build, Helm 3.17.3 lint/rendering, and API/Web build and regression checks passed.
Three API monitoring-backend tests and six Go external-environment tests explicitly skipped; offline admission was not represented as a real API server.

## Release and recovery acceptance sequence

1. In an isolated environment, back up the database, keys, complete CR objects (including status), PVC metadata, and recovery records.
   Freeze instance creation/modification and stop reconciliation by the old Operator; retain original engine digests and determine a separately approved WebDAV stats digest.
   If legacy instances still use mutable tags, do not infer historical images from the tag's current target; separate manual verification is required.
2. Have an authorized administrator apply the new CRD before updating the Operator/API/chart. Helm does not automatically upgrade objects in `crds/`.
   Old queued create operations without the creation marker block safely; drain them before switching or resubmit through an administrator procedure.
   Verify `ImagesBound=True`, the persisted record, and the actual StatefulSet/Pods for each instance. Do not change defaults to conceal a failed migration.
3. On disposable kind, use two real approved digests A/B: write fixture data → adopt A → change defaults to B →
   old instance remains A, new instance uses B → rotate credentials → delete and recreate workload → Retain deletion and reclaim → verify data and native clients.
   Record imageID, revision, Pod UID, service readiness time, and data hashes. The existing lifecycle script constructs a local digest reference from the
   Operator image already loaded into kind for stats; it does not publish images.
4. Rollback must continue to run an Operator that understands and honors bindings. Older Operators ignore this record, so do not directly
   `helm rollback` to the baseline release; stop reconciliation and review the recovery plan first. No general upgrade workflow bypassing immutable bindings is provided.

The minimum missing requirements for a real local API server are the official controller-runtime `setup-envtest`
`v0.0.0-20250517180713-32e5e9e948a5` and its Kubernetes **1.32.0 darwin/arm64** assets
(kube-apiserver, etcd, kubectl), requiring download/execution in the task directory and permission to bind temporary local ports.
Disposable kind lifecycle testing additionally needs pinned **kubectl v1.32.2 darwin/arm64**; kind v0.27.0, Helm v3.17.3,
and existing local images can be reused. These tools were not installed without authorization. Repository CI already provides the corresponding Linux test paths.
Production CSI, backup recovery, approved A/B images, and real pilots remain subsequent requirements; this change does not claim completed production-upgrade qualification.
