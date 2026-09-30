import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { z } from "zod";
import { transaction } from "./db.js";
import { HttpError, OperationError } from "./errors.js";
import { digest, token } from "./security.js";
import { seal } from "./secrets.js";
import {
  desiredObject,
  instanceInput,
  bazelInput,
  webdavInput,
  revision,
  type CacheObject,
} from "./instance-contract.js";
import type { KubernetesPort } from "./kubernetes.js";
import type { InstanceStatistics } from './statistics.js';
import { historyWindow, type HistoryReader } from './history.js';

type Actor = { id: string; platform_admin: boolean };
type Auth = {
  user(request: FastifyRequest): Promise<Actor>;
  projectAccess(
    request: FastifyRequest,
    id: string,
    roles: ("admin" | "maintainer" | "viewer")[],
  ): Promise<Actor>;
};
export type InstanceOptions = {
  kube?: KubernetesPort;
  encryptionKey?: Buffer;
  storageClass?: string;
  webdavEnabled?: boolean;
  gatewayEnabled?: boolean;
  history?: HistoryReader;
  statistics?: {readStatistics(object: CacheObject): Promise<InstanceStatistics>};
};
const ids = z.object({
  projectId: z.string().uuid(),
  instanceId: z.string().uuid(),
});
const projectParams = z.object({ projectId: z.string().uuid() });
const opSummary =
  "id,project_id,instance_id,kind,state,target_generation,error_code,created_at,updated_at";

