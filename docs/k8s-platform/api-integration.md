# Management API integration

The [OpenAPI 3.1 JSON](openapi.json) describes the current implementation. Authenticated clients can also read
`GET /v1/openapi.json`. The documentation endpoint requires a session; downloaded static documentation contains no instance passwords or user data.

## Sessions and request protection

1. POST `/v1/auth/login` with an email and password, and an Origin that exactly matches the deployment's
   `APP_ORIGIN`. Save the returned `expbuild_session` cookie and `csrfToken`.
2. Include the cookie in subsequent requests; write requests also require Origin and `x-csrf-token`. Do not put passwords, cookies,
   or CSRF tokens in URLs, logs, or project configuration files.
3. GET `/v1/auth/me` checks the session. A 401 requires login again; changing/resetting a password revokes all associated sessions.
4. Machine accounts/API Tokens/OIDC integration are not currently available. When automated clients use the existing session mechanism,
   accounts should be managed by the enterprise credential system. Future independent credentials must not be improvised from browser cookies.

## Asynchronous instance operations

- Wait for project initialization to reach ready before creating instances; an administrator can call project retry after initialization failure.
- Instance creation, update, deletion, and cache credential rotation return 202 and operation.id.
- Retries of the same request use the same `Idempotency-Key` and identical input; changed input requires a new key.
  Only one active operation is accepted per instance at a time.
- Before updating an instance or rotating credentials, read the instance, save its ETag, and pass it in `If-Match`. On 409, read
  the new state and reconsider the operation rather than automatically overwriting it. PATCH currently requires the complete configuration object, not JSON Patch.
- Poll the project operation details until succeeded, failed, or superseded. An operation still in reconciling
  has not necessarily failed. Failure may occur after Kubernetes has accepted configuration; automatic rollback is not promised.
- Project creation does not yet support client idempotency keys. If the create response is uncertain, query the project list before retrying blindly.

Connection passwords are returned only when a create/rotation request is first successfully accepted, and only to administrators. Idempotent replay does not
return the password again. If the password response is lost, wait for the operation to finish and have an administrator rotate it. Credentials never appear in operation
queries, audit records, statistics, or API documentation responses.

## State and statistics

The database instance lifecycle and the engine's Ready condition are different concepts. When reading details, consider
revision, spec, status, and observedAt together. Statistics are current engine snapshots; absence or collection failure
returns an error, which clients must not display as zero hits/usage. Historical trends and hit rates are not yet available.

Lists currently have fixed limits: at most 200 users/projects/instances and 100 operations/audit records, with no pagination parameters.
Project membership lists have no fixed pagination. Ordinary accounts can access only their projects; platform administrators can access across projects.
Inaccessible projects consistently return 404 to prevent enumeration of other teams' resources.

## Maintenance contracts

When resource reconciliation finds insufficient or unknown reservations, a platform administrator can call the single-instance `POST /v1/projects/{projectId}/instances/{instanceId}/reservations/reconcile` endpoint. It rereads the cluster and rechecks ownership and concurrent changes, increasing reservations only on success. If actual resources already exceed project quotas, quota queries show the excess and subsequent creation/expansion is rejected. Other reconciliation discrepancies require separate handling; this endpoint cannot repair UID or configuration conflicts.

Retained-volume reclaim uses the PVC UID from `GET .../retained-volume` as `If-Match`, submitting a complete instance configuration and idempotency key to `POST .../retained-volume/reclaim`. New credentials are visible only in the first response; after completion, the old volume remains the same PVC and the instance binding points to the new CR UID. See [retained-volume reclaim](retained-volume-reclaim.md) for identity transfer, failure recovery, and limitations.

The source is `apps/admin-api/src/openapi.ts`. Instance input schemas are exported from the actual Zod validation models;
cross-field constraints remain governed by descriptions and server-side validation. After modifying routes, run tests and regenerate the static JSON:

```sh
npm run --silent openapi --workspace @expbuild/admin-api > docs/k8s-platform/openapi.json
npm test --workspace @expbuild/admin-api
```

Tests check specification compliance, coverage of existing routes, path parameters, references, input defaults, and access control.
Kubernetes spec/status are still described as open objects; exact fields are defined by the version-controlled CacheInstance CRD.
This documentation therefore does not imply that an automatically generated SDK has passed real-cluster acceptance.

