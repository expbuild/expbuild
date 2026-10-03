import { z } from "zod";
import { quotaInput } from "./quotas.js";
import { instanceInput } from "./instance-contract.js";

type Schema = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const string: Schema = { type: "string" },
  uuid: Schema = { type: "string", format: "uuid" },
  bool: Schema = { type: "boolean" };
const object = (
  properties: Record<string, Schema>,
  required = Object.keys(properties),
  strict = false,
): Schema => ({
  type: "object",
  properties,
  required,
  ...(strict ? { additionalProperties: false } : {}),
});
const list = (item: Schema) =>
  object({ items: { type: "array", items: item } });
const nullable = (schema: Schema): Schema => ({
  anyOf: [schema, { type: "null" }],
});
const password: Schema = {
  type: "string",
  minLength: 12,
  maxLength: 1024,
  writeOnly: true,
};
const email: Schema = { type: "string", format: "email", maxLength: 254 };
const role: Schema = {
  type: "string",
  enum: ["admin", "maintainer", "viewer"],
};
const ok = object({ ok: { const: true } });
const user = object({ id: uuid, email, platform_admin: bool });
const operation = object({
  id: uuid,
  project_id: uuid,
  instance_id: nullable(uuid),
  kind: string,
  state: {
    type: "string",
    enum: [
      "pending",
      "applying",
      "reconciling",
      "succeeded",
      "failed",
      "superseded",
    ],
  },
  target_generation: nullable({ type: ["string", "integer"] }),
  error_code: nullable(string),
  created_at: { type: "string", format: "date-time" },
  updated_at: { type: "string", format: "date-time" },
});
const accepted = object(
  {
    operation: ref("Operation"),
    replayed: bool,
    credentials: object({
      username: string,
      password: {
        type: "string",
        description:
          "Returned once, never on an idempotent replay. Store securely.",
      },
    }),
  },
  ["operation"],
);
const instanceSchema = z.toJSONSchema(instanceInput, { io: "input" });
delete instanceSchema.$schema;
const schemas: Record<string, Schema> = {
  InventoryResult: object({
    state:{type:'string',enum:['Healthy','Drift','InProgress','Unavailable']},
    issues:{type:'array',maxItems:200,items:object({code:string,kind:{type:'string',enum:['CacheInstance','PersistentVolumeClaim']},resourceName:string,instanceId:nullable(uuid)})},
    issueCount:{type:'integer',minimum:0},truncated:bool,busyInstances:{type:'integer',minimum:0},
    counts:nullable(object({instances:{type:'integer',minimum:0},volumes:{type:'integer',minimum:0}})),error:string,
  },['state','issues','issueCount','truncated','busyInstances','counts']),
  QuotaLimits: z.toJSONSchema(quotaInput),
  QuotaSnapshot: object({ limits: ref('QuotaLimits'), revision: string,
    reserved: object(Object.fromEntries(['instances','storageGiB','cpuMillis','memoryMiB'].map(key => [key, {type: 'integer', minimum: 0}]))),
    unknownReservations: {type: 'integer', minimum: 0},
    synchronization: object({state:{type:'string',enum:['Pending','Applied','Failed']}, observedRevision:nullable(string), checkedAt:nullable({type:'string',format:'date-time'}), error:nullable(string)}) }),
  Error: object(
    {
      error: string,
      issues: {
        type: "array",
        items: object({
          path: { type: "array", items: { type: ["string", "integer"] } },
          message: string,
        }),
      },
    },
    ["error"],
  ),
  User: user,
  Operation: operation,
  Accepted: accepted,
  InstanceInput: {
    ...instanceSchema,
    description:
      "Full configuration, including for PATCH. exposure defaults to ClusterInternal; Gateway requires administrator-enabled shared HTTPS Gateway configuration. External endpoints appear only after backend and route readiness; ExternalReachability=Unknown means external DNS/TLS/client access has not been verified. For bazel-remote, gradle-http and experimental nx-http, cacheGiB must be positive and strictly less than storageGiB. For webdav-apache, cacheGiB must be zero; automatic eviction is unsupported. Storage shrinking and template changes are forbidden. Optional templates require the deployment to enable their trusted images.",
  },
  Project: object(
    {
      id: uuid,
      name: string,
      namespace: string,
      state: {
        type: "string",
        enum: ["pending", "ready", "failed", "deleting"],
      },
      role,
    },
    ["id", "name", "namespace", "state"],
  ),
  InstanceSummary: object({
    id: uuid,
    template_name: string,
    display_name: string,
    lifecycle: {
      type: "string",
      enum: ["pending", "active", "deleting", "deleted", "detached", "failed"],
    },
    resource_name: string,
    created_at: { type: "string", format: "date-time" },
  }),
  InstanceCapabilities: object({
    capacity: bool, statistics: bool, lookupHistory: bool, lru: bool, ttl: bool,
    replicas: { type: "integer", minimum: 1 },
    policyApplyMode: { type: "string", enum: ["restart", "unsupported"] },
    policyCondition: string,
  }),
  ClientProfile: object({
    id: string, protocol: string, version: string,
    status: { type: "string", enum: ["experimental"] },
  }),
  InstanceDetail: object({
    clientProfiles: { type: "array", items: ref("ClientProfile") },
    templateVersion: nullable(string),
    capabilities: nullable(ref("InstanceCapabilities")),
    template: {type: "string", enum: ["bazel-remote", "webdav-apache", "gradle-http", "nx-http"]},
    id: uuid,
    name: string,
    lifecycle: string,
    revision: nullable(string),
    spec: nullable({
      type: "object",
      description: "Desired CacheInstance spec; excludes credential contents.",
    }),
    status: nullable({
      type: "object",
      description:
        "Observed Kubernetes conditions, endpoints and applied revisions. May lag spec.",
    }),
    observedAt: { type: "string", format: "date-time" },
  }),
  Statistics: object({
    source: { type: "string", enum: ["bazel-remote-status", "webdav-content-scan", "gradle-http-status"] },
    observedAt: { type: "string", format: "date-time" },
    usedBytes: { type: "integer", minimum: 0 },
    capacityBytes: { type: "integer", minimum: 1 },
    itemCount: { type: "integer", minimum: 0 },
    reservedBytes: nullable({ type: "integer", minimum: 0 }),
    uncompressedBytes: nullable({ type: "integer", minimum: 0 }),
    requestCounts: { type: "object", properties: {
      getHits: { type: "integer", minimum: 0 }, getMisses: { type: "integer", minimum: 0 },
      putSuccess: { type: "integer", minimum: 0 }, putRejected: { type: "integer", minimum: 0 },
    }, required: ["getHits", "getMisses", "putSuccess", "putRejected"] },
  }, ["source", "observedAt", "usedBytes", "capacityBytes", "itemCount", "reservedBytes", "uncompressedBytes"]),
};