export async function registerInstanceRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  options: InstanceOptions,
  auth: Auth,
) {
  app.get('/v1/projects/:projectId/instances/:instanceId/statistics/history', async (request, reply) => {
    const {projectId, instanceId} = ids.parse(request.params);
    await auth.projectAccess(request, projectId, ['admin', 'maintainer', 'viewer']);
    const {window} = z.object({window: historyWindow.default('1h')}).strict().parse(request.query);
    const b = await binding(projectId, instanceId);
    reply.header('Cache-Control', 'no-store');
    if (!b.kubernetes_uid) throw new HttpError(409, 'Instance identity has not been established');
    if (b.template_name !== 'bazel-remote') throw new HttpError(409, 'This template does not support lookup history');
    if (!options.history) throw new HttpError(503, 'Prometheus history is not configured');
    try { return await options.history.read({projectId, instanceUID: b.kubernetes_uid}, window); }
    catch { throw new HttpError(503, 'Lookup history is temporarily unavailable'); }
  });
  app.get('/v1/projects/:projectId/instances/:instanceId/statistics',async(request,reply)=>{
    const {projectId,instanceId}=ids.parse(request.params);
    await auth.projectAccess(request,projectId,['admin','maintainer','viewer']);
    const b=await binding(projectId,instanceId),current=await readOwned(b);
    reply.header('Cache-Control','no-store');
    if(!current || current.metadata.deletionTimestamp)throw new HttpError(409,'Instance is not available');
    if(current.spec.desiredState!=='Running')throw new HttpError(409,'Statistics are unavailable while the instance is suspended');
    if(current.spec.templateRef.name !== 'bazel-remote')throw new HttpError(409,'This template does not support engine statistics');
    if(!options.statistics)throw new HttpError(503,'Statistics collection is not configured');
    try{return await options.statistics.readStatistics(current);}
    catch{throw new HttpError(503,'Engine statistics are temporarily unavailable');}
  });
  function kube() {
    if (!options.kube)
      throw new HttpError(503, "Kubernetes connection is not configured");
    return options.kube;
  }
  const idempotencyKey = (request: FastifyRequest) =>
    z
      .string()
      .min(8)
      .max(128)
      .regex(/^[a-zA-Z0-9._:-]+$/)
      .parse(request.headers["idempotency-key"]);
  async function binding(projectId: string, instanceId: string) {
    const found = await pool.query(
      "SELECT i.*,p.namespace,p.state AS project_state FROM instance_bindings i JOIN projects p ON p.id=i.project_id WHERE i.project_id=$1 AND i.id=$2",
      [projectId, instanceId],
    );
    if (!found.rows[0]) throw new HttpError(404, "Instance not found");
    return found.rows[0];
  }
  async function readOwned(b: {
    namespace: string;
    resource_name: string;
    id: string;
    project_id: string;
    kubernetes_uid: string | null;
  }) {
    let c: CacheObject | null;
    try {
      c = await kube().getInstance(b.namespace, b.resource_name);
    } catch {
      throw new HttpError(503, "Kubernetes state is temporarily unavailable");
    }
    if (
      c &&
      (c.spec.instanceId !== b.id ||
        c.spec.projectId !== b.project_id ||
        (b.kubernetes_uid && c.metadata.uid !== b.kubernetes_uid))
    )
      throw new HttpError(409, "Kubernetes resource identity conflict");
    return c;
  }
  async function replay(
    client: pg.PoolClient,
    projectId: string,
    kind: string,
    key: string,
    requestHash: string,
  ) {
    const found = await client.query(
      `SELECT ${opSummary},request_hash FROM operations WHERE project_id=$1 AND kind=$2 AND idempotency_key=$3`,
      [projectId, kind, key],
    );
    if (!found.rows[0]) return null;
    if (found.rows[0].request_hash !== requestHash)
      throw new HttpError(
        409,
        "Idempotency key was already used for another request",
      );
    const { request_hash: _, ...result } = found.rows[0];
    return result;
  }
  async function lockProject(
    client: pg.PoolClient,
    projectId: string,
    actor: Actor,
    roles: string[],
  ) {
    // Shared authorization mutation lock makes acceptance atomic with revocation.
    await client.query("SELECT pg_advisory_xact_lock(73942102)");
    const p = await client.query(
      "SELECT id,namespace,state FROM projects WHERE id=$1 FOR UPDATE",
      [projectId],
    );
    const fresh = await client.query(
      "SELECT u.active,u.platform_admin,m.role FROM users u LEFT JOIN project_members m ON m.user_id=u.id AND m.project_id=$2 WHERE u.id=$1",
      [actor.id, projectId],
    );
    if (
      !fresh.rows[0]?.active ||
      (!fresh.rows[0].platform_admin && !roles.includes(fresh.rows[0].role))
    )
      throw new HttpError(403, "Permission denied");
    if (!p.rows[0]) throw new HttpError(404, "Project not found");
    return p.rows[0];
  }

  app.get("/v1/templates", async (request) => {
    await auth.user(request);
    return {
      items: [
        {
          name: "bazel-remote",
          version: "0.1.0",
          exposures: options.gatewayEnabled ? ["ClusterInternal", "Gateway"] : ["ClusterInternal"],
          protocols: ["reapi", "bazel-http"],
          capabilities: { capacity: true, statistics: true, lru: true, ttl: false, replicas: 1, policyApplyMode: "restart", policyCondition: "PolicyApplied" },
          inputSchema: z.toJSONSchema(bazelInput, { io: "input" }),
        },
        ...(options.webdavEnabled ? [{
          name: "webdav-apache", version: "0.1.0", exposures: options.gatewayEnabled ? ["ClusterInternal", "Gateway"] : ["ClusterInternal"], protocols: ["webdav", "http"],
          capabilities: { capacity: false, statistics: false, lru: false, ttl: false, replicas: 1, policyApplyMode: "unsupported", policyCondition: "PolicyApplied" },
          inputSchema: z.toJSONSchema(webdavInput, { io: "input" }),
        }] : []),
      ],
    };
  });
  app.get("/v1/projects/:projectId/instances", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    await auth.projectAccess(request, projectId, [
      "admin",
      "maintainer",
      "viewer",
    ]);
    const result = await pool.query(
      "SELECT id,display_name,template_name,lifecycle,resource_name,created_at FROM instance_bindings WHERE project_id=$1 ORDER BY created_at DESC LIMIT 200",
      [projectId],
    );
    return { items: result.rows };
  });
  app.get(
    "/v1/projects/:projectId/instances/:instanceId",
    async (request, reply) => {
      const { projectId, instanceId } = ids.parse(request.params);
      await auth.projectAccess(request, projectId, [
        "admin",
        "maintainer",
        "viewer",
      ]);
      const b = await binding(projectId, instanceId),
        c = await readOwned(b);
      if (c) reply.header("ETag", `"${revision(c)}"`);
      return {
        id: b.id,
        name: b.display_name,
        template: b.template_name,
        lifecycle: b.lifecycle,
        revision: c ? revision(c) : null,
        spec: c?.spec ?? null,
        status: c?.status ?? null,
        observedAt: new Date().toISOString(),
      };
    },
  );
  app.get('/v1/projects/:projectId/instances/:instanceId/retained-volume', async (request, reply) => {
    const { projectId, instanceId } = ids.parse(request.params);
    await auth.projectAccess(request, projectId, ['admin', 'maintainer', 'viewer']);
    const b = await binding(projectId, instanceId);
    if (b.lifecycle !== 'detached' || !b.kubernetes_uid) throw new HttpError(409, 'Instance does not have detached storage');
    const volume = await kube().getRetainedVolume({ namespace: b.namespace, name: b.resource_name, projectId, instanceId, instanceUid: b.kubernetes_uid }).catch(error => {
      if (error instanceof OperationError) throw new HttpError(409, error.code);
      throw new HttpError(503, 'Storage observation is temporarily unavailable');
    });
    if (!volume) throw new HttpError(404, 'Retained volume no longer exists');
    reply.header('Cache-Control', 'no-store');
    reply.header('ETag', `"${volume.uid}"`);
    return volume;
  });
  app.delete('/v1/projects/:projectId/instances/:instanceId/retained-volume', async (request, reply) => {
    const { projectId, instanceId } = ids.parse(request.params);
    const actor = await auth.projectAccess(request, projectId, ['admin']);
    kube();
    const uid = z.string().min(1).max(200).parse(request.headers['if-match']).replace(/^"|"$/g, '');
    const key = idempotencyKey(request), requestHash = digest(JSON.stringify({ instanceId, uid }));
    const result = await transaction(pool, async client => {
      await lockProject(client, projectId, actor, ['admin']);
      const previous = await replay(client, projectId, 'volume.delete', key, requestHash);
      if (previous) return previous;
      const rows = await client.query('SELECT i.*,p.namespace FROM instance_bindings i JOIN projects p ON p.id=i.project_id WHERE i.project_id=$1 AND i.id=$2 FOR UPDATE OF i', [projectId, instanceId]);
      const b = rows.rows[0];
      if (!b) throw new HttpError(404, 'Instance not found');
      if (b.lifecycle !== 'detached' || !b.kubernetes_uid) throw new HttpError(409, 'Instance does not have detached storage');
      const operationId = randomUUID();
      const inserted = await client.query(`INSERT INTO operations(id,project_id,instance_id,kind,idempotency_key,request_hash,request,created_by) VALUES($1,$2,$3,'volume.delete',$4,$5,$6,$7) RETURNING ${opSummary}`, [operationId, projectId, instanceId, key, requestHash, JSON.stringify({ namespace: b.namespace, name: b.resource_name, instanceUid: b.kubernetes_uid, uid }), actor.id]);
      await client.query("INSERT INTO audit_events(id,actor_id,project_id,instance_id,operation_id,action,details) VALUES($1,$2,$3,$4,$5,'volume.delete',$6)", [randomUUID(), actor.id, projectId, instanceId, operationId, JSON.stringify({ volumeUid: uid })]);
      return inserted.rows[0];
    });
    return reply.code(202).send({ operation: result });
  });

  app.post("/v1/projects/:projectId/instances", async (request, reply) => {
    const { projectId } = projectParams.parse(request.params),
      actor = await auth.projectAccess(request, projectId, [
        "admin",
        "maintainer",
      ]);
    kube();
    if (!options.encryptionKey || !options.storageClass)
      throw new HttpError(503, "Instance provisioning is not configured");
    const input = instanceInput.parse(request.body),
      key = idempotencyKey(request),
      requestHash = digest(JSON.stringify(input));
    const id = randomUUID(),
      operationId = randomUUID(),
      password = token(),
      probePassword = token();
    const credentials = {
      htpasswd: `cache:${await hash(password, 10)}\nhealth:${await hash(probePassword, 10)}\n`,
      "probe-username": "health",
      "probe-password": probePassword,
    };
    const result = await transaction(pool, async (client) => {
      const project = await lockProject(client, projectId, actor, [
        "admin",
        "maintainer",
      ]);
      const existing = await replay(
        client,
        projectId,
        "instance.create",
        key,
        requestHash,
      );
      if (existing) return { operation: existing, replayed: true };
      if (input.exposure === "Gateway" && !options.gatewayEnabled) throw new HttpError(409, "Gateway exposure is not enabled");
      if (input.template === "webdav-apache" && !options.webdavEnabled)
        throw new HttpError(409, "WebDAV template is not enabled");
      if (project.state !== "ready")
        throw new HttpError(409, "Project initialization is not complete");
      const desired = desiredObject(
        input,
        projectId,
        project.namespace,
        id,
        options.storageClass!,
        operationId,
        requestHash,
      );
      await client.query(
        "INSERT INTO instance_bindings(id,project_id,resource_name,display_name,created_by,template_name) VALUES($1,$2,$3,$4,$5,$6)",
        [id, projectId, desired.metadata.name, input.name, actor.id, input.template],
      );
      await client.query(
        "INSERT INTO instance_credentials(id,instance_id,name,secret_name,state) VALUES($1,$2,'default',$3,'pending')",
        [randomUUID(), id, desired.spec.access.credentialsSecretRef],
      );
      const inserted = await client.query(
        `INSERT INTO operations(id,project_id,instance_id,kind,idempotency_key,request_hash,request,secret_payload,created_by) VALUES($1,$2,$3,'instance.create',$4,$5,$6,$7,$8) RETURNING ${opSummary}`,
        [
          operationId,
          projectId,
          id,
          key,
          requestHash,
          JSON.stringify({ desired }),
          seal(options.encryptionKey!, operationId, credentials),
          actor.id,
        ],
      );
      await client.query(
        "INSERT INTO audit_events(id,actor_id,project_id,instance_id,operation_id,action) VALUES($1,$2,$3,$4,$5,'instance.create')",
        [randomUUID(), actor.id, projectId, id, operationId],
      );
      const membership = await client.query(
        "SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2",
        [projectId, actor.id],
      );
      return {
        operation: inserted.rows[0],
        replayed: false,
        ...(actor.platform_admin || membership.rows[0]?.role === "admin"
          ? { credentials: { username: "cache", password } }
          : {}),
      };
    });
    reply.header("Cache-Control", "no-store");
    return reply.code(202).send(result);
  });

  app.patch(
    "/v1/projects/:projectId/instances/:instanceId",
    async (request, reply) => {
      const { projectId, instanceId } = ids.parse(request.params),
        actor = await auth.projectAccess(request, projectId, [
          "admin",
          "maintainer",
        ]);
      const input = instanceInput.parse(request.body),
        key = idempotencyKey(request);
      const expected = z
        .string()
        .min(3)
        .max(200)
        .parse(request.headers["if-match"])
        .replace(/^"|"$/g, "");
      const requestHash = digest(
        JSON.stringify({ instanceId, input, expected }),
      );
      const result = await transaction(pool, async (client) => {
        await lockProject(client, projectId, actor, ["admin", "maintainer"]);
        return replay(client, projectId, "instance.update", key, requestHash);
      });
      if (result)
        return reply.code(202).send({ operation: result, replayed: true });
      if (input.exposure === "Gateway" && !options.gatewayEnabled) throw new HttpError(409, "Gateway exposure is not enabled");
      const b = await binding(projectId, instanceId),
        current = await readOwned(b);
      if (!current || current.metadata.deletionTimestamp || !b.kubernetes_uid)
        throw new HttpError(409, "Instance is not available for update");
      if (current.spec.templateRef.name !== input.template)
        throw new HttpError(400, "Instance template cannot be changed");
      if (revision(current) !== expected)
        throw new HttpError(409, "Instance configuration changed");
      if (
        input.storageGiB <
        Number(current.spec.storage.capacity.replace(/Gi$/, ""))
      )
        throw new HttpError(400, "Storage shrinking is not supported");
      const operationId = randomUUID();
      const desired = desiredObject(
        input,
        projectId,
        b.namespace,
        instanceId,
        current.spec.storage.className,
        operationId,
        requestHash,
      );
      desired.spec.access.credentialsSecretRef =
        current.spec.access.credentialsSecretRef;
      const accepted = await transaction(pool, async (client) => {
        await lockProject(client, projectId, actor, ["admin", "maintainer"]);
        const existing = await replay(
          client,
          projectId,
          "instance.update",
          key,
          requestHash,
        );
        if (existing) return existing;
        const row = await client.query(
          `INSERT INTO operations(id,project_id,instance_id,kind,idempotency_key,request_hash,request,created_by) VALUES($1,$2,$3,'instance.update',$4,$5,$6,$7) RETURNING ${opSummary}`,
          [
            operationId,
            projectId,
            instanceId,
            key,
            requestHash,
            JSON.stringify({ desired, expectedRevision: expected }),
            actor.id,
          ],
        );
        await client.query(
          "INSERT INTO audit_events(id,actor_id,project_id,instance_id,operation_id,action) VALUES($1,$2,$3,$4,$5,'instance.update')",
          [randomUUID(), actor.id, projectId, instanceId, operationId],
        );
        return row.rows[0];
      });
      return reply.code(202).send({ operation: accepted });
    },
  );
  app.post(
    "/v1/projects/:projectId/instances/:instanceId/credentials/rotate",
    async (request, reply) => {
      const { projectId, instanceId } = ids.parse(request.params),
        actor = await auth.projectAccess(request, projectId, ["admin"]);
      kube();
      if (!options.encryptionKey)
        throw new HttpError(503, "Credential provisioning is not configured");
      const key = idempotencyKey(request);
      const expected = z
        .string()
        .min(3)
        .max(200)
        .parse(request.headers["if-match"])
        .replace(/^"|"$/g, "");
      const requestHash = digest(JSON.stringify({ instanceId, expected }));
      const existing = await transaction(pool, async (client) => {
        await lockProject(client, projectId, actor, ["admin"]);
        return replay(client, projectId, "instance.rotate", key, requestHash);
      });
      if (existing)
        return reply
          .header("Cache-Control", "no-store")
          .code(202)
          .send({ operation: existing, replayed: true });
      const b = await binding(projectId, instanceId),
        current = await readOwned(b);
      if (
        !current ||
        current.metadata.deletionTimestamp ||
        !b.kubernetes_uid ||
        revision(current) !== expected
      )
        throw new HttpError(
          409,
          "Instance configuration changed or is unavailable",
        );
      const operationId = randomUUID(),
        password = token(),
        probePassword = token();
      const secretName = `auth-${operationId}`;
      const data = {
        htpasswd: `cache:${await hash(password, 10)}\nhealth:${await hash(probePassword, 10)}\n`,
        "probe-username": "health",
        "probe-password": probePassword,
      };
      const desired: CacheObject = {
        apiVersion: current.apiVersion,
        kind: current.kind,
        metadata: {
          name: current.metadata.name,
          namespace: current.metadata.namespace,
          annotations: {
            ...current.metadata.annotations,
            "cache.expbuild.io/operation-id": operationId,
            "cache.expbuild.io/request-hash": requestHash,
          },
        },
        spec: structuredClone(current.spec),
      };
      desired.spec.access.credentialsSecretRef = secretName;
      const result = await transaction(pool, async (client) => {
        await lockProject(client, projectId, actor, ["admin"]);
        const replayed = await replay(
          client,
          projectId,
          "instance.rotate",
          key,
          requestHash,
        );
        if (replayed) return { operation: replayed, replayed: true };
        const inserted = await client.query(
          `INSERT INTO operations(id,project_id,instance_id,kind,idempotency_key,request_hash,request,secret_payload,created_by) VALUES($1,$2,$3,'instance.rotate',$4,$5,$6,$7,$8) RETURNING ${opSummary}`,
          [
            operationId,
            projectId,
            instanceId,
            key,
            requestHash,
            JSON.stringify({ desired, expectedRevision: expected }),
            seal(options.encryptionKey!, operationId, data),
            actor.id,
          ],
        );
        await client.query(
          "INSERT INTO instance_credentials(id,instance_id,name,secret_name,state,revision) SELECT $1,$2,'default',$3,'pending',COALESCE(MAX(revision),0)+1 FROM instance_credentials WHERE instance_id=$2",
          [randomUUID(), instanceId, secretName],
        );
        await client.query(
          "INSERT INTO audit_events(id,actor_id,project_id,instance_id,operation_id,action) VALUES($1,$2,$3,$4,$5,'credential.rotate')",
          [randomUUID(), actor.id, projectId, instanceId, operationId],
        );
        return {
          operation: inserted.rows[0],
          credentials: { username: "cache", password },
          replayed: false,
        };
      });
      return reply.header("Cache-Control", "no-store").code(202).send(result);
    },
  );
  app.delete(
    "/v1/projects/:projectId/instances/:instanceId",
    async (request, reply) => {
      const { projectId, instanceId } = ids.parse(request.params),
        actor = await auth.projectAccess(request, projectId, ["admin"]);
      const key = idempotencyKey(request),
        requestHash = digest(JSON.stringify({ instanceId }));
      const result = await transaction(pool, async (client) => {
        await lockProject(client, projectId, actor, ["admin"]);
        const existing = await replay(
          client,
          projectId,
          "instance.delete",
          key,
          requestHash,
        );
        if (existing) return existing;
        const b = await client.query(
          "SELECT i.*,p.namespace FROM instance_bindings i JOIN projects p ON p.id=i.project_id WHERE i.id=$1 AND i.project_id=$2 FOR UPDATE OF i",
          [instanceId, projectId],
        );
        if (!b.rows[0]) throw new HttpError(404, "Instance not found");
        if (
          !b.rows[0].kubernetes_uid ||
          ["deleted", "detached"].includes(b.rows[0].lifecycle)
        )
          throw new HttpError(409, "Instance has no active Kubernetes binding");
        const operationId = randomUUID();
        const row = await client.query(
          `INSERT INTO operations(id,project_id,instance_id,kind,idempotency_key,request_hash,request,created_by) VALUES($1,$2,$3,'instance.delete',$4,$5,$6,$7) RETURNING ${opSummary}`,
          [
            operationId,
            projectId,
            instanceId,
            key,
            requestHash,
            JSON.stringify({
              uid: b.rows[0].kubernetes_uid,
              namespace: b.rows[0].namespace,
              name: b.rows[0].resource_name,
            }),
            actor.id,
          ],
        );
        await client.query(
          "UPDATE instance_bindings SET lifecycle='deleting' WHERE id=$1",
          [instanceId],
        );
        await client.query(
          "INSERT INTO audit_events(id,actor_id,project_id,instance_id,operation_id,action) VALUES($1,$2,$3,$4,$5,'instance.delete')",
          [randomUUID(), actor.id, projectId, instanceId, operationId],
        );
        return row.rows[0];
      });
      return reply.code(202).send({ operation: result });
    },
  );
  app.post("/v1/projects/:projectId/operations/:operationId/retry", async (request, reply) => {
    const { projectId, operationId } = z.object({ projectId: z.string().uuid(), operationId: z.string().uuid() }).parse(request.params);
    const actor = await auth.projectAccess(request, projectId, ["admin"]);
    const key = idempotencyKey(request);
    const result = await transaction(pool, async client => {
      await lockProject(client, projectId, actor, ["admin"]);
      const replayed = await client.query("SELECT operation_id FROM operation_retries WHERE project_id=$1 AND idempotency_key=$2", [projectId, key]);
      if (replayed.rows[0] && replayed.rows[0].operation_id !== operationId)
        throw new HttpError(409, "Idempotency key was already used for another request");
      const found = await client.query("SELECT * FROM operations WHERE id=$1 AND project_id=$2 FOR UPDATE", [operationId, projectId]);
      const operation = found.rows[0];
      if (!operation) throw new HttpError(404, "Operation not found");
      if (!replayed.rows[0]) {
        const deleting = operation.kind === "instance.delete";
        const recoveringCreate = operation.kind === "instance.create" && !operation.target_generation;
        if (operation.state !== "failed" || (!deleting && !recoveringCreate && (!["instance.create", "instance.update", "instance.rotate"].includes(operation.kind) || !operation.target_generation)))
          throw new HttpError(409, "Only failed instance operations with a recoverable request can be resumed");
        const binding = await client.query("SELECT kubernetes_uid,lifecycle FROM instance_bindings WHERE id=$1 FOR UPDATE", [operation.instance_id]);
        const bound = binding.rows[0];
        if (!bound || (!recoveringCreate && !bound.kubernetes_uid) || (deleting
          ? bound.lifecycle !== "deleting" || operation.request.uid !== bound.kubernetes_uid
          : ["deleting", "deleted", "detached"].includes(bound.lifecycle)))
          throw new HttpError(409, "Instance is no longer available for reconciliation");
        // A later request permanently supersedes this retry, including failed requests.
        const newer = await client.query("SELECT id FROM operations WHERE instance_id=$1 AND id<>$2 AND created_at >= $3 LIMIT 1", [operation.instance_id, operationId, operation.created_at]);
        if (newer.rows.length) throw new HttpError(409, "A newer instance operation exists");
        await client.query("INSERT INTO operation_retries(project_id,idempotency_key,operation_id) VALUES($1,$2,$3)", [projectId, key, operationId]);
        await client.query("UPDATE operations SET state='reconciling',error_code=NULL,worker_id=NULL,lease_until=NULL,next_attempt_at=now(),deadline_at=now()+interval '20 minutes',updated_at=now() WHERE id=$1", [operationId]);
        if (operation.kind === "instance.create") await client.query("UPDATE instance_bindings SET lifecycle='pending' WHERE id=$1", [operation.instance_id]);
        await client.query("INSERT INTO audit_events(id,actor_id,project_id,instance_id,operation_id,action,details) VALUES($1,$2,$3,$4,$5,'operation.retry',$6)", [randomUUID(), actor.id, projectId, operation.instance_id, operationId, JSON.stringify({ previousError: operation.error_code })]);
      }
      const summary = await client.query(`SELECT ${opSummary} FROM operations WHERE id=$1`, [operationId]);
      return { operation: summary.rows[0], replayed: !!replayed.rows[0] };
    });
    return reply.code(202).send(result);
  });
  app.get("/v1/projects/:projectId/operations", async (request) => {
    const { projectId } = projectParams.parse(request.params);
    await auth.projectAccess(request, projectId, [
      "admin",
      "maintainer",
      "viewer",
    ]);
    const result = await pool.query(
      `SELECT ${opSummary} FROM operations WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [projectId],
    );
    return { items: result.rows };
  });
  app.get(
    "/v1/projects/:projectId/operations/:operationId",
    async (request) => {
      const { projectId, operationId } = z
        .object({
          projectId: z.string().uuid(),
          operationId: z.string().uuid(),
        })
        .parse(request.params);
      await auth.projectAccess(request, projectId, [
        "admin",
        "maintainer",
        "viewer",
      ]);
      const result = await pool.query(
        `SELECT ${opSummary} FROM operations WHERE project_id=$1 AND id=$2`,
        [projectId, operationId],
      );
      if (!result.rows[0]) throw new HttpError(404, "Operation not found");
      return result.rows[0];
    },
  );
}
