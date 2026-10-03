# Development and testing

[Back to the homepage](../README.md) · [中文首页](../README.zh-CN.md)

## Local development

Use Node.js 22+ and npm for the API and console, and Go 1.23+ for the Operator. CI currently uses Node.js 24, Go 1.27.1, and PostgreSQL 18; see the [workflows](../.github/workflows) for exact test tooling.

From the repository root, install dependencies and build the API and console:

```sh
npm ci
npm run build
```

To run the application, prepare a development PostgreSQL database and a dedicated Kubernetes development cluster with the CRD, Operator, storage, and access configuration installed. The API uses the active kubeconfig or its in-cluster identity, and its workers execute instance operations against that cluster.

Set the API process environment using [.env.example](../apps/admin-api/.env.example) as a reference. The service does not automatically load an `.env` file.

| Variable                        | Local configuration                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                  | Connection string for your development PostgreSQL database                                                   |
| `APP_ORIGIN`                    | `http://localhost:5173`                                                                                      |
| `STORAGE_CLASS`                 | An available StorageClass in the development cluster                                                         |
| `OPERATION_ENCRYPTION_KEY`      | A generated 32-byte key encoded as 64 hexadecimal characters; keep it stable across API restarts             |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Credentials for the initial administrator; required for bootstrap, with a password of at least 12 characters |

With those variables set, run migrations, bootstrap the administrator once, and start the API:

```sh
npm run migrate --workspace @expbuild/admin-api
npm run bootstrap --workspace @expbuild/admin-api
npm run dev --workspace @expbuild/admin-api
```

In a second terminal, start the console:

```sh
npm run dev --workspace @expbuild/admin-web
```

Open `http://localhost:5173`. Vite forwards `/v1` to the API at `127.0.0.1:3001`. See the [API guide](../apps/admin-api/README.md), [console guide](../apps/admin-web/README.md), and [Operator guide](../operator/README.md) for component configuration. Building and running unit tests does not require a full cluster; creating usable cache instances does.

## Testing

Run the API and console tests from the repository root:

```sh
npm test
```

Database integration tests require `TEST_DATABASE_URL` pointing to a dedicated test server, with permission to create and drop temporary test databases. Without it, those tests explicitly skip.

Run the Go checks and build the Operator:

```sh
cd operator
go test ./...
go vet ./...
make build
```

Additional suites cover a real Kubernetes API server/etcd (`KUBEBUILDER_ASSETS`), chart rendering (`HELM_BIN`), actual cache engines, monitoring backends, Playwright browser flows, and disposable kind clusters. Browser tests run with `npm run test:browser` after building and installing Chromium, and also require `TEST_DATABASE_URL`.

See [testing and reproduction](k8s-platform/testing.md) and [observability validation](k8s-platform/observability.md). API-server tests do not run a complete cluster, browser tests use a Kubernetes test adapter, and isolated cluster results do not establish production storage or scale guarantees.

## Repository layout

| Path                     | Purpose                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `apps/admin-api`         | TypeScript management API, PostgreSQL migrations, authorization, workers, and observation queries |
| `apps/admin-web`         | React/TypeScript console and English/Chinese translations                                         |
| `operator`               | Go Operator, CacheInstance API, engine adapters, and Gradle cache service                         |
| `deploy/charts/expbuild` | Helm chart, CRDs, RBAC, and deployment configuration                                              |
| `images`                 | Container build definitions                                                                       |
| `tests`                  | Browser acceptance tests and shared contracts                                                     |
| `tools`                  | Engine validation, container checks, and disposable cluster test tooling                          |
| `docs/k8s-platform`      | Current architecture, implementation, operations, and validation records                          |

