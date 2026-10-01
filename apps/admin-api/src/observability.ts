import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "./errors.js";
import { authorizedToken, validToken, type Telemetry } from "./telemetry.js";
import {
  observationWindow,
  sanitizeLog,
  type ObservationMetrics,
  type ObservationLogs,
  type ObservationAlerts,
  type Target,
} from "./observation-backends.js";

export type ObservabilityOptions = {
  telemetry?: Telemetry;
  metricsToken?: string;
  observability?: {
    metrics?: ObservationMetrics;
    logs?: ObservationLogs;
    alerts?: ObservationAlerts;
    webhookToken?: string;
  };
};
type Auth = {
  user(
    request: FastifyRequest,
  ): Promise<{ id: string; platform_admin: boolean }>;
  projectAccess(
    request: FastifyRequest,
    id: string,
    roles: ("admin" | "maintainer" | "viewer")[],
  ): Promise<{ id: string; platform_admin: boolean }>;
};
const projectParams = z.object({ projectId: z.string().uuid() });
const instanceParams = projectParams.extend({ instanceId: z.string().uuid() });
const allRoles: ("admin" | "maintainer" | "viewer")[] = [
  "admin",
  "maintainer",
  "viewer",
];
export async function registerObservability(
  app: FastifyInstance,
  pool: pg.Pool,
  options: ObservabilityOptions,
  auth: Auth,
) {
  const clients = options.observability;
  if (clients?.webhookToken !== undefined && !validToken(clients.webhookToken))
    throw new Error("Invalid alert webhook token");
  async function target(
    projectId: string,
    instanceId: string,
  ): Promise<Target> {
    const found = await pool.query(
      "SELECT i.*,p.namespace FROM instance_bindings i JOIN projects p ON p.id=i.project_id WHERE i.id=$1 AND i.project_id=$2",
      [instanceId, projectId],
    );
    const row = found.rows[0];
    if (!row) throw new HttpError(404, "Instance not found");
    if (!row.kubernetes_uid)
      throw new HttpError(409, "Instance identity has not been established");
    return {
      projectId,
      instanceUID: row.kubernetes_uid,
      namespace: row.namespace,
      template: row.template_name,
      version: row.template_version ?? "",
    };
  }
  app.get("/v1/platform/observability", async (request, reply) => {
    if (!(await auth.user(request)).platform_admin)
      throw new HttpError(403, "Platform administrator required");
    reply.header("Cache-Control", "no-store");
    const queues = await pool.query(
      "SELECT kind,state,count(*)::int AS count,extract(epoch FROM now()-min(created_at))::float AS oldest_seconds FROM operations WHERE state IN ('pending','applying','reconciling') GROUP BY kind,state ORDER BY kind,state",
    );
    return {
      observedAt: new Date().toISOString(),
      clusterId: options.telemetry?.clusterId ?? "primary",
      database: "ok",
      workers: Object.fromEntries(options.telemetry?.workers ?? []),
      queues: queues.rows,
      connections: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
      integrations: {
        metrics: !!clients?.metrics,
        logs: !!clients?.logs,
        alerts: !!clients?.alerts,
        alertHistory: !!clients?.webhookToken,
      },
      metricsEndpoint: !!options.metricsToken,
    };
  });
  app.get("/v1/projects/:projectId/observability", async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    await auth.projectAccess(request, projectId, allRoles);
    z.object({}).strict().parse(request.query);
    reply.header("Cache-Control", "no-store");
    const result = await pool.query(
      `SELECT i.id,i.display_name,i.template_name,i.lifecycle,i.kubernetes_uid,s.observed_at,s.payload,count(*) OVER()::int AS total FROM instance_bindings i LEFT JOIN observation_snapshots s ON s.instance_id=i.id AND s.instance_uid=i.kubernetes_uid WHERE i.project_id=$1 AND i.lifecycle NOT IN ('deleted','detached') ORDER BY i.created_at,i.id LIMIT 500`,
      [projectId],
    );
    const now = Date.now();
    const items = result.rows.map(({ total: _total, ...row }) => ({
      ...row,
      dataState: !row.observed_at
        ? "no_data"
        : now - new Date(row.observed_at).getTime() > 120_000
          ? "stale"
          : row.payload.collection === "error"
            ? "error"
            : "ok",
    }));
    return {
      observedAt: new Date(now).toISOString(),
      total: result.rows[0]?.total ?? 0,
      covered: items.filter((i) => i.dataState === "ok").length,
      truncated: (result.rows[0]?.total ?? 0) > items.length,
      items,
    };
  });
  app.get(
    "/v1/projects/:projectId/instances/:instanceId/observability/metrics",
    async (request, reply) => {
      const p = instanceParams.parse(request.params);
      await auth.projectAccess(request, p.projectId, allRoles);
      const query = z
        .object({
          window: observationWindow.default("1h"),
          group: z
            .enum(["capacity", "lookups", "resources", "performance"])
            .default("capacity"),
        })
        .strict()
        .parse(request.query);
      const owned = await target(p.projectId, p.instanceId);
      reply.header("Cache-Control", "no-store");
      if (!clients?.metrics) return { state: "not_configured", series: [] };
      try {
        return await clients.metrics.read(owned, query.group, query.window);
      } catch {
        return { state: "error", series: [] };
      }
    },
  );
  app.get(
    "/v1/projects/:projectId/instances/:instanceId/observability/logs",
    async (request, reply) => {
      const p = instanceParams.parse(request.params);
      await auth.projectAccess(request, p.projectId, ["admin", "maintainer"]);
      const query = z
        .object({
          minutes: z.coerce.number().int().min(1).max(60).default(15),
          level: z.enum(["info", "warn", "error"]).optional(),
        })
        .strict()
        .parse(request.query);
      const owned = await target(p.projectId, p.instanceId);
      reply.header("Cache-Control", "no-store");
      if (!clients?.logs) return { state: "not_configured", items: [] };
      try {
        return await clients.logs.read(owned, query.minutes, query.level);
      } catch {
        return { state: "error", items: [] };
      }
    },
  );
  app.get(
    "/v1/projects/:projectId/instances/:instanceId/observability/events",
    async (request, reply) => {
      const p = instanceParams.parse(request.params);
      await auth.projectAccess(request, p.projectId, allRoles);
      z.object({}).strict().parse(request.query);
      const owned = await target(p.projectId, p.instanceId);
      reply.header("Cache-Control", "no-store");
      const result = await pool.query(
        `SELECT id,observed_at AS time,code,details FROM observation_events WHERE project_id=$1 AND instance_uid=$2 AND instance_id=$3 UNION ALL SELECT id,updated_at AS time,kind AS code,jsonb_build_object('state',state,'error_code',error_code,'generation',target_generation,'operation_id',id) AS details FROM operations WHERE project_id=$1 AND instance_id=$3 ORDER BY time DESC LIMIT 101`,
        [p.projectId, owned.instanceUID, p.instanceId],
      );
      const snapshot = await pool.query(
        "SELECT observed_at,payload FROM observation_snapshots WHERE instance_id=$1 AND instance_uid=$2",
        [p.instanceId, owned.instanceUID],
      );
      const row = snapshot.rows[0];
      return {
        state: result.rows.length ? "ok" : "no_data",
        collectionState: !row
          ? "no_data"
          : Date.now() - new Date(row.observed_at).getTime() > 120_000
            ? "stale"
            : (row.payload.eventsCollection ?? "unsupported"),
        truncated: result.rows.length > 100,
        items: result.rows.slice(0, 100),
      };
    },
  );
  app.get(
    "/v1/projects/:projectId/observability/alerts",
    async (request, reply) => {
      const { projectId } = projectParams.parse(request.params);
      await auth.projectAccess(request, projectId, allRoles);
      z.object({}).strict().parse(request.query);
      reply.header("Cache-Control", "no-store");
      if (!clients?.alerts) return { state: "not_configured", items: [] };
      try {
        const alerts = await clients.alerts.read(projectId);
        const bindings = await pool.query(
          "SELECT id,display_name,kubernetes_uid FROM instance_bindings WHERE project_id=$1 AND kubernetes_uid=ANY($2::text[])",
          [projectId, alerts.map((a) => a.instanceUID).filter(Boolean)],
        );
        const byUID = new Map(bindings.rows.map((b) => [b.kubernetes_uid, b]));
        return {
          state: "ok",
          observedAt: new Date().toISOString(),
          items: alerts
            .filter((a) => a.instanceUID && byUID.has(a.instanceUID))
            .map((a) => ({
              ...a,
              instanceId: byUID.get(a.instanceUID)?.id,
              instanceName: byUID.get(a.instanceUID)?.display_name,
            })),
        };
      } catch {
        return { state: "error", items: [] };
      }
    },
  );
  app.post(
    "/v1/projects/:projectId/instances/:instanceId/observability/silences",
    async (request, reply) => {
      const p = instanceParams.parse(request.params);
      const actor = await auth.projectAccess(request, p.projectId, [
        "admin",
        "maintainer",
      ]);
      const body = z
        .object({
          fingerprint: z.string().regex(/^[a-fA-F0-9]{1,128}$/),
          minutes: z.number().int().min(5).max(1440),
        })
        .strict()
        .parse(request.body);
      const owned = await target(p.projectId, p.instanceId);
      if (!clients?.alerts)
        throw new HttpError(503, "Alerting is not configured");
      // Persist the attempt before the external side effect; a lost response is
      // explicitly an unknown result, never a successful audit record.
      const id = randomUUID();
      await pool.query(
        "INSERT INTO audit_events(id,actor_id,project_id,instance_id,action,details) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          actor.id,
          p.projectId,
          p.instanceId,
          "alert.silence.requested",
          body,
        ],
      );
      let result;
      try {
        result = await clients.alerts.silence(
          p.projectId,
          owned.instanceUID,
          body.fingerprint,
          body.minutes,
        );
      } catch {
        throw new HttpError(
          503,
          "Silence outcome unavailable; check active alerts before retrying",
        );
      }
      await pool.query(
        "INSERT INTO audit_events(id,actor_id,project_id,instance_id,action,details) VALUES($1,$2,$3,$4,$5,$6)",
        [
          randomUUID(),
          actor.id,
          p.projectId,
          p.instanceId,
          "alert.silence.created",
          { ...result, requestId: id },
        ],
      );
      return reply.code(201).send(result);
    },
  );
  app.get(
    "/v1/projects/:projectId/observability/alert-history",
    async (request, reply) => {
      const { projectId } = projectParams.parse(request.params);
      await auth.projectAccess(request, projectId, allRoles);
      z.object({}).strict().parse(request.query);
      reply.header("Cache-Control", "no-store");
      const result = await pool.query(
        "SELECT a.fingerprint,a.starts_at,a.ends_at,a.received_at,a.state,a.payload,a.active_confirmed,a.checked_at,i.id AS instance_id,i.display_name FROM observation_alerts a JOIN instance_bindings i ON i.project_id=a.project_id AND i.kubernetes_uid=a.instance_uid WHERE a.project_id=$1 ORDER BY a.received_at DESC LIMIT 101",
        [projectId],
      );
      return {
        state: clients?.webhookToken ? "ok" : "not_configured",
        truncated: result.rows.length > 100,
        items: result.rows.slice(0, 100),
      };
    },
  );
  app.post("/internal/alerts", async (request, reply) => {
    if (!authorizedToken(request.headers.authorization, clients?.webhookToken))
      return reply.code(401).send({ error: "Alert authentication required" });
    const payload = z
      .object({
        alerts: z
          .array(
            z.object({
              status: z.enum(["firing", "resolved"]),
              fingerprint: z.string().regex(/^[a-fA-F0-9]{1,128}$/),
              startsAt: z.iso.datetime({ offset: true }),
              endsAt: z.iso.datetime({ offset: true }),
              labels: z.record(z.string().max(128), z.string().max(512)),
              annotations: z
                .record(z.string().max(128), z.string().max(4096))
                .optional(),
            }),
          )
          .max(50),
      })
      .parse(request.body);
    for (const a of payload.alerts) {
      if (
        a.labels.expbuild_cluster_id !==
        (options.telemetry?.clusterId ?? "primary")
      )
        continue;
      const project = z.string().uuid().safeParse(a.labels.expbuild_project_id),
        uid = z
          .string()
          .regex(/^[a-zA-Z0-9-]{1,63}$/)
          .safeParse(a.labels.expbuild_instance_uid);
      if (!project.success || !uid.success) continue;
      const binding = await pool.query(
        "SELECT id FROM instance_bindings WHERE project_id=$1 AND kubernetes_uid=$2",
        [project.data, uid.data],
      );
      if (!binding.rows.length) continue;
      const summary = {
        name: sanitizeLog(a.labels.alertname ?? "Unknown"),
        severity: ["critical", "warning", "info"].includes(
          a.labels.severity ?? "",
        )
          ? a.labels.severity
          : "warning",
        summary: sanitizeLog(a.annotations?.summary ?? ""),
      };
      await pool.query(
        `INSERT INTO observation_alerts(project_id,instance_uid,fingerprint,starts_at,ends_at,state,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(project_id,instance_uid,fingerprint,starts_at) DO UPDATE SET state=CASE WHEN observation_alerts.state='resolved' THEN 'resolved' ELSE EXCLUDED.state END,ends_at=CASE WHEN EXCLUDED.state='resolved' THEN EXCLUDED.ends_at ELSE observation_alerts.ends_at END,received_at=now(),payload=EXCLUDED.payload`,
        [
          project.data,
          uid.data,
          a.fingerprint,
          a.startsAt,
          a.status === "resolved" ? a.endsAt : null,
          a.status,
          summary,
        ],
      );
    }
    return { ok: true };
  });
}
