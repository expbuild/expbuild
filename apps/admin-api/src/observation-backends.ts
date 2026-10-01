import { z } from "zod";

export type Target = {
  projectId: string;
  instanceUID: string;
  namespace: string;
  template: string;
  version: string;
};
export const observationWindow = z.enum(["1h", "6h", "24h"]);
export type Window = z.infer<typeof observationWindow>;
export type Group = "capacity" | "lookups" | "resources" | "performance";
const identity = z.string().regex(/^[a-zA-Z0-9-]{1,63}$/);
export const bounds = (window: Window, now = Date.now()) => {
  const [seconds, step] = {
    "1h": [3600, 60],
    "6h": [21600, 120],
    "24h": [86400, 300],
  }[window] as [number, number];
  const end = Math.floor(now / 1000 / step) * step;
  return { start: end - seconds, end, step };
};
export class Backend {
  private readonly url: URL;
  private readonly token?: string;
  private active = 0;
  constructor(
    address: string,
    token?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.url = new URL(address);
    if (
      !["http:", "https:"].includes(this.url.protocol) ||
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash
    )
      throw new Error("Invalid observability backend URL");
    if (!this.url.pathname.endsWith("/")) this.url.pathname += "/";
    if (
      token !== undefined &&
      (!token.length ||
        token.length > 8192 ||
        !/^[a-zA-Z0-9._~+/-]+=*$/.test(token))
    )
      throw new Error("Invalid observability backend token");
    this.token = token;
  }
  async request(
    path: string,
    params?: Record<string, string>,
    payload?: unknown,
  ): Promise<unknown> {
    if (this.active >= 8) throw new Error("Observation query limit reached");
    this.active++;
    try {
      const url = new URL(path, this.url);
      if (params) url.search = new URLSearchParams(params).toString();
      const response = await this.fetcher(url, {
        method: payload === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          Accept: "application/json",
          ...(payload === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("Observation backend unavailable");
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1024 * 1024) throw new Error("Observation response limit");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      this.active--;
    }
  }
}
export function selector(target: Target, cluster: string) {
  return `expbuild_cluster_id="${identity.parse(cluster)}",expbuild_project_id="${identity.parse(target.projectId)}",expbuild_instance_uid="${identity.parse(target.instanceUID)}"`;
}
const matrix = z.object({
  status: z.literal("success"),
  warnings: z.array(z.string()).max(0).optional(),
  data: z.object({
    resultType: z.literal("matrix"),
    result: z
      .array(
        z.object({
          metric: z.record(z.string(), z.string().max(150)),
          values: z
            .array(z.tuple([z.number().finite(), z.string().max(64)]))
            .max(361),
        }),
      )
      .max(20),
  }),
});
export class ObservationMetrics {
  constructor(
    private readonly backend: Backend,
    readonly cluster = "primary",
  ) {
    identity.parse(cluster);
  }
  async read(target: Target, group: Group, window: Window) {
    const select = selector(target, this.cluster),
      range = bounds(window);
    const descriptors: Record<string, { query: string; unit: string }> = {};
    if (group === "capacity") {
      for (const [name, unit] of [
        ["used_bytes", "bytes"],
        ["capacity_bytes", "bytes"],
        ["entries", "entries"],
      ] as const)
        descriptors[name] = {
          query: `max(expbuild_instance_${name}{${select}} and on(expbuild_cluster_id,expbuild_project_id,expbuild_instance_uid,source) (expbuild_instance_statistics_timestamp_seconds{${select}} > time()-120))`,
          unit,
        };
      if (target.template === "gradle-http" && target.version === "0.2.0") {
        descriptors.evictions = {
          query: `sum(rate(expbuild_cache_evictions_total{${select}}[5m]))`,
          unit: "entries/second",
        };
        descriptors.evicted_bytes = {
          query: `sum(rate(expbuild_cache_evicted_bytes_total{${select}}[5m]))`,
          unit: "bytes/second",
        };
      }
    } else if (group === "lookups") {
      if (target.template === "bazel-remote" && target.version === "0.1.0") {
        for (const kind of ["ac", "cas"])
          for (const method of ["get", "contains"])
            for (const outcome of ["hit", "miss"])
              descriptors[`${kind}_${method}_${outcome}`] = {
                query: `sum(rate(bazel_remote_incoming_requests_total{${select},kind="${kind}",method="${method}",status="${outcome}"}[5m]))`,
                unit: "lookups/second",
              };
      } else if (
        target.template === "gradle-http" &&
        target.version === "0.2.0"
      ) {
        for (const outcome of ["hit", "miss"])
          descriptors[`get_${outcome}`] = {
            query: `sum(rate(expbuild_cache_lookups_total{${select},outcome="${outcome}"}[5m]))`,
            unit: "lookups/second",
          };
      }
      for (const name of Object.keys(descriptors).filter((n) =>
        n.endsWith("_hit"),
      )) {
        const hit = descriptors[name]!.query,
          miss = descriptors[name.replace(/_hit$/, "_miss")]!.query;
        descriptors[`${name}_ratio`] = {
          query: `100 * (${hit}) / (((${hit}) + (${miss})) > 0)`,
          unit: "percent",
        };
      }
    } else if (group === "resources") {
      const ns = identity.parse(target.namespace),
        uid = identity.parse(target.instanceUID);
      // kube-state-metrics must allowlist the trusted instance UID Pod label.
      // Keep the join at each historical instant, not against today's Pod names.
      const pods = `max by(namespace,pod) (kube_pod_labels{namespace="${ns}",label_cache_expbuild_io_instance_uid="${uid}",expbuild_cluster_id="${this.cluster}"})`;
      descriptors.cpu_cores = {
        query: `sum(max by(namespace,pod,container)(rate(container_cpu_usage_seconds_total{namespace="${ns}",container!="",container!="POD",expbuild_cluster_id="${this.cluster}"}[5m])) * on(namespace,pod) group_left() ${pods})`,
        unit: "cores",
      };
      descriptors.memory_bytes = {
        query: `sum(max by(namespace,pod,container)(container_memory_working_set_bytes{namespace="${ns}",container!="",container!="POD",expbuild_cluster_id="${this.cluster}"}) * on(namespace,pod) group_left() ${pods})`,
        unit: "bytes",
      };
      descriptors.restarts = {
        query: `sum(max by(namespace,pod,container)(kube_pod_container_status_restarts_total{namespace="${ns}",expbuild_cluster_id="${this.cluster}"}) * on(namespace,pod) group_left() ${pods})`,
        unit: "restarts",
      };
      descriptors.memory_limit_bytes = {
        query: `sum(max by(namespace,pod,container)(kube_pod_container_resource_limits{namespace="${ns}",resource="memory",unit="byte",expbuild_cluster_id="${this.cluster}"}) * on(namespace,pod) group_left() ${pods})`,
        unit: "bytes",
      };
      descriptors.cpu_limit_cores = {
        query: `sum(max by(namespace,pod,container)(kube_pod_container_resource_limits{namespace="${ns}",resource="cpu",unit="core",expbuild_cluster_id="${this.cluster}"}) * on(namespace,pod) group_left() ${pods})`,
        unit: "cores",
      };
      descriptors.throttled_seconds = {
        query: `sum(max by(namespace,pod,container)(rate(container_cpu_cfs_throttled_seconds_total{namespace="${ns}",container!="",container!="POD",expbuild_cluster_id="${this.cluster}"}[5m])) * on(namespace,pod) group_left() ${pods})`,
        unit: "seconds/second",
      };
      const volumes = `max by(namespace,persistentvolumeclaim) (kube_persistentvolumeclaim_labels{namespace="${ns}",label_cache_expbuild_io_instance_uid="${uid}",expbuild_cluster_id="${this.cluster}"})`;
      for (const name of ["used_bytes", "capacity_bytes"])
        descriptors[`volume_${name}`] = {
          query: `max(kubelet_volume_stats_${name}{namespace="${ns}",expbuild_cluster_id="${this.cluster}"} * on(namespace,persistentvolumeclaim) group_left() ${volumes})`,
          unit: "bytes",
        };
    } else if (
      target.template === "gradle-http" &&
      target.version === "0.2.0"
    ) {
      for (const method of ["GET", "PUT"]) {
        descriptors[`${method}_requests`] = {
          query: `sum(rate(expbuild_cache_requests_total{${select},method="${method}"}[5m]))`,
          unit: "requests/second",
        };
        descriptors[`${method}_errors`] = {
          query: `sum(rate(expbuild_cache_requests_total{${select},method="${method}",status_class="5xx"}[5m]))`,
          unit: "requests/second",
        };
        descriptors[`${method}_p95`] = {
          query: `histogram_quantile(0.95,sum by(le)(rate(expbuild_cache_request_duration_seconds_bucket{${select},method="${method}"}[5m])))`,
          unit: "seconds",
        };
      }
      for (const direction of ["read", "write"])
        descriptors[`${direction}_bytes`] = {
          query: `sum(rate(expbuild_cache_transfer_bytes_total{${select},direction="${direction}"}[5m]))`,
          unit: "bytes/second",
        };
    }
    if (!Object.keys(descriptors).length)
      return {
        state: "unsupported",
        source: "prometheus",
        group,
        ...range,
        series: [],
      };
    if (group === "lookups" || group === "performance") {
      const anchor =
        target.template === "bazel-remote"
          ? "bazel_remote_incoming_requests_total"
          : group === "lookups"
            ? "expbuild_cache_lookups_total"
            : "expbuild_cache_requests_total";
      for (const descriptor of Object.values(descriptors))
        descriptor.query = `(${descriptor.query}) and on() (max(timestamp(${anchor}{${select}})) > time()-120)`;
    }
    const query = Object.entries(descriptors)
      .map(
        ([name, d]) => `label_replace((${d.query}),"series","${name}","","")`,
      )
      .join(" or ");
    const data = matrix.parse(
      await this.backend.request("api/v1/query_range", {
        query,
        start: String(range.start),
        end: String(range.end),
        step: String(range.step),
        timeout: "4s",
      }),
    );
    const names = new Set<string>();
    let latest = 0;
    const series = data.data.result.map((s) => {
      const name = s.metric.series;
      if (
        !name ||
        !descriptors[name] ||
        names.has(name) ||
        Object.keys(s.metric).some((k) => k !== "series")
      )
        throw new Error("Unexpected metric series");
      names.add(name);
      let previous = range.start - 1;
      const points = s.values.map(([time, raw]): [number, number | null] => {
        if (
          time < range.start ||
          time > range.end ||
          time <= previous ||
          (time - range.start) % range.step !== 0
        )
          throw new Error("Invalid metric timestamp");
        previous = time;
        if (["NaN", "+Inf", "-Inf"].includes(raw)) return [time, null];
        const value = Number(raw);
        if (!raw.trim() || !Number.isFinite(value) || value < 0)
          throw new Error("Invalid metric value");
        latest = Math.max(latest, time);
        return [time, value];
      });
      // Range-query results omit absent evaluation points. Make the gaps
      // explicit so clients cannot connect a line through a collection outage.
      const byTime = new Map(points);
      const complete: [number, number | null][] = [];
      for (let time = range.start; time <= range.end; time += range.step)
        complete.push([time, byTime.get(time) ?? null]);
      return { name, unit: descriptors[name].unit, points: complete };
    });
    return {
      state: !latest
        ? "no_data"
        : latest < range.end - range.step * 2
          ? "stale"
          : "ok",
      source: "prometheus",
      group,
      ...range,
      observedAt: latest ? new Date(latest * 1000).toISOString() : null,
      series,
    };
  }
}

export function sanitizeLog(value: string) {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s",;]+/gi, "$1 [redacted]")
    .replace(
      /((?:password|token|authorization|cookie|secret|credential)[\w-]*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
      "$1[redacted]",
    )
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .slice(0, 4096);
}
const logResult = z.object({
  status: z.literal("success"),
  data: z.object({
    resultType: z.literal("streams"),
    result: z
      .array(
        z.object({
          stream: z.record(z.string(), z.string()),
          values: z
            .array(
              z.tuple([z.string().regex(/^\d{10,25}$/), z.string().max(65536)]),
            )
            .max(1001),
        }),
      )
      .max(100),
  }),
});
export class ObservationLogs {
  constructor(
    private readonly backend: Backend,
    private readonly cluster = "primary",
  ) {}
  async read(target: Target, minutes: number, level?: string) {
    const end = Date.now(),
      start = end - minutes * 60_000;
    const query = `{${selector(target, this.cluster)}}${level ? ` | json | level="${z.enum(["info", "warn", "error"]).parse(level)}"` : ""}`;
    const data = logResult.parse(
      await this.backend.request("loki/api/v1/query_range", {
        query,
        start: `${start}000000`,
        end: `${end}000000`,
        limit: "501",
        direction: "backward",
      }),
    );
    const lines = data.data.result
      .flatMap((s) => {
        if (
          s.stream.expbuild_cluster_id !== this.cluster ||
          s.stream.expbuild_project_id !== target.projectId ||
          s.stream.expbuild_instance_uid !== target.instanceUID
        )
          throw new Error("Log ownership mismatch");
        return s.values.map(([time, text]) => ({
          time: new Date(Number(BigInt(time) / 1000000n)).toISOString(),
          text: sanitizeLog(text),
        }));
      })
      .sort((a, b) => b.time.localeCompare(a.time));
    if (
      lines.some(
        (line) => Date.parse(line.time) < start || Date.parse(line.time) > end,
      )
    )
      throw new Error("Log timestamp outside query");
    return {
      state: lines.length ? "ok" : "no_data",
      source: "loki",
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      truncated: lines.length > 500,
      items: lines.slice(0, 500),
    };
  }
}

const alertSchema = z.object({
  fingerprint: z.string().regex(/^[a-fA-F0-9]{1,128}$/),
  labels: z.record(z.string(), z.string().max(512)),
  annotations: z.record(z.string(), z.string().max(4096)).optional(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  status: z
    .object({
      state: z.enum(["unprocessed", "active", "suppressed"]),
      silencedBy: z.array(z.string()).optional(),
    })
    .optional(),
});
export type ObservedAlert = z.infer<typeof alertSchema>;
export class ObservationAlerts {
  constructor(
    private readonly backend: Backend,
    readonly cluster = "primary",
  ) {}
  async read(projectId: string, uid?: string) {
    identity.parse(projectId);
    identity.parse(this.cluster);
    if (uid) identity.parse(uid);
    // Alertmanager supports repeated filters; use a single regex-free identity
    // filter upstream and validate every returned identity before returning data.
    const result = z
      .array(alertSchema)
      .max(500)
      .parse(
        await this.backend.request("api/v2/alerts", {
          filter: `expbuild_project_id="${projectId}"`,
          active: "true",
          silenced: "true",
          inhibited: "true",
        }),
      );
    return result
      .filter(
        (a) =>
          a.labels.expbuild_project_id === projectId &&
          a.labels.expbuild_cluster_id === this.cluster &&
          (!uid || a.labels.expbuild_instance_uid === uid),
      )
      .map((a) => ({
        fingerprint: a.fingerprint,
        instanceUID: a.labels.expbuild_instance_uid ?? null,
        name: code(a.labels.alertname),
        severity: ["critical", "warning", "info"].includes(
          a.labels.severity ?? "",
        )
          ? a.labels.severity
          : "warning",
        summary: sanitizeLog(a.annotations?.summary ?? ""),
        startsAt: a.startsAt,
        endsAt: a.endsAt,
        state: a.status?.state ?? "active",
      }));
  }
  async silence(
    projectId: string,
    uid: string,
    fingerprint: string,
    minutes: number,
  ) {
    const match = (await this.read(projectId, uid)).find(
      (a) => a.fingerprint === fingerprint,
    );
    if (!match) throw new Error("Alert no longer active");
    const now = Date.now();
    // No user-provided matchers, creator strings or templates are forwarded.
    return z.object({ silenceID: z.string().uuid() }).parse(
      await this.backend.request("api/v2/silences", undefined, {
        matchers: Object.entries({
          expbuild_cluster_id: this.cluster,
          expbuild_project_id: projectId,
          expbuild_instance_uid: uid,
          alertname: match.name,
        }).map(([name, value]) => ({
          name,
          value,
          isRegex: false,
          isEqual: true,
        })),
        startsAt: new Date(now).toISOString(),
        endsAt: new Date(now + minutes * 60_000).toISOString(),
        createdBy: "expbuild",
        comment: "Project-scoped maintenance window",
      }),
    );
  }
}
function code(value: string | undefined) {
  return value && /^[a-zA-Z0-9_:-]{1,128}$/.test(value) ? value : "Unknown";
}
