import { t, formatDate, formatNumber } from "./i18n";
import { useEffect, useState } from "react";
import { api } from "./api";
type Snapshot = {
  source?: "bazel-remote-status" | "webdav-content-scan" | "gradle-http-status";
  observedAt: string;
  usedBytes: number;
  capacityBytes: number;
  itemCount: number;
  reservedBytes: number | null;
  requestCounts?: {
    getHits: number;
    getMisses: number;
    putSuccess: number;
    putRejected: number;
  };
};
const size = (bytes: number) =>
  `${formatNumber(bytes / 1024 ** 3, { maximumFractionDigits: 2 })} GiB`;
export function Statistics({
  path,
  running,
}: {
  path: string;
  running: boolean;
}) {
  const [data, setData] = useState<Snapshot | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    setData(null);
    setError("");
    if (!running) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const value = await api<Snapshot>(`${path}/statistics`, {
          signal: abort.signal,
        });
        if (!abort.signal.aborted) {
          setData(value);
          setError("");
        }
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : t("统计暂不可用"));
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(load, 10000);
      }
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [path, running]);
  if (!running)
    return <p className="muted">{t("实例未运行，实时统计不可用。")}</p>;
  return (
    <section aria-label={t("实例统计")}>
      <h3>{t("缓存容量")}</h3>
      {error && (
        <p role="status" className="notice">
          {t("统计采集暂不可用。")}
          {data ? t("以下保留最近一次结果。") : t("暂无有效数据。")}
        </p>
      )}
      {data ? (
        <>
          <div className="detail-grid">
            <p>
              {t("已使用")}
              <strong>{size(data.usedBytes)}</strong>
            </p>
            <p>
              {data.source === "webdav-content-scan"
                ? t("申请卷容量")
                : t("引擎容量")}
              <strong>{size(data.capacityBytes)}</strong>
            </p>
            <p>
              {data.source === "webdav-content-scan"
                ? t("文件条目")
                : t("缓存条目")}
              <strong>{formatNumber(data.itemCount)}</strong>
            </p>
          </div>
          <progress
            aria-label={t("缓存容量使用率")}
            max={data.capacityBytes}
            value={data.usedBytes}
          />
          {data.source === "gradle-http-status" && data.requestCounts && (
            <div className="detail-grid">
              <p>
                {t("GET 命中")}
                <strong>{formatNumber(data.requestCounts.getHits)}</strong>
              </p>
              <p>
                {t("GET 缺失")}
                <strong>{formatNumber(data.requestCounts.getMisses)}</strong>
              </p>
              <p>
                {t("PUT 成功")}
                <strong>{formatNumber(data.requestCounts.putSuccess)}</strong>
              </p>
              <p>
                {t("PUT 拒绝")}
                <strong>{formatNumber(data.requestCounts.putRejected)}</strong>
              </p>
            </div>
          )}
          <p className="muted">
            {t("采集于 {time}。", { time: formatDate(data.observedAt) })}
            {data.source === "webdav-content-scan"
              ? t(
                  "内容目录扫描是近似快照；申请卷容量不保证是底层存储硬上限，也不代表缓存命中率。",
                )
              : data.source === "gradle-http-status"
                ? t(
                    "请求计数从当前进程启动时累计；归档用量不代表整个存储卷使用量，GET 命中也不等同于构建任务命中率。",
                  )
                : t(
                    "已预留 {size}。这是引擎缓存统计，不代表整个存储卷的使用量。",
                    {
                      size:
                        data.reservedBytes === null
                          ? t("未知")
                          : size(data.reservedBytes),
                    },
                  )}
          </p>
        </>
      ) : (
        !error && <p role="status">{t("正在采集统计…")}</p>
      )}
    </section>
  );
}
