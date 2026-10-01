import { randomUUID, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";
import type pg from "pg";

export function validToken(token: string): boolean {
  return (
    token.length >= 32 &&
    token.length <= 8192 &&
    /^[a-zA-Z0-9._~+/-]+=*$/.test(token)
  );
}
export function authorizedToken(
  actual: string | undefined,
  expected: string | undefined,
) {
  if (!expected || !actual) return false;
  const a = Buffer.from(actual),
    b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class Telemetry {
  readonly registry = new Registry();
  readonly requests = new Counter({
    name: "expbuild_api_requests_total",
    help: "Completed management HTTP requests.",
    labelNames: ["route", "method", "status_class"],
    registers: [this.registry],
  });
  readonly duration = new Histogram({
    name: "expbuild_api_request_duration_seconds",
    help: "Management HTTP response duration.",
    labelNames: ["route", "method"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  readonly inflight = new Gauge({
    name: "expbuild_api_requests_in_flight",
    help: "Management requests currently in flight.",
    registers: [this.registry],
  });
  readonly workerRuns = new Counter({
    name: "expbuild_worker_attempts_total",
    help: "Worker polling attempts, not final business operation outcomes.",
    labelNames: ["worker", "outcome"],
    registers: [this.registry],
  });
  readonly workerDuration = new Histogram({
    name: "expbuild_worker_duration_seconds",
    help: "Worker polling duration.",
    labelNames: ["worker"],
    buckets: [0.01, 0.1, 1, 5, 15, 60],
    registers: [this.registry],
  });
  readonly workerSuccess = new Gauge({
    name: "expbuild_worker_last_success_timestamp_seconds",
    help: "Last successful worker poll, including idle polls.",
    labelNames: ["worker"],
    registers: [this.registry],
  });
  readonly workers = new Map<
    string,
    { lastSuccess: string | null; lastFailure: string | null }
  >();
  readonly completedOperations = new Counter({
    name: "expbuild_operation_completions_total",
    help: "Terminal business-operation transitions committed by this worker. Explicit retries may complete again.",
    labelNames: ["kind", "outcome"],
    registers: [this.registry],
  });
  readonly operationDuration = new Histogram({
    name: "expbuild_operation_completion_seconds",
    help: "Time from operation creation to a committed terminal transition, including queueing and retries.",
    labelNames: ["kind", "outcome"],
    buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800],
    registers: [this.registry],
  });
  private readonly queue = new Gauge({
    name: "expbuild_operations_queued",
    help: "Current unfinished operations by kind and state; not attempt counts.",
    labelNames: ["kind", "state"],
    registers: [this.registry],
  });
  private readonly oldest = new Gauge({
    name: "expbuild_operation_oldest_seconds",
    help: "Age since creation of the oldest unfinished operation.",
    labelNames: ["kind", "state"],
    registers: [this.registry],
  });
  private readonly connections = new Gauge({
    name: "expbuild_database_connections",
    help: "Local process database connection pool counts.",
    labelNames: ["state"],
    registers: [this.registry],
  });
  private readonly controlSnapshot = new Gauge({
    name: "expbuild_control_snapshot_timestamp_seconds",
    help: "Time queue and database pool gauges were refreshed.",
    registers: [this.registry],
  });
  constructor(readonly clusterId = "primary") {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(clusterId))
      throw new Error("Invalid observability cluster ID");
    this.registry.setDefaultLabels({ expbuild_cluster_id: clusterId });
    collectDefaultMetrics({ register: this.registry, prefix: "expbuild_api_" });
  }
  async run<T>(
    worker: "operations" | "quotas" | "inventory" | "observability",
    fn: () => Promise<T>,
  ): Promise<T> {
    const stop = this.workerDuration.startTimer({ worker });
    const state = this.workers.get(worker) ?? {
      lastSuccess: null,
      lastFailure: null,
    };
    this.workers.set(worker, state);
    try {
      const result = await fn();
      state.lastSuccess = new Date().toISOString();
      this.workerSuccess.set({ worker }, Date.now() / 1000);
      this.workerRuns.inc({ worker, outcome: "success" });
      return result;
    } catch (error) {
      state.lastFailure = new Date().toISOString();
      this.workerRuns.inc({ worker, outcome: "error" });
      throw error;
    } finally {
      stop();
    }
  }
  async observeControlPlane(pool: pg.Pool) {
    const result = await pool.query(
      "SELECT kind,state,count(*)::int AS count,extract(epoch FROM now()-min(created_at))::float AS age FROM operations WHERE state IN ('pending','applying','reconciling') GROUP BY kind,state",
    );
    this.queue.reset();
    this.oldest.reset();
    for (const row of result.rows) {
      const kind = [
        "project.create",
        "instance.create",
        "instance.update",
        "instance.delete",
        "instance.rotate",
        "instance.reclaim",
        "volume.delete",
      ].includes(row.kind)
        ? row.kind
        : "other";
      this.queue.set({ kind, state: row.state }, row.count);
      this.oldest.set({ kind, state: row.state }, Math.max(0, row.age));
    }
    for (const [state, value] of Object.entries({
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    }))
      this.connections.set({ state }, value);
    this.controlSnapshot.set(Date.now() / 1000);
  }
  attach(app: FastifyInstance, scrapeToken?: string) {
    if (scrapeToken !== undefined && !validToken(scrapeToken))
      throw new Error("Invalid metrics scrape token");
    const starts = new WeakMap<object, number>();
    const finish = (request: object) => {
      if (starts.has(request)) {
        this.inflight.dec();
        starts.delete(request);
      }
    };
    app.addHook("onRequest", async (request, reply) => {
      starts.set(request, performance.now());
      this.inflight.inc();
      reply.header("X-Request-ID", request.id);
    });
    app.addHook("onResponse", async (request, reply) => {
      const seconds = Math.max(
        0,
        (performance.now() - (starts.get(request) ?? performance.now())) / 1000,
      );
      finish(request);
      // Never use the URL: unmatched paths and arbitrary methods have fixed labels.
      const route = request.routeOptions.url ?? "unmatched";
      const method = [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD",
        "OPTIONS",
      ].includes(request.method)
        ? request.method
        : "OTHER";
      if (route !== "/internal/metrics") {
        this.requests.inc({
          route,
          method,
          status_class: `${Math.floor(reply.statusCode / 100)}xx`,
        });
        this.duration.observe({ route, method }, seconds);
      }
      const fields = {
        event: "http.request.completed",
        request_id: request.id,
        route,
        method,
        status: reply.statusCode,
        duration_ms: Math.round(seconds * 1000),
      };
      if (reply.statusCode >= 500) app.log.error(fields, "Request failed");
      else if (!["/healthz", "/readyz", "/internal/metrics"].includes(route))
        app.log.info(fields, "Request completed");
    });
    app.addHook("onRequestAbort", async (request) => finish(request));
    app.get("/internal/metrics", async (request, reply) => {
      if (!authorizedToken(request.headers.authorization, scrapeToken))
        return reply
          .code(401)
          .send({ error: "Metrics authentication required" });
      reply.header("Cache-Control", "no-store").type(this.registry.contentType);
      return this.registry.metrics();
    });
  }
}

export const requestId = () => randomUUID();
