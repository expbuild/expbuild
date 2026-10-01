import { randomUUID } from "node:crypto";
import type pg from "pg";
import { Gauge } from "prom-client";
import type { KubernetesPort, DiagnosticEvents } from "./kubernetes.js";
import type { CacheObject } from "./instance-contract.js";
import type { InstanceStatistics } from "./statistics.js";
import { instanceCapabilities } from "./template-catalog.js";
import type { Telemetry } from "./telemetry.js";

export type Snapshot = {
  phase: "ready" | "starting" | "suspended" | "deleting" | "unknown";
  collection: "ok" | "error" | "unsupported" | "suspended";
  generation: number | null;
  conditions: {
    type: string;
    status: string;
    reason: string;
    current: boolean;
  }[];
  statistics: InstanceStatistics | null;
  eventsCollection?: "ok" | "truncated" | "error" | "unsupported";
};
const code = (s: string) => (/^[a-zA-Z0-9_.-]{1,100}$/.test(s) ? s : "Unknown");
export function ownedSnapshot(
  object: CacheObject,
  binding: {
    id: string;
    project_id: string;
    kubernetes_uid: string;
    template_name: string;
    template_version: string;
    namespace: string;
    resource_name: string;
  },
): Snapshot {
  if (
    object.metadata.uid !== binding.kubernetes_uid ||
    object.spec.instanceId !== binding.id ||
    object.spec.projectId !== binding.project_id ||
    object.metadata.namespace !== binding.namespace ||
    object.metadata.name !== binding.resource_name ||
    object.spec.templateRef.name !== binding.template_name ||
    object.spec.templateRef.version !== binding.template_version
  )
    throw new Error("Observation ownership conflict");
  const conditions = (object.status?.conditions ?? [])
    .slice(0, 20)
    .map((c) => ({
      type: code(c.type),
      status: ["True", "False", "Unknown"].includes(c.status)
        ? c.status
        : "Unknown",
      reason: code(c.reason),
      current: c.observedGeneration === object.metadata.generation,
    }));
  const suspended = object.spec.desiredState === "Suspended";
  return {
    phase: object.metadata.deletionTimestamp
      ? "deleting"
      : suspended
        ? "suspended"
        : conditions.some(
              (c) => c.type === "Ready" && c.status === "True" && c.current,
            )
          ? "ready"
          : "starting",
    collection: suspended ? "suspended" : "unsupported",
    generation: object.metadata.generation ?? null,
    conditions,
    statistics: null,
  };
}