type Options = {
  body?: Schema;
  response?: Schema;
  code?: number;
  public?: boolean;
  idempotent?: boolean;
  revision?: boolean;
  revisionDescription?: string;
  description?: string;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>[];
  bearer?: boolean;
  contentType?: string;
};
const paths: Record<string, Record<string, unknown>> = {};
function route(
  method: string,
  path: string,
  id: string,
  summary: string,
  options: Options = {},
) {
  const parameters: Record<string, unknown>[] = [
    ...path.matchAll(/\{([^}]+)\}/g),
  ].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: uuid,
  }));
  parameters.push(...(options.query ?? []));
  if (method !== "get" && !options.bearer) {
    parameters.push({
      name: "Origin",
      in: "header",
      required: true,
      schema: string,
      description: "Must exactly equal configured APP_ORIGIN.",
    });
    if (!options.public)
      parameters.push({
        name: "x-csrf-token",
        in: "header",
        required: true,
        schema: string,
        description: "Token returned by login for the current session.",
      });
  }
  if (options.idempotent)
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: {
        type: "string",
        minLength: 8,
        maxLength: 128,
        pattern: "^[a-zA-Z0-9._:-]+$",
      },
      description:
        "Reuse for retrying the same request. Reuse with a different payload returns 409.",
    });
  if (options.revision)
    parameters.push({
      name: "If-Match",
      in: "header",
      required: true,
      schema: string,
      description: options.revisionDescription ??
        "ETag from instance GET, containing UID:generation. Unchanged spec status updates do not invalidate it.",
    });
  const errors: Record<string, unknown> = {};
  for (const [code, description] of Object.entries({
    400: "Invalid input",
    401: "Authentication required or invalid credentials",
    403: "Permission, Origin or CSRF denied",
    404: "Resource not found, including inaccessible projects",
    409: "Conflict, stale version, active operation or invariant violation",
    429: "Login rate limit",
    500: "Unexpected server error",
    503: "Kubernetes or engine temporarily unavailable",
  }))
    errors[code] = {
      description,
      content: { "application/json": { schema: ref("Error") } },
    };
  const success = {
    description:
      options.code === 202
        ? "Accepted for asynchronous processing; poll operation state."
        : "Successful response",
    ...(options.headers ? { headers: options.headers } : {}),
    content: { [options.contentType ?? "application/json"]: { schema: options.response ?? ok } },
  };
  paths[path] ??= {};
  paths[path][method] = {
    operationId: id,
    summary,
    description: options.description ?? summary,
    security: options.bearer ? [{ telemetryBearer: [] }] : options.public ? [] : [{ session: [] }],
    parameters,
    ...(options.body
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: options.body } },
          },
        }
      : {}),
    responses: { ...errors, [String(options.code ?? 200)]: success },
  };
}
route("get", "/healthz", "health", "Process health", { public: true });
route("get", "/readyz", "readiness", "Database connectivity", { public: true });
route("post", "/v1/auth/login", "login", "Create a session", {
  public: true,
  body: object(
    {
      email,
      password: {
        type: "string",
        minLength: 1,
        maxLength: 1024,
        writeOnly: true,
      },
    },
    undefined,
    true,
  ),
  response: object({ csrfToken: string }),
  headers: {
    "Set-Cookie": {
      schema: string,
      description:
        "HttpOnly expbuild_session cookie; same-origin clients must retain it.",
    },
  },
});
route("get", "/v1/auth/me", "currentUser", "Current session user", {
  response: object({ user: ref("User") }),
});
route("post", "/v1/auth/logout", "logout", "Revoke current session");
route(
  "post",
  "/v1/auth/password",
  "changePassword",
  "Change own password and revoke all own sessions",
  {
    body: object(
      {
        currentPassword: {
          type: "string",
          minLength: 1,
          maxLength: 1024,
          writeOnly: true,
        },
        password,
      },
      undefined,
      true,
    ),
    response: object({ ok: { const: true }, reauthenticate: { const: true } }),
  },
);
route(
  "get",
  "/v1/users",
  "listUsers",
  "Platform administrator: list up to 200 users",
  {
    response: list(
      object({
        ...(user.properties as Record<string, Schema>),
        active: bool,
        created_at: { type: "string", format: "date-time" },
      }),
    ),
  },
);
route(
  "post",
  "/v1/users",
  "createUser",
  "Platform administrator: create a user",
  {
    code: 201,
    body: object({ email, password }, undefined, true),
    response: object({ id: uuid, email }),
  },
);
route(
  "patch",
  "/v1/users/{userId}",
  "updateUser",
  "Platform administrator: activate or disable a user",
  {
    body: object({ active: bool }, undefined, true),
    description:
      "Disabling revokes sessions. Cannot disable yourself or leave a project without an active administrator.",
  },
);
route(
  "post",
  "/v1/users/{userId}/password",
  "resetPassword",
  "Platform administrator: reset another user password and revoke sessions",
  { body: object({ password }, undefined, true) },
);
route(
  "get",
  "/v1/projects",
  "listProjects",
  "List up to 200 accessible projects",
  { response: list(ref("Project")) },
);
route(
  "post",
  "/v1/projects",
  "createProject",
  "Platform administrator: create and initialize a project",
  {
    code: 202,
    body: object(
      { name: { type: "string", minLength: 1, maxLength: 100 } },
      undefined,
      true,
    ),
    response: object({
      id: uuid,
      namespace: string,
      state: { const: "pending" },
    }),
    description:
      "Creates project membership and queues namespace initialization. This route does not support idempotency; inspect project list before retrying an ambiguous response.",
  },
);
route('get','/v1/projects/{projectId}/inventory','getProjectInventory','Project member: read the last read-only resource inventory',{
  response:object({result:nullable(ref('InventoryResult')),checkedAt:nullable({type:'string',format:'date-time'})}),
});
route('post','/v1/projects/{projectId}/inventory/refresh','refreshProjectInventory','Project member: schedule a read-only inventory scan',{
  code:202,response:object({scheduled:{const:true}}),description:'Coalesced refresh requests, at least 10 seconds after the previous scan. Does not mutate Kubernetes resources or release resource reservations.',
});
route('post','/v1/projects/{projectId}/instances/{instanceId}/reservations/reconcile','reconcileInstanceReservation','Platform administrator: raise an instance reservation to observed resource requirements',{
  response:object({reserved:object({storageGiB:string,cpuMillis:nullable(string),memoryMiB:nullable(string)})}),
  description:'Freshly scans the project namespace and checks instance/PVC ownership, UID, template and configuration. Refuses busy or ambiguous instances and concurrent platform changes. Only increases high-water reservations; detached volumes update storage only. May record usage above a configured quota, blocking new admissions until resolved. Does not modify Kubernetes resources or lower reservations.',
});
route('get', '/v1/projects/{projectId}/quota', 'getProjectQuota', 'Project member: read resource reservations and limits', { response: ref('QuotaSnapshot') });
route('put', '/v1/projects/{projectId}/quota', 'updateProjectQuota', 'Platform administrator: update project resource limits', {
  body: ref('QuotaLimits'), response: ref('QuotaSnapshot'), revision: true, revisionDescription: 'Quota revision from GET project quota; not an instance revision.',
  description: 'If-Match is the quota revision. Null means unlimited; zero prevents new reservations. Rejects limits below current reservations or unresolved legacy usage. Admission reserves resources in the management API. Kubernetes ResourceQuota is reconciled asynchronously; synchronization reports the last observation.',
});
route(
  "post",
  "/v1/projects/{projectId}/retry",
  "retryProject",
  "Project administrator: retry failed initialization",
  {
    code: 202,
    idempotent: true,
    response: object({
      operation: object({
        id: uuid,
        state: string,
        error_code: nullable(string),
      }),
    }),
  },
);
route(
  "get",
  "/v1/projects/{projectId}/members",
  "listMembers",
  "Project administrator: list members",
  { response: list(object({ id: uuid, email, role })) },
);
route(
  "post",
  "/v1/projects/{projectId}/members",
  "addMember",
  "Project administrator: add or update an existing account by email",
  { body: object({ email, role }, undefined, true) },
);
route(
  "put",
  "/v1/projects/{projectId}/members/{userId}",
  "updateMember",
  "Project administrator: update role",
  { body: object({ role }, undefined, true) },
);
route(
  "delete",
  "/v1/projects/{projectId}/members/{userId}",
  "removeMember",
  "Project administrator: revoke project membership",
  {
    description:
      "Cannot remove the last active project administrator. Existing sessions lose access immediately.",
  },
);
route(
  "get",
  "/v1/projects/{projectId}/audit",
  "audit",
  "Project administrator: latest 100 audit events",
  {
    response: list(
      object({
        id: uuid,
        actor_id: nullable(uuid),
        action: string,
        details: { type: "object" },
        created_at: { type: "string", format: "date-time" },
      }),
    ),
  },
);
route(
  "get",
  "/v1/templates",
  "templates",
  "List supported templates and input schema",
  {
    response: list(
      object({
        name: string,
        version: string,
        protocols: { type: "array", items: string },
        clientProfiles: { type: "array", items: ref("ClientProfile") },
        exposures: { type: "array", items: { type: "string", enum: ["ClusterInternal", "Gateway"] } },
        capabilities: { type: "object" },
        inputSchema: { type: "object" },
      }),
    ),
  },
);
const base = "/v1/projects/{projectId}/instances";
route(
  "get",
  base,
  "listInstances",
  "Project member: list up to 200 instances",
  { response: list(ref("InstanceSummary")) },
);
route(
  "post",
  base,
  "createInstance",
  "Administrator or maintainer: provision instance",
  {
    code: 202,
    idempotent: true,
    body: ref("InstanceInput"),
    response: ref("Accepted"),
    description:
      "One active operation per instance. Credentials are returned once and only to an administrator; replay never reveals the password.",
  },
);
route(
  "get",
  base + "/{instanceId}",
  "getInstance",
  "Project member: desired and observed state",
  {
    response: ref("InstanceDetail"),
    headers: {
      ETag: {
        schema: string,
        description:
          "Quoted UID:generation configuration revision, present when CR exists.",
      },
    },
  },
);
route(
  "patch",
  base + "/{instanceId}",
  "updateInstance",
  "Administrator or maintainer: replace desired configuration",
  {
    code: 202,
    idempotent: true,
    revision: true,
    body: ref("InstanceInput"),
    response: ref("Accepted"),
  },
);
route(
  "delete",
  base + "/{instanceId}",
  "deleteInstance",
  "Project administrator: delete instance according to Retain/Delete policy",
  { code: 202, idempotent: true, response: ref("Accepted") },
);
route('get', base + '/{instanceId}/retained-volume', 'getRetainedVolume', 'Project member: inspect detached storage', {
  response: object({ name: string, namespace: string, uid: string, capacity: string, allocatedCapacity: string, storageClass: string, phase: string, deleting: bool }),
  headers: { ETag: { schema: string, description: 'Quoted PVC UID, used for storage cleanup; not the CR revision.' } },
  description: 'Detached instances or failed reclaim attempts with a bound UID. Validates namespace, project, instance and bound CR UID labels. Missing PVC returns 404, ownership conflicts return 409, observation failures return 503. Capacity and allocatedCapacity are PVC request and bound capacity, not measured file usage.',
});
route('delete', base + '/{instanceId}/retained-volume', 'deleteRetainedVolume', 'Project administrator: irreversibly clean up detached storage', {
  code: 202, idempotent: true, revision: true, revisionDescription: 'PVC UID from GET retained-volume (not the instance UID:generation).', response: ref('Accepted'),
  description: 'If-Match must contain the PVC UID from GET retained-volume. Queues volume.delete. Checks ownership, absence of the original instance and all Pod references; deletes only with PVC UID and resourceVersion preconditions. Completion means PVC absence, not guaranteed physical data erasure. Failure can be submitted again after inspection with a new idempotency key. No PV deletion permission is granted.',
});
route('post', base + '/{instanceId}/retained-volume/reclaim', 'reclaimRetainedVolume', 'Project administrator: restore an instance from its retained volume', {
  code:202,idempotent:true,revision:true,revisionDescription:'PVC UID from GET retained-volume (not the old CR revision).',
  body:ref('InstanceInput'),response:ref('Accepted'),
  description:'Creates a new CacheInstance for the same binding and exact retained PVC UID. The template and storage class must match; requested capacity must cover PVC request, allocated capacity and historical reservation. Quota is reserved before the operation. The Operator transfers PVC identity only after the worker durably binds the new CR UID. Credentials are returned once. A failed operation with an existing CR may be resumed through operation retry; without a CR, a fresh reclaim request can be submitted after checking the volume.',
});
route(
  "post",
  base + "/{instanceId}/credentials/rotate",
  "rotateCredential",
  "Project administrator: rotate cache credentials",
  {
    code: 202,
    idempotent: true,
    revision: true,
    response: ref("Accepted"),
    description:
      "Creates a new Secret and rolls the workload. New password is returned once. Completion is asynchronous; failed operations do not automatically roll back.",
  },
);
route(
  "get",
  base + "/{instanceId}/statistics",
  "statistics",
  "Project member: current engine statistics",
  {
    response: ref("Statistics"),
    description:
      "Current engine snapshot, not PVC usage. Suspended instances and templates without statistics support return 409. Collection failures return 503 rather than zero values.",
  },
);
route(
  "get", base + "/{instanceId}/statistics/history", "statisticsHistory",
  "Project member: AC/CAS lookup history",
  {
    query: [{name: "window", in: "query", required: false, schema: {type: "string", enum: ["1h", "6h", "24h"], default: "1h"}}],
    response: object({
      source: {const: "prometheus"}, metric: {const: "cache-lookups"}, window: {type: "string", enum: ["1h", "6h", "24h"]},
      start: {type: "number"}, end: {type: "number"}, stepSeconds: {type: "integer"}, rateWindowSeconds: {const: 300},
      series: {type: "array", maxItems: 8, items: object({
        kind: {type: "string", enum: ["ac", "cas"]}, method: {type: "string", enum: ["get", "contains"]}, outcome: {type: "string", enum: ["hit", "miss"]},
        points: {type: "array", maxItems: 300, items: {type: "array", prefixItems: [{type: "number"}, {type: ["number", "null"], minimum: 0}], minItems: 2, maxItems: 2}},
      })},
    }),
    description: "Optional Prometheus integration. Query window is 1h (default), 6h or 24h; arbitrary queries are rejected. Returns five-minute per-second lookup rates separated by kind, get/contains and hit/miss. Empty series means no data. Nonfinite samples are null. Uses the recorded immutable CR UID, including after deletion; membership is always required. This is not a build hit ratio.",
  },
);
route(
  "get",
  "/v1/projects/{projectId}/operations",
  "listOperations",
  "Project member: latest 100 operations",
  { response: list(ref("Operation")) },
);
route(
  "get",
  "/v1/projects/{projectId}/operations/{operationId}",
  "getOperation",
  "Project member: poll asynchronous operation",
  { response: ref("Operation") },
);
route("post", "/v1/projects/{projectId}/operations/{operationId}/retry", "retryOperation", "Project administrator: resume a failed bound operation", {
  response: ref("Accepted"), code: 202, idempotent: true,
  description: "Requires Idempotency-Key. Failed create/update/rotate operations with a bound target generation may resume checks without resubmitting configuration. Failed delete operations may resume cleanup using the original bound UID and captured deletion policy. Keeps the original operation identity and rejects replaced resources. A newer instance operation prevents retry. Replaying the same key does not restart the operation again. Unbound failed create operations may recover only an existing resource matching the original operation, request hash, ownership and complete spec; they never recreate missing resources or regenerate credentials.",
});
route("get", "/v1/openapi.json", "openapi", "Authenticated API contract", {
  response: { type: "object" },
});

