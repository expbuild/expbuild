import { useEffect, useState } from "react";
import { api } from "./api";
type Snapshot = {
  observedAt: string;
  usedBytes: number;
  capacityBytes: number;
  itemCount: number;
  reservedBytes: number | null;
};
const size = (bytes: number) =>
  `${(bytes / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB`;
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
        setData(value);
        setError("");
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : "统计暂不可用");
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
  if (!running) return <p className="muted">实例未运行，实时统计不可用。</p>;
  return (
    <section aria-label="实例统计">
      <h3>缓存容量</h3>
      {error && (
        <p role="status" className="notice">
          统计采集暂不可用。{data ? "以下保留最近一次结果。" : "暂无有效数据。"}
        </p>
      )}
      {data ? (
        <>
          <div className="detail-grid">
            <p>
              已使用<strong>{size(data.usedBytes)}</strong>
            </p>
            <p>
              引擎容量<strong>{size(data.capacityBytes)}</strong>
            </p>
            <p>
              缓存条目<strong>{data.itemCount.toLocaleString()}</strong>
            </p>
          </div>
          <progress
            aria-label="缓存容量使用率"
            max={data.capacityBytes}
            value={data.usedBytes}
          />
          <p className="muted">
            采集于 {new Date(data.observedAt).toLocaleString()} · 已预留{" "}
            {data.reservedBytes === null ? "未知" : size(data.reservedBytes)}
            。这是引擎缓存统计，不代表整个存储卷的使用量。
          </p>
        </>
      ) : (
        !error && <p role="status">正在采集统计…</p>
      )}
    </section>
  );
}
