import { z } from "zod";

export const historyWindow = z.enum(["1h", "6h", "24h"]);
export type HistoryWindow = z.infer<typeof historyWindow>;
export type HistoryTarget = { projectId: string; instanceUID: string };
export type History = {
  source: "prometheus";
  metric: "cache-lookups";
  window: HistoryWindow;
  start: number;
  end: number;
  stepSeconds: number;
  rateWindowSeconds: number;
  series: {
    kind: "ac" | "cas";
    method: "get" | "contains";
    outcome: "hit" | "miss";
    points: [number, number | null][];
  }[];
};
export interface HistoryReader {
  read(target: HistoryTarget, window: HistoryWindow): Promise<History>;
}
const label = z.string().regex(/^[a-zA-Z0-9-]{1,63}$/);
const matrix = z.object({
  status: z.literal("success"),
  warnings: z.array(z.string()).max(0).optional(),
  data: z.object({
    resultType: z.literal("matrix"),
    result: z
      .array(
        z.object({
          metric: z
            .object({
              kind: z.enum(["ac", "cas"]),
              method: z.enum(["get", "contains"]),
              status: z.enum(["hit", "miss"]),
            })
            .strict(),
          values: z
            .array(z.tuple([z.number().finite(), z.string().max(64)]))
            .max(300),
        }),
      )
      .max(8),
  }),
});

// Only deployment configuration supplies the URL. Callers never supply PromQL,
// metric names or label selectors. External collectors must attach these labels.
export class PrometheusHistory implements HistoryReader {
  private readonly base: URL;
  #authorization?: string;
  constructor(
    address: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now = () => Date.now(),
    options: { bearerToken?: string } = {},
  ) {
    if (options.bearerToken !== undefined) {
      if (options.bearerToken.length > 8192 || !/^[a-zA-Z0-9._~+/-]+=*$/.test(options.bearerToken))
        throw new Error("Invalid Prometheus bearer token");
      this.#authorization = `Bearer ${options.bearerToken}`;
    }
    this.base = new URL(address);
    if (
      !["http:", "https:"].includes(this.base.protocol) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash
    )
      throw new Error("Invalid Prometheus URL");
    if (!this.base.pathname.endsWith("/")) this.base.pathname += "/";
  }
  async read(target: HistoryTarget, window: HistoryWindow): Promise<History> {
    const project = label.parse(target.projectId),
      uid = label.parse(target.instanceUID);
    historyWindow.parse(window);
    const [seconds, step] = (
      { "1h": [3600, 60], "6h": [21600, 120], "24h": [86400, 300] } as const
    )[window];
    const end = Math.floor(this.now() / 1000 / step) * step,
      start = end - seconds;
    const url = new URL("api/v1/query_range", this.base);
    const query = `sum by (kind, method, status) (rate(bazel_remote_incoming_requests_total{expbuild_project_id="${project}",expbuild_instance_uid="${uid}",kind=~"ac|cas",method=~"get|contains",status=~"hit|miss"}[5m]))`;
    url.search = new URLSearchParams({
      query,
      start: String(start),
      end: String(end),
      step: String(step),
      timeout: "4s",
    }).toString();
    const response = await this.fetcher(url, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json", ...(this.#authorization ? { Authorization: this.#authorization } : {}) },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("History unavailable");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 1024 * 1024) throw new Error("History response too large");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const data = matrix.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    const keys = new Set<string>();
    const series = data.data.result.map(({ metric, values }) => {
      const key = `${metric.kind}/${metric.method}/${metric.status}`;
      if (keys.has(key)) throw new Error("Duplicate history series");
      keys.add(key);
      let previous = start - 1;
      const points: [number, number | null][] = values.map(([time, raw]) => {
        if (time < start || time > end || time <= previous)
          throw new Error("Invalid history timestamp");
        previous = time;
        if (["NaN", "+Inf", "-Inf"].includes(raw)) return [time, null];
        if (!raw.trim()) throw new Error("Invalid history value");
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0)
          throw new Error("Invalid history rate");
        return [time, value];
      });
      return {
        kind: metric.kind,
        method: metric.method,
        outcome: metric.status,
        points,
      };
    });
    return {
      source: "prometheus",
      metric: "cache-lookups",
      window,
      start,
      end,
      stepSeconds: step,
      rateWindowSeconds: 300,
      series,
    };
  }
}