const observationState: Schema = {type:'string',enum:['ok','no_data','stale','unsupported','not_configured','error']};
const timestamp: Schema = {type:'string',format:'date-time'};
const number: Schema = {type:'number'};
const observationList = (item:Schema,maxItems:number) => object({state:observationState,observedAt:timestamp,truncated:bool,items:{type:'array',maxItems,items:item}},['state','items']);
route('get','/internal/metrics','platformMetrics','Installation bearer: scrape management and worker metrics',{
  bearer:true,response:string,contentType:'text/plain; version=0.0.4',description:'Disabled unless METRICS_SCRAPE_TOKEN is configured. This endpoint does not accept a browser session. Tokens must have at least 32 characters.',
});
route('post','/internal/alerts','receiveAlerts','Installation bearer: receive Alertmanager webhook batches',{
  bearer:true,body:object({alerts:{type:'array',maxItems:50,items:object({status:{enum:['firing','resolved']},fingerprint:string,startsAt:timestamp,endsAt:timestamp,labels:{type:'object',additionalProperties:string},annotations:{type:'object',additionalProperties:string}},['status','fingerprint','startsAt','endsAt','labels'])}}),
  description:'Dedicated ALERT_WEBHOOK_TOKEN required; no browser Origin/CSRF needed with this valid token. Foreign cluster/project/UID alerts are ignored. Retries are idempotent per project, immutable instance UID, fingerprint and startsAt; resolved episodes cannot be reopened by a delayed firing delivery.',
});
route('get','/v1/platform/observability','platformObservability','Platform administrator: control plane observation snapshot',{
  response:object({observedAt:timestamp,clusterId:string,database:{const:'ok'},workers:{type:'object',additionalProperties:object({lastSuccess:nullable(timestamp),lastFailure:nullable(timestamp)})},queues:{type:'array',items:object({kind:string,state:string,count:number,oldest_seconds:number})},connections:object({total:number,idle:number,waiting:number}),integrations:object({metrics:bool,logs:bool,alerts:bool,alertHistory:bool}),metricsEndpoint:bool}),
  description:'Local replica worker polling status and database-backed queue snapshot. Integration flags describe configuration, not a successful live health check.',
});
route('get','/v1/projects/{projectId}/observability','projectObservability','Project member: latest background observations and coverage',{
  response:object({observedAt:timestamp,total:number,covered:number,truncated:bool,items:{type:'array',maxItems:500,items:object({id:uuid,display_name:string,template_name:string,lifecycle:string,kubernetes_uid:nullable(string),observed_at:nullable(timestamp),dataState:observationState,payload:nullable(object({phase:{enum:['ready','starting','suspended','deleting','unknown']},collection:{enum:['ok','error','unsupported','suspended']},generation:nullable(number),conditions:{type:'array',items:object({type:string,status:string,reason:string,current:bool})},statistics:nullable(ref('Statistics'))}))})}}),
});
const observationBase='/v1/projects/{projectId}/instances/{instanceId}/observability';
route('get',observationBase+'/metrics','instanceObservationMetrics','Project member: bounded metric trends',{
  query:[{name:'group',in:'query',schema:{enum:['capacity','lookups','resources','performance'],default:'capacity'}},{name:'window',in:'query',schema:{enum:['1h','6h','24h'],default:'1h'}}],
  response:object({state:observationState,source:string,group:string,start:number,end:number,step:number,observedAt:nullable(timestamp),series:{type:'array',maxItems:20,items:object({name:string,unit:string,points:{type:'array',maxItems:361,items:{type:'array',prefixItems:[number,nullable(number)],minItems:2,maxItems:2}}})}},['state','series']),
  description:'Queries are server-owned and scoped to deployment cluster, project and original CR UID. Unknown query parameters are rejected. Null samples preserve gaps; zero is a measured value. observedAt is the last finite evaluation point, not the raw scrape timestamp. Rate windows are five minutes.',
});
route('get',observationBase+'/logs','instanceObservationLogs','Project administrator or maintainer: bounded instance logs',{
  query:[{name:'minutes',in:'query',schema:{type:'integer',minimum:1,maximum:60,default:15}},{name:'level',in:'query',schema:{enum:['info','warn','error']}}],
  response:observationList(object({time:timestamp,text:string}),500),description:'Maximum 500 lines and 1 MiB upstream response, five-second timeout. Identity is verified on every returned stream. Application-level redaction is defense in depth; sanitize at ingestion and never emit credentials.',
});
route('get',observationBase+'/events','instanceObservationEvents','Project member: latest condition changes and operations',{
  response:observationList(object({id:uuid,time:timestamp,code:string,details:{type:'object'}}),100),description:'Retains the original immutable instance UID, including after deletion. At most 100 results; condition history is retained for 30 days. Operation and audit retention are independent.',
});
route('get','/v1/projects/{projectId}/observability/alerts','projectAlerts','Project member: active instance alerts',{
  response:observationList(object({fingerprint:string,instanceUID:string,instanceId:uuid,instanceName:string,name:string,severity:string,summary:string,startsAt:timestamp,endsAt:timestamp,state:{enum:['unprocessed','active','suppressed']}}),500),
});
route('post',observationBase+'/silences','silenceInstanceAlert','Project administrator or maintainer: silence one bound alert rule',{
  code:201,body:object({fingerprint:{type:'string',pattern:'^[a-fA-F0-9]{1,128}$'},minutes:{type:'integer',minimum:5,maximum:1440}},undefined,true),response:object({silenceID:uuid}),description:'Resolves the active fingerprint before constructing exact non-regex cluster/project/instance/rule matchers. Persists an audit attempt before the external write. If the outcome is unknown, refresh alerts before retrying.',
});
route('get','/v1/projects/{projectId}/observability/alert-history','projectAlertHistory','Project member: received alert episodes',{
  response:observationList(object({fingerprint:string,starts_at:timestamp,ends_at:nullable(timestamp),received_at:timestamp,active_confirmed:nullable(bool),checked_at:nullable(timestamp),state:{enum:['firing','resolved']},payload:object({name:string,severity:string,summary:string}),instance_id:uuid,display_name:string}),100),description:'Webhook deliveries retained for 30 days after resolution. This is received history, not guaranteed complete backend history.',
});

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "expbuild Management API",
    version: "0.1.0",
    description:
      "Enterprise cache platform control plane. Cookie session authentication, Origin/CSRF checks on writes. Platform administrators may access every project; ordinary users require membership. Errors deliberately hide inaccessible projects.",
  },
  servers: [{ url: "/" }],
  security: [{ session: [] }],
  paths,
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "expbuild_session" },
      telemetryBearer: {type:'http',scheme:'bearer',description:'Dedicated scrape or webhook credential, selected by endpoint; never a user session.'},
    },
    schemas,
  },
};