## Resuming instance operations that timed out waiting for readiness

Project administrators can call `POST /v1/projects/{projectId}/operations/{operationId}/retry`
with a session, Origin, CSRF, and a new `Idempotency-Key`. Failed create/update/rotate operations already bound to a target Kubernetes generation resume readiness checks for the original operation,
without recreating resources, resending configuration, or regenerating passwords; the response is 202 with the original operation ID.

Calling again with the same idempotency key returns only the current operation state; it does not restart the operation even if it failed again.
Another deliberate retry requires a new key. The endpoint returns 409 if the instance has a subsequent operation, is deleted, or an update/rotation lacks a UID and target version.
An instance being deleted can resume only its original deletion operation. The worker still checks the original UID, generation, and operation identifier, refusing to continue if the resource has been replaced.
Retry resets the 20-minute waiting deadline; the previous error is retained in the `operation.retry` audit event.

Failed deletions can also resume cleanup through this endpoint without a target generation, but the instance must still be
in deletion and its bound UID must match the original request. The original operation ID, UID, and captured deletion policy are reused; if the resource is
replaced with one of the same name or its storage deletion policy changes, the worker refuses to continue. Recovery remains possible if the CR is gone but credential cleanup is incomplete.
The UI uses “Continue deletion” and “Confirm continue deletion” and explicitly states that this does not undo deletion.

When a create response was lost and no UID was bound, the original create operation can be resumed. The worker only reads the existing CR,
checks the original operation identifier, request hash, project/instance labels, and complete spec, then binds the UID/target version.
Missing or deleting resources and configuration/identity mismatches fail; resources are not recreated, and cleared credential ciphertext is not restored.

This does not currently cover recreation after complete resource loss, orphan Secret cleanup, or repair of invalid credentials, and it does not automatically roll back configuration.
These cases still require dedicated recovery workflows. The management UI's recent-operations list offers administrators a “Resume checks” action,
with appropriate recovery entries for failed creates, failed updates/credential rotations bound to target versions, and failed deletions. The server still checks subsequent operations and instance state.

## Retained-volume queries and cleanup

Find retained-storage records using `lifecycle=detached` in the instance list, then call `GET /v1/projects/{projectId}/instances/{instanceId}/retained-volume` to read the actual PVC. Project members can read it; absence returns 404, ownership conflicts 409, and Kubernetes observation failures 503. Capacity is requested capacity, not actual disk usage.

Administrators call `DELETE` on the same path with `Idempotency-Key` and `If-Match`. Here, `If-Match` uses the **PVC UID** returned by the query, not the instance's `UID:generation`. The 202 response returns a `volume.delete` operation to poll through the normal operation API. Idempotent replay preserves the original operation result; after failure, recheck the volume and explicitly resubmit with a new key. Do not change idempotency keys merely because a response was lost.

The executor verifies that the instance is detached and its original CR UID and project ownership are unchanged. Before actual deletion, it checks that no CR with the same name exists and no Pod references the volume, and uses PVC UID/resourceVersion deletion preconditions. Completion means the PVC no longer exists and the instance record becomes deleted, not that underlying disk data has been erased. There is no retained-volume reclaim endpoint.

## Eviction policies and applied state

The template catalog's `capabilities.policyApplyMode` is `restart` (bazel-remote) or `unsupported` (WebDAV), and `policyCondition` points to the instance's `PolicyApplied` condition. bazel-remote uses fixed native LRU; `cacheGiB` configures the cache budget, and changes take effect through workload restart. TTL is not currently supported. WebDAV PVC capacity is not an automatic eviction threshold, and files are not automatically cleaned up as capacity is approached.

`PolicyApplied=True` is published only after the current workload revision, authenticated protocol, and actual cache budget returned by the engine have been verified. Clients must compare the condition's `observedGeneration` with the generation in the instance `revision`; an old True must not be treated as evidence that a new configuration has taken effect. It is Unknown while paused, not ready, or failing probes; WebDAV reports Unknown/NotSupported. Gateway mode also requires route readiness before True is published, so it may conservatively remain Unknown while ingress is not ready.

This condition confirms that the current running instance has applied the configuration; it does not guarantee eviction performance, full-disk protection, or usage of the entire PVC.
