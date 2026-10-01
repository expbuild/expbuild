import { useEffect, useState } from "react";
import { api, operationNames, stateNames } from "./api";
import { t, formatDate, formatNumber } from "./i18n";

type Result = { state?: string; truncated?: boolean };
const sourceNames: Record<string, string> = {
  metrics: "指标历史",
  logs: "运行日志",
  alerts: "当前告警",
  alertHistory: "告警历史",
};
const workerNames: Record<string, string> = {
  operations: "实例操作处理",
  quotas: "项目配额同步",
  inventory: "资源盘点",
  observability: "观测采集",
};
function useObservation<T>(path: string | null, refresh: number) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(false);
  useEffect(() => {
    setData(null);
    setError(false);
    if (!path) return;
    const controller = new AbortController();
    void api<T>(path, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [path, refresh]);
  return { data, error };
}
const stateText: Record<string, string> = {
  ok: "数据正常",
  no_data: "暂无采样",
  stale: "数据已过期",
  unsupported: "此模板不支持",
  not_configured: "尚未配置数据源",
  error: "数据暂时不可用",
  ready: "服务就绪",
  starting: "等待就绪",
  suspended: "已暂停",
  deleting: "删除中",
  unknown: "状态未知",
  truncated: "截断",
  active: "告警中",
  suppressed: "已静默或抑制",
  unprocessed: "等待处理",
  firing: "告警中",
  resolved: "已恢复",
};
function Status({ state }: { state?: string }) {
  return (
    <p className="muted" role="status">
      {t(stateText[state ?? ""] ?? "正在读取观测数据…")}
    </p>
  );
}
function Empty({ data, error }: { data: Result | null; error: boolean }) {
  return (
    <>
      {(!data || data.state !== "ok" || error) && (
        <Status state={error ? "error" : data?.state} />
      )}{" "}
      {data?.truncated && (
        <p role="status">{t("结果已截断，请缩小查询范围。")}</p>
      )}
    </>
  );
}

type Series = { name: string; unit: string; points: [number, number | null][] };
type Metrics = Result & {
  series: Series[];
  observedAt?: string;
  start?: number;
  end?: number;
};
const metricNames: Record<string, string> = {
  used_bytes: "内容用量",
  capacity_bytes: "容量参考值",
  entries: "条目数量",
  cpu_cores: "CPU 用量",
  memory_bytes: "内存用量",
  restarts: "容器重启次数",
  get_hit: "读取命中",
  get_miss: "读取未命中",
  GET_requests: "读取请求速率",
  PUT_requests: "写入请求速率",
  GET_errors: "读取服务错误",
  PUT_errors: "写入服务错误",
  GET_p95: "读取 P95 延迟",
  PUT_p95: "写入 P95 延迟",
};
Object.assign(metricNames, {
  evictions: "容量淘汰速率",
  evicted_bytes: "淘汰字节速率",
  get_hit_ratio: "读取条目命中率",
  read_bytes: "读取流量",
  write_bytes: "写入流量",
  memory_limit_bytes: "内存上限",
  cpu_limit_cores: "CPU 上限",
  throttled_seconds: "CPU 节流",
  volume_used_bytes: "实际卷用量",
  volume_capacity_bytes: "实际卷容量",
});
for (const [kind, label] of [
  ["ac", "AC"],
  ["cas", "CAS"],
])
  for (const [method, verb] of [
    ["get", "读取"],
    ["contains", "存在性查询"],
  ]) {
    for (const [outcome, meaning] of [
      ["hit", "命中"],
      ["miss", "未命中"],
      ["hit_ratio", "命中率"],
    ])
      metricNames[`${kind}_${method}_${outcome}`] =
        `${label} ${verb}${meaning}`;
  }
export function MetricChart({ series }: { series: Series }) {
  const values = series.points.filter(
      (p): p is [number, number] => p[1] !== null,
    ),
    last = values.at(-1);
  const minX = series.points[0]?.[0] ?? 0,
    maxX = series.points.at(-1)?.[0] ?? 1,
    maxY = Math.max(1, ...values.map((p) => p[1]));
  const segments: string[] = [];
  let segment = "";
  for (const [time, value] of series.points) {
    if (value === null) {
      if (segment) segments.push(segment);
      segment = "";
      continue;
    }
    const x = 10 + ((time - minX) / Math.max(1, maxX - minX)) * 380,
      y = 100 - (value / maxY) * 85;
    segment += `${x.toFixed(2)},${y.toFixed(2)} `;
  }
  if (segment) segments.push(segment);
  const label = t(metricNames[series.name] ?? series.name);
  return (
    <article className="metric-chart">
      <div className="metric-chart-heading">
        <strong>{label}</strong>
        <span>
          {last ? formatNumber(last[1], { maximumFractionDigits: 3 }) : "—"}{" "}
          <small>{series.unit}</small>
        </span>
      </div>
      <svg viewBox="0 0 400 120" role="img" aria-label={label}>
        <title>{label}</title>
        <path d="M10 15V100H390" className="chart-axis" />
        {segments.map((points, i) => (
          <polyline
            key={i}
            points={points}
            fill="none"
            className="chart-line"
          />
        ))}
      </svg>
      <div className="chart-times">
        <time>{formatDate(minX * 1000)}</time>
        <time>{formatDate(maxX * 1000)}</time>
      </div>
      <details>
        <summary>{t("查看采样值")}</summary>
        <div className="observation-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("时间")}</th>
                <th>{t("数值")}</th>
              </tr>
            </thead>
            <tbody>
              {series.points
                .slice()
                .reverse()
                .map(([time, value]) => (
                  <tr key={time}>
                    <td>{formatDate(time * 1000)}</td>
                    <td>
                      {value === null
                        ? "—"
                        : formatNumber(value, { maximumFractionDigits: 4 })}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </article>
  );
}
type Events = Result & {
  collectionState?: string;
  items: {
    id: string;
    time: string;
    code: string;
    details: {
      phase?: string;
      state?: string;
      error_code?: string;
      generation?: number;
      kind?: string;
      reason?: string;
      count?: number;
      lastOccurred?: string;
      conditions?: { type: string; status: string; reason: string }[];
    };
  }[];
};
type Logs = Result & { items: { time: string; text: string }[] };
export function InstanceObservability({
  path,
  canEdit,
}: {
  path: string;
  canEdit: boolean;
}) {
  const [tab, setTab] = useState("capacity"),
    [window, setWindow] = useState("1h"),
    [refresh, setRefresh] = useState(0);
  const metrics = useObservation<Metrics>(
    ["capacity", "lookups", "resources", "performance"].includes(tab)
      ? `${path}/observability/metrics?group=${tab}&window=${window}`
      : null,
    refresh,
  );
  const events = useObservation<Events>(
    tab === "events" ? `${path}/observability/events` : null,
    refresh,
  );
  const logs = useObservation<Logs>(
    tab === "logs" && canEdit ? `${path}/observability/logs?minutes=15` : null,
    refresh,
  );
  const tabs = [
    ["capacity", "存储趋势"],
    ["lookups", "缓存效果"],
    ["performance", "请求性能"],
    ["resources", "资源趋势"],
    ["events", "诊断时间线"],
    ...(canEdit ? [["logs", "运行日志"]] : []),
  ];
  return (
    <section className="observation-panel" aria-label={t("实例可观测")}>
      <div className="section-title">
        <h3>{t("实例可观测")}</h3>
        <button onClick={() => setRefresh((x) => x + 1)}>{t("刷新")}</button>
      </div>
      <div
        className="observation-tabs"
        role="tablist"
        aria-label={t("观测视图")}
      >
        {tabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id!)}
          >
            {t(label!)}
          </button>
        ))}
      </div>
      {!["events", "logs"].includes(tab) && (
        <>
          <label>
            {t("时间范围")}
            <select value={window} onChange={(e) => setWindow(e.target.value)}>
              <option value="1h">{t("最近一小时")}</option>
              <option value="6h">{t("最近六小时")}</option>
              <option value="24h">{t("最近一天")}</option>
            </select>
          </label>
          <p className="muted">
            {t(
              "缺失采样保留为空。查询命中与构建任务命中不同；容量参考值可能是引擎预算或申请的卷大小。",
            )}
          </p>
          <Empty {...metrics} />
          {metrics.data?.observedAt && (
            <p className="muted">
              {t("最后返回时间点")} {formatDate(metrics.data.observedAt)}
            </p>
          )}
          <div className="metric-grid">
            {metrics.data?.series.map((s) => (
              <MetricChart key={s.name} series={s} />
            ))}
          </div>
        </>
      )}
      {tab === "events" && (
        <>
          <Empty {...events} />
          {events.data?.collectionState &&
            events.data.collectionState !== "ok" && (
              <p className="muted">
                {t("Kubernetes 事件采集状态")} ·{" "}
                {t(
                  stateText[events.data.collectionState] ??
                    events.data.collectionState,
                )}
              </p>
            )}
          <ol className="observation-timeline">
            {events.data?.items.map((e) => (
              <li key={e.id}>
                <time>{formatDate(e.time)}</time>
                <strong>{e.code}</strong>
                {e.details.kind && (
                  <small>
                    {e.details.kind} · {e.details.reason} · {t("次数")}{" "}
                    {e.details.count}
                  </small>
                )}
                <span>
                  {e.details.phase
                    ? t(stateText[e.details.phase] ?? e.details.phase)
                    : (e.details.state ?? "")}
                </span>
                {e.details.error_code && <code>{e.details.error_code}</code>}
                {e.details.conditions?.map((c) => (
                  <small key={c.type}>
                    {c.type}: {c.status} · {c.reason}
                  </small>
                ))}
              </li>
            ))}
          </ol>
        </>
      )}
      {tab === "logs" && canEdit && (
        <>
          <p className="muted">
            {t(
              "显示最近 15 分钟的运行日志，最多 500 条。日志内容保留原始语言。",
            )}
          </p>
          <Empty {...logs} />
          <div className="observation-logs">
            {logs.data?.items.map((line, i) => (
              <div key={`${line.time}-${i}`}>
                <time>{formatDate(line.time)}</time>
                <pre>{line.text}</pre>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
type Snapshot = {
  id: string;
  display_name: string;
  template_name: string;
  dataState: string;
  observed_at: string | null;
  payload: null | {
    phase: string;
    collection: string;
    statistics: null | {
      usedBytes: number;
      capacityBytes: number;
      itemCount: number;
      source: string;
    };
  };
};
type Overview = {
  observedAt: string;
  total: number;
  covered: number;
  truncated: boolean;
  items: Snapshot[];
};
type Alerts = Result & {
  items: {
    fingerprint: string;
    instanceId: string;
    instanceName: string;
    instanceUID: string;
    name: string;
    severity: string;
    summary: string;
    startsAt: string;
    state: string;
  }[];
};
type AlertHistory = Result & {
  items: {
    active_confirmed?: boolean | null;
    checked_at?: string | null;
    fingerprint: string;
    starts_at: string;
    received_at: string;
    state: string;
    display_name: string;
    payload: { name: string; summary: string };
  }[];
};
export function ProjectObservability({
  base,
  canEdit,
  alertsOnly = false,
}: {
  base: string;
  canEdit: boolean;
  alertsOnly?: boolean;
}) {
  const [refresh, setRefresh] = useState(0),
    [selected, setSelected] = useState(""),
    [action, setAction] = useState(""),
    [busy, setBusy] = useState(false);
  const overview = useObservation<Overview>(
    alertsOnly ? null : `${base}/observability`,
    refresh,
  );
  const alerts = useObservation<Alerts>(
    `${base}/observability/alerts`,
    refresh,
  );
  const history = useObservation<AlertHistory>(
    alertsOnly ? `${base}/observability/alert-history` : null,
    refresh,
  );
  async function silence(alert: Alerts["items"][number]) {
    setBusy(true);
    setAction("");
    try {
      await api(
        `${base}/instances/${alert.instanceId}/observability/silences`,
        {
          method: "POST",
          body: JSON.stringify({ fingerprint: alert.fingerprint, minutes: 60 }),
        },
      );
      setRefresh((x) => x + 1);
      setAction(t("已设置一小时静默。"));
    } catch {
      setAction(t("静默结果暂时无法确认，请刷新告警后检查。"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel"
      aria-label={t(alertsOnly ? "告警中心" : "项目可观测")}
    >
      <div className="section-title">
        <div>
          <h2>{t(alertsOnly ? "告警中心" : "项目可观测")}</h2>
          <p className="muted">{t("服务状态与监控数据状态分别展示。")}</p>
        </div>
        <button onClick={() => setRefresh((x) => x + 1)}>{t("刷新")}</button>
      </div>
      {!alertsOnly && (
        <>
          {overview.error && <Status state="error" />}
          {!overview.data && !overview.error && <Status />}
          {overview.data && (
            <>
              <p>
                {t("有效观测覆盖 {covered} / {total} 个实例", {
                  covered: overview.data.covered,
                  total: overview.data.total,
                })}
              </p>
              {overview.data.truncated && (
                <p>{t("结果已截断，请缩小查询范围。")}</p>
              )}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t("实例")}</th>
                      <th>{t("服务状态")}</th>
                      <th>{t("数据状态")}</th>
                      <th>{t("内容用量")}</th>
                      <th>{t("最后观测")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.data.items.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => setSelected(i.id)}
                          >
                            {i.display_name}
                          </button>
                        </td>
                        <td>
                          {t(
                            stateText[
                              i.dataState === "stale" ||
                              i.dataState === "no_data"
                                ? "unknown"
                                : (i.payload?.phase ?? "unknown")
                            ] ?? "状态未知",
                          )}
                        </td>
                        <td>{t(stateText[i.dataState] ?? "状态未知")}</td>
                        <td>
                          {i.dataState === "ok" && i.payload?.statistics
                            ? `${formatNumber(i.payload.statistics.usedBytes / 1024 ** 3, { maximumFractionDigits: 3 })} GiB`
                            : "—"}
                        </td>
                        <td>{formatDate(i.observed_at ?? "")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
      <h3>{t("当前告警")}</h3>
      <Empty {...alerts} />
      {alerts.data?.state === "ok" && !alerts.data.items.length && (
        <p>{t("当前没有活跃告警。")}</p>
      )}
      {action && <p role="status">{action}</p>}
      <div className="observation-alerts">
        {alerts.data?.items.map((a) => (
          <article key={a.fingerprint} className="observation-alert">
            <div>
              <span
                className={`badge ${a.severity === "critical" ? "failed" : "pending"}`}
              >
                {a.severity}
              </span>{" "}
              <strong>{a.name}</strong>
            </div>
            <p>{a.summary}</p>
            <p className="muted">
              {a.instanceName} · {formatDate(a.startsAt)} ·{" "}
              {t(stateText[a.state] ?? a.state)}
            </p>
            <button onClick={() => setSelected(a.instanceId)}>
              {t("查看实例诊断")}
            </button>
            {canEdit && (
              <button disabled={busy} onClick={() => void silence(a)}>
                {t("静默一小时")}
              </button>
            )}
          </article>
        ))}
      </div>
      {alertsOnly && (
        <>
          <h3>{t("告警历史")}</h3>
          <p className="muted">
            {t("历史只包含已收到的通知，接收中断可能导致记录缺失。")}
          </p>
          <Empty {...history} />
          <ol className="observation-timeline">
            {history.data?.items.map((a) => (
              <li key={`${a.fingerprint}-${a.starts_at}`}>
                <time>{formatDate(a.received_at)}</time>
                <strong>{a.payload.name}</strong>
                <span>
                  {a.display_name} · {t(stateText[a.state] ?? a.state)}
                </span>
                <p>{a.payload.summary}</p>
                {a.state === "firing" && a.active_confirmed === false && (
                  <small>
                    {t("最近核对时已不在活跃列表中，尚未收到恢复通知。")}
                  </small>
                )}
                {a.checked_at && (
                  <small>
                    {t("最后核对")} {formatDate(a.checked_at)}
                  </small>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {selected && (
        <div className="observation-detail">
          <div className="section-title">
            <h3>{t("所选实例")}</h3>
            <button onClick={() => setSelected("")}>{t("关闭")}</button>
          </div>
          <InstanceObservability
            key={selected}
            path={`${base}/instances/${selected}`}
            canEdit={canEdit}
          />
        </div>
      )}
    </section>
  );
}
type Health = {
  observedAt: string;
  clusterId: string;
  database: string;
  workers: Record<
    string,
    { lastSuccess: string | null; lastFailure: string | null }
  >;
  queues: {
    kind: string;
    state: string;
    count: number;
    oldest_seconds: number;
  }[];
  integrations: Record<string, boolean>;
  connections: { total: number; idle: number; waiting: number };
  metricsEndpoint: boolean;
};
export function PlatformHealth() {
  const [refresh, setRefresh] = useState(0);
  const result = useObservation<Health>("/platform/observability", refresh);
  return (
    <section className="panel">
      <div className="section-title">
        <div>
          <h1>{t("平台健康")}</h1>
          <p className="muted">
            {t(
              "管理服务、后台任务和观测数据源。此页面不代表所有缓存实例的可用性。",
            )}
          </p>
        </div>
        <button onClick={() => setRefresh((x) => x + 1)}>{t("刷新")}</button>
      </div>
      {result.error ? (
        <Status state="error" />
      ) : !result.data ? (
        <Status />
      ) : (
        <>
          <p>
            {t("集群")} <strong>{result.data.clusterId}</strong> ·{" "}
            {t("最后观测")} {formatDate(result.data.observedAt)}
          </p>
          <div className="metric-grid">
            <article className="metric-chart">
              <h3>{t("数据库连接")}</h3>
              <strong>{t("连接正常")}</strong>
              <p>
                {t("等待连接数")}{" "}
                {formatNumber(result.data.connections.waiting)}
              </p>
            </article>
            <article className="metric-chart">
              <h3>{t("指标采集端点")}</h3>
              <Status
                state={result.data.metricsEndpoint ? "ok" : "not_configured"}
              />
            </article>
          </div>
          <h3>{t("后台任务")}</h3>
          {!Object.keys(result.data.workers).length && (
            <p className="muted">{t("尚未收到后台任务报告。")}</p>
          )}
          <table>
            <thead>
              <tr>
                <th>{t("任务类型")}</th>
                <th>{t("最后成功")}</th>
                <th>{t("最后失败")}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(result.data.workers).map(([name, state]) => (
                <tr key={name}>
                  <td>{t(workerNames[name] ?? name)}</td>
                  <td>{formatDate(state.lastSuccess ?? "")}</td>
                  <td>{formatDate(state.lastFailure ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>{t("等待中的操作")}</h3>
          {!result.data.queues.length ? (
            <p>{t("当前没有排队操作。")}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t("任务类型")}</th>
                  <th>{t("状态")}</th>
                  <th>{t("数量")}</th>
                  <th>{t("最久等待秒数")}</th>
                </tr>
              </thead>
              <tbody>
                {result.data.queues.map((q) => (
                  <tr key={`${q.kind}-${q.state}`}>
                    <td>{t(operationNames[q.kind] ?? q.kind)}</td>
                    <td>{t(stateNames[q.state] ?? q.state)}</td>
                    <td>{formatNumber(q.count)}</td>
                    <td>
                      {formatNumber(q.oldest_seconds, {
                        maximumFractionDigits: 0,
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3>{t("观测数据源")}</h3>
          <p className="muted">
            {t("已配置表示存在连接配置，不代表数据源当前可用。")}
          </p>
          <div className="metric-grid">
            {Object.entries(result.data.integrations).map(
              ([name, configured]) => (
                <article className="metric-chart" key={name}>
                  <strong>{t(sourceNames[name] ?? name)}</strong>
                  <p>{t(configured ? "已配置" : "尚未配置数据源")}</p>
                </article>
              ),
            )}
          </div>
        </>
      )}
    </section>
  );
}