// One latest snapshot per instance, never a time-series database. Prometheus
// scrapes bounded current gauges independently of console traffic.
export class ObservationCollector {
  private cursor = "00000000-0000-0000-0000-000000000000";
  private lastCleanup = 0;
  private leader?: pg.PoolClient;
  private readonly lostLeadership = () => {
    const client = this.leader;
    this.leader = undefined;
    this.samples.clear();
    this.cursor = "00000000-0000-0000-0000-000000000000";
    client?.release(true);
  };
  private readonly gauges: Record<string, Gauge> = {};
  private readonly samples = new Map<
    string,
    { at: number; labels: Record<string, string>; snapshot: Snapshot }
  >();
  constructor(
    private readonly pool: pg.Pool,
    private readonly kube: KubernetesPort & {
      readStatistics(object: CacheObject): Promise<InstanceStatistics>;
    },
    telemetry: Telemetry,
  ) {
    const collector = this;
    new Gauge({
      name: "expbuild_observation_collector_leader",
      help: "This process holds the database session lock for background instance collection.",
      registers: [telemetry.registry],
      collect() {
        this.set(collector.leader ? 1 : 0);
      },
    });
    const definitions: Record<string, string> = {
      snapshot_timestamp_seconds: "Time the owned instance state was observed.",
      statistics_timestamp_seconds:
        "Time the engine produced its statistics sample.",
      ready: "Current-generation protocol readiness reported by the operator.",
      expected_running: "Whether the observed instance is expected to run.",
      statistics_available:
        "Whether a valid engine statistics sample is available.",
      used_bytes:
        "Logical cache or scanned content bytes; not physical volume usage.",
      capacity_bytes:
        "Engine budget or requested volume size, distinguished by source.",
      entries: "Cache entries or scanned content files.",
    };
    for (const [name, help] of Object.entries(definitions)) {
      const collector = this;
      this.gauges[name] = new Gauge({
        name: `expbuild_instance_${name}`,
        help,
        labelNames: ["expbuild_project_id", "expbuild_instance_uid", "source"],
        registers: [telemetry.registry],
        collect() {
          this.reset();
          for (const sample of collector.samples.values()) {
            if (Date.now() - sample.at > 120_000) continue;
            const s = sample.snapshot,
              stats = s.statistics;
            const values: Record<string, number | undefined> = {
              snapshot_timestamp_seconds: sample.at / 1000,
              statistics_timestamp_seconds: stats
                ? Date.parse(stats.observedAt) / 1000
                : undefined,
              ready: s.phase === "ready" ? 1 : 0,
              expected_running: ["ready", "starting"].includes(s.phase) ? 1 : 0,
              statistics_available:
                s.collection === "unsupported" || s.collection === "suspended"
                  ? undefined
                  : s.collection === "ok"
                    ? 1
                    : 0,
              used_bytes: stats?.usedBytes,
              capacity_bytes: stats?.capacityBytes,
              entries: stats?.itemCount,
            };
            const value = values[name];
            if (value !== undefined && Number.isFinite(value))
              this.set(sample.labels, value);
          }
        },
      });
    }
  }
  async tick() {
    if (!this.leader) {
      const candidate = await this.pool.connect();
      try {
        const lock = await candidate.query(
          "SELECT pg_try_advisory_lock(73942106) AS acquired",
        );
        if (!lock.rows[0].acquired) {
          candidate.release();
          return false;
        }
        this.leader = candidate;
        candidate.on("error", this.lostLeadership);
      } catch (error) {
        candidate.release(true);
        throw error;
      }
    }
    const client = this.leader;
    try {
      // Keep the session lock across batches and idle periods. The same process
      // owns the in-memory scrape view until failover, rather than mixing replicas.
      await client.query("SELECT 1");
      const result = await client.query(
        `SELECT i.*,p.namespace FROM instance_bindings i JOIN projects p ON p.id=i.project_id WHERE i.kubernetes_uid IS NOT NULL AND i.lifecycle IN ('active','deleting') AND i.id>$1 ORDER BY i.id LIMIT 20`,
        [this.cursor],
      );
      if (!result.rows.length) {
        this.cursor = "00000000-0000-0000-0000-000000000000";
      }
      for (let start = 0; start < result.rows.length; start += 4) {
        const batch = await Promise.all(
          result.rows.slice(start, start + 4).map(async (binding) => {
            let snapshot: Snapshot = {
              phase: "unknown",
              collection: "error",
              eventsCollection: "error",
              generation: null,
              conditions: [],
              statistics: null,
            };
            let events: DiagnosticEvents | undefined;
            try {
              const object = await this.kube.getInstance(
                binding.namespace,
                binding.resource_name,
              );
              if (object) {
                snapshot = ownedSnapshot(object, binding);
                snapshot.eventsCollection = "unsupported";
                if (this.kube.readDiagnosticEvents) {
                  try {
                    events = await this.kube.readDiagnosticEvents(object);
                    snapshot.eventsCollection = events.state;
                  } catch {
                    snapshot.eventsCollection = "error";
                  }
                }
                if (
                  ["ready", "starting"].includes(snapshot.phase) &&
                  instanceCapabilities(
                    binding.template_name,
                    binding.template_version,
                  )?.statistics
                ) {
                  try {
                    snapshot.statistics =
                      await this.kube.readStatistics(object);
                    snapshot.collection = "ok";
                  } catch {
                    snapshot.collection = "error";
                  }
                }
              }
            } catch {
              /* Unknown is not an unavailable service. */
            }
            return { binding, snapshot, events };
          }),
        );
        for (const { binding, snapshot, events } of batch)
          await this.save(client, binding, snapshot, events);
      }
      if (result.rows.length) this.cursor = result.rows.at(-1).id;
      const cutoff = Date.now() - 120_000;
      for (const [key, sample] of this.samples)
        if (sample.at < cutoff) this.samples.delete(key);
      if (Date.now() - this.lastCleanup > 3600_000) {
        await client.query(
          "DELETE FROM observation_events WHERE id IN (SELECT id FROM observation_events WHERE observed_at < now()-interval '30 days' ORDER BY observed_at LIMIT 1000)",
        );
        await client.query(
          "DELETE FROM observation_alerts WHERE ctid IN (SELECT ctid FROM observation_alerts WHERE received_at < now()-interval '30 days' AND state='resolved' LIMIT 1000)",
        );
        this.lastCleanup = Date.now();
      }
      return result.rows.length === 20;
    } catch (error) {
      if (this.leader === client) this.lostLeadership();
      throw error;
    }
  }
  async close() {
    const client = this.leader;
    this.leader = undefined;
    this.samples.clear();
    if (!client) return;
    client.removeListener("error", this.lostLeadership);
    try {
      await client.query("SELECT pg_advisory_unlock(73942106)");
      client.release();
    } catch {
      client.release(true);
    }
  }
  private async save(
    client: pg.PoolClient,
    binding: { id: string; project_id: string; kubernetes_uid: string },
    snapshot: Snapshot,
    events?: DiagnosticEvents,
  ) {
    const at = new Date();
    try {
      await client.query("BEGIN");
      // Serialize against deletion/rebinding; a stale collector cannot publish
      // state for a replacement instance or keep a deleted target alive.
      const current = await client.query(
        "SELECT kubernetes_uid,lifecycle FROM instance_bindings WHERE id=$1 FOR UPDATE",
        [binding.id],
      );
      if (
        current.rows[0]?.kubernetes_uid !== binding.kubernetes_uid ||
        !["active", "deleting"].includes(current.rows[0]?.lifecycle)
      ) {
        await client.query("ROLLBACK");
        this.samples.delete(binding.id);
        return;
      }
      const old = await client.query(
        "SELECT payload,instance_uid FROM observation_snapshots WHERE instance_id=$1",
        [binding.id],
      );
      const signature = (s: Snapshot) =>
        JSON.stringify([
          s.phase,
          s.generation,
          s.conditions
            .map((c) => [c.type, c.status, c.reason, c.current])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ]);
      if (
        !old.rows[0] ||
        old.rows[0].instance_uid !== binding.kubernetes_uid ||
        signature(old.rows[0].payload) !== signature(snapshot)
      ) {
        await client.query(
          "INSERT INTO observation_events(id,project_id,instance_id,instance_uid,code,details) VALUES($1,$2,$3,$4,$5,$6)",
          [
            randomUUID(),
            binding.project_id,
            binding.id,
            binding.kubernetes_uid,
            "instance.observed",
            {
              phase: snapshot.phase,
              generation: snapshot.generation,
              conditions: snapshot.conditions,
            },
          ],
        );
      }
      for (const event of events?.items ?? [])
        await client.query(
          `INSERT INTO observation_events(id,project_id,instance_id,instance_uid,code,details,source_uid) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(instance_uid,source_uid) WHERE source_uid IS NOT NULL DO UPDATE SET observed_at=now(),details=EXCLUDED.details WHERE observation_events.details IS DISTINCT FROM EXCLUDED.details`,
          [
            randomUUID(),
            binding.project_id,
            binding.id,
            binding.kubernetes_uid,
            `kubernetes.${event.reason}`,
            event,
            event.uid,
          ],
        );
      // Keep at most 1,000 diagnostic changes per instance as well as the
      // time-based retention; event storms cannot grow history without bound.
      await client.query(
        "DELETE FROM observation_events WHERE instance_id=$1 AND id IN (SELECT id FROM observation_events WHERE instance_id=$1 ORDER BY observed_at DESC,id DESC OFFSET 1000)",
        [binding.id],
      );
      await client.query(
        "INSERT INTO observation_snapshots(instance_id,project_id,instance_uid,observed_at,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(instance_id) DO UPDATE SET instance_uid=EXCLUDED.instance_uid,observed_at=EXCLUDED.observed_at,payload=EXCLUDED.payload",
        [binding.id, binding.project_id, binding.kubernetes_uid, at, snapshot],
      );
      await client.query("COMMIT");
      if (
        this.leader === client &&
        (this.samples.size < 10_000 || this.samples.has(binding.id))
      )
        this.samples.set(binding.id, {
          at: at.getTime(),
          labels: {
            expbuild_project_id: binding.project_id,
            expbuild_instance_uid: binding.kubernetes_uid,
            source: snapshot.statistics?.source ?? "operator-status",
          },
          snapshot,
        });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}
