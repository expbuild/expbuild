# expbuild management API

New PostgreSQL-backed API for the Kubernetes platform. This replaces, rather
than imports, the previous backend's authentication and project ownership logic.

Implemented: versioned/checksummed migrations, explicit administrator bootstrap,
password hashing, server-side sessions with hashed tokens, Origin/CSRF checks,
user creation/activation, project creation/listing, project membership roles,
scoped audit queries, and safeguards against removing the final administrator.

Project creation queues namespace initialization. Instance creation, full configuration
updates and deletion queue asynchronous Kubernetes operations. Workers use PostgreSQL
leases, idempotency keys and Kubernetes UID/generation checks. The Kubernetes-backed
provisioning path is implemented; full engine startup remains a real-cluster delivery gate.

If project initialization fails, a project/platform administrator can POST
`/v1/projects/:projectId/retry` with an `Idempotency-Key`. The new operation reuses
the original namespace and identity. Duplicate requests return the same operation;
another retry is rejected while initialization is pending or already ready.
Fix the reported cluster/storage/ownership issue before retrying; retries never
adopt a namespace owned by another project. Each attempt is audited.

## Run

Use Node 22+ and PostgreSQL. Set the variables shown in `.env.example` in the
process environment; this service does not silently load arbitrary env files.

```sh
npm ci
npm run migrate --workspace @expbuild/admin-api
# Set ADMIN_EMAIL and ADMIN_PASSWORD through the deployment's secret mechanism.
npm run bootstrap --workspace @expbuild/admin-api
npm run dev --workspace @expbuild/admin-api
```

Run commands from the repository root. Migrations run explicitly, not on every
API startup. Bootstrap never overwrites an existing user. Use a separate database
migration identity with schema permissions in production.

Runtime also requires `STORAGE_CLASS` and `OPERATION_ENCRYPTION_KEY` (32 random
bytes encoded as 64 hexadecimal characters). Back up this key securely with the
database and share it across API/worker replicas; changing it while operations are
pending makes their encrypted credentials unreadable. Kubernetes authentication
uses the active kubeconfig or in-cluster ServiceAccount. Migration/bootstrap do
not require Kubernetes access. Never put real credentials in source control.

Instance mutations require an `Idempotency-Key` of 8–128 letters, numbers or
`._:-`. PATCH additionally requires the instance GET response's `ETag` in
`If-Match`; the token combines Kubernetes UID and spec generation. Responses
contain an operation ID for polling. Status-only updates do not invalidate that
token. Creation returns connection credentials once to an administrator; retries
do not return the password.

Administrators can POST `/v1/projects/:projectId/instances/:instanceId/credentials/rotate`
with `Idempotency-Key` and `If-Match` to rotate cache credentials. The response
returns the new password once. The worker creates a new immutable Secret, switches
the CR to it and waits for the Operator to observe the new configuration. Running
instances require authenticated readiness; suspended instances require Pods to stop
and use the new credentials on their next start. Only older Secret revisions are
cleaned up, so an expired worker cannot delete a later rotation's credentials.

Rotation rolls the workload and may briefly interrupt connections. Follow the
operation until it finishes before updating dependent clients. Failed operations
do not roll credentials back automatically: a request may already have reached
Kubernetes. If the first password response was lost, wait for that operation to
finish, then submit a new rotation. Normal config edits preserve the active Secret.

Browser access should use a same-origin reverse proxy (or development proxy).
`APP_ORIGIN` is that browser origin. All mutating requests require that Origin;
authenticated writes additionally require the `x-csrf-token` returned by login.
The session cookie is HttpOnly and SameSite=Strict, Secure except for explicit
localhost development origins. Keep CSRF tokens out of logs and URLs.

POST `/v1/auth/password` accepts `currentPassword` and a new `password` of
12–1024 characters. It verifies the old password, revokes all sessions and clears
the current cookie. Platform administrators may POST a new `password` to
`/v1/users/:userId/password` for another account, revoking that account's sessions.
Both routes require Origin and CSRF; password values never enter audit details.
Login rechecks the password hash under the same mutation lock before issuing a
session, preventing concurrent resets from issuing sessions with the old password.

## Verification

```sh
npm run build
npm test
# Isolated test databases are created and dropped; use a dedicated test server.
TEST_DATABASE_URL=postgresql://... npm test --workspace @expbuild/admin-api
```

Without TEST_DATABASE_URL, database integration tests explicitly skip. They are
not replaced by an in-memory imitation of PostgreSQL. Database tests cover session
revocation, CSRF, cross-project isolation, member privilege escalation and the
last project administrator invariant.
Queue tests use real PostgreSQL with a simulated Kubernetes port to exercise
lost create responses, stale worker leases, concurrent updates and Retain deletion.
SDK tests use a local HTTP server to verify wire serialization, timeout and
configuration conflict handling; they do not establish real Kubernetes compatibility.

Deployment-wide login rate limiting, email-based recovery,
session cleanup, metrics and full cluster/UI integration
remain required before the full platform can be delivered.

## API contract

Authenticated users can read `/v1/openapi.json`. Export the same contract with
`npm run --silent openapi --workspace @expbuild/admin-api`.
See the [integration guide](../../docs/k8s-platform/api-integration.md) and
[OpenAPI JSON](../../docs/k8s-platform/openapi.json). Tests validate OpenAPI 3.1,
route coverage and session protection. Kubernetes spec/status remain open objects
whose precise shape is defined by the CacheInstance CRD.

## Instance statistics

GET `/v1/projects/:projectId/instances/:instanceId/statistics` requires project
membership and checks the bound Kubernetes UID before collection. It reads the
owned authentication Secret and calls the fixed cluster Service `/status` with
probe credentials, a five-second timeout, a 64 KiB response limit and redirects
forbidden. Suspended/deleting instances are unavailable; upstream errors return
503 without exposing credentials or converting failure into zero usage.

Fields follow the [bazel-remote status implementation](https://github.com/buchgr/bazel-remote/blob/master/server/http.go):
cache bytes, configured capacity, item count and optional reservation/uncompressed
sizes. Missing optional fields are null. This is a current engine snapshot, not
PVC filesystem usage or a time-series store. Hit rates and history remain pending.
