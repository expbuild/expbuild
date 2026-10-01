import { t, formatDate, formatNumber } from "./i18n";
import { useEffect, useState } from "react";
import { api } from "./api";
type Series = {
  kind: "ac" | "cas";
  method: "get" | "contains";
  outcome: "hit" | "miss";
  points: [number, number | null][];
};
type History = {
  series: Series[];
  start: number;
  end: number;
  rateWindowSeconds: number;
};
export function LookupHistory({ path }: { path: string }) {
  const [open, setOpen] = useState(false),
    [window, setWindow] = useState("1h");
  const [kind, setKind] = useState("cas"),
    [method, setMethod] = useState("get");
  const [data, setData] = useState<History | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    setData(null);
    setError("");
    if (!open) return;
    const abort = new AbortController();
    void api<History>(`${path}/statistics/history?window=${window}`, {
      signal: abort.signal,
    })
      .then((value) => {
        if (!abort.signal.aborted) setData(value);
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : t("历史统计不可用"));
      });
    return () => abort.abort();
  }, [path, window, open]);
  const selected =
    data?.series.filter((s) => s.kind === kind && s.method === method) ?? [];
  const hits = new Map(selected.find((s) => s.outcome === "hit")?.points ?? []);
  const misses = new Map(
    selected.find((s) => s.outcome === "miss")?.points ?? [],
  );
  const times = [...new Set([...hits.keys(), ...misses.keys()])].sort(
    (a, b) => b - a,
  );
  const value = (n: number | null | undefined) =>
    n == null ? "—" : formatNumber(n, { maximumFractionDigits: 3 });
  return (
    <section aria-label={t("缓存查询历史")}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? t("收起查询历史") : t("查看查询历史")}
      </button>
      {open && (
        <>
          <h3>{t("缓存查询历史")}</h3>
          <p className="muted">
            {t(
              "每秒查询次数，使用五分钟窗口平均。读取和存在性检查分别统计，不能代表构建命中率。缺少数据时显示空缺。",
            )}
          </p>
          <label>
            {t("时间范围")}
            <select value={window} onChange={(e) => setWindow(e.target.value)}>
              <option value="1h">{t("最近一小时")}</option>
              <option value="6h">{t("最近六小时")}</option>
              <option value="24h">{t("最近一天")}</option>
            </select>
          </label>
          <label>
            {t("缓存类型")}
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="cas">{t("CAS 内容缓存")}</option>
              <option value="ac">{t("AC 动作缓存")}</option>
            </select>
          </label>
          <label>
            {t("查询类型")}
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="get">{t("读取")}</option>
              <option value="contains">
                {t("存在性检查（含 FindMissing）")}
              </option>
            </select>
          </label>
          {error && (
            <p role="status">
              {t("历史统计暂不可用，需要管理员配置 Prometheus 及实例采集。")}
              {error}
            </p>
          )}
          {!error && !data && <p role="status">{t("正在读取历史统计…")}</p>}
          {data &&
            (times.length ? (
              <div style={{ maxHeight: "24rem", overflow: "auto" }}>
                <table>
                  <caption>{t("查询速率（次/秒），最新记录在前")}</caption>
                  <thead>
                    <tr>
                      <th>{t("时间")}</th>
                      <th>{t("命中")}</th>
                      <th>{t("未命中")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {times.map((time) => (
                      <tr key={time}>
                        <td>{formatDate(time * 1000)}</td>
                        <td>{value(hits.get(time))}</td>
                        <td>{value(misses.get(time))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p role="status">
                {t("此范围暂无有效采样，不表示查询次数为零。")}
              </p>
            ))}
        </>
      )}
    </section>
  );
}
