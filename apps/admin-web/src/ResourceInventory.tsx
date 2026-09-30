import { useEffect, useState } from "react";
import { api } from "./api";
type Issue = {
  code: string;
  kind: string;
  resourceName: string;
  instanceId: string | null;
};
type Snapshot = {
  checkedAt: string | null;
  result: null | {
    state: "Healthy" | "Drift" | "InProgress" | "Unavailable";
    issues: Issue[];
    issueCount: number;
    truncated: boolean;
    busyInstances: number;
    counts: null | { instances: number; volumes: number };
    error?: string;
  };
};
const messages: Record<string, string> = {
  InstanceIdentityConflict: "实例身份与平台记录不一致",
  InstanceOwnershipConflict: "实例归属标记不一致",
  UnexpectedInstance: "已删除或已分离的实例仍存在",
  UnexpectedInstanceDeletion: "实例正在被外部删除",
  ConfigurationDrift: "实例配置偏离已提交配置",
  MissingInstance: "实例资源丢失",
  ProvisioningIncomplete: "实例尚未完成创建",
  VolumeOwnershipConflict: "存储卷归属不一致",
  ResidualVolume: "已删除实例仍有存储卷",
  VolumeDeletionInProgress: "存储卷正在删除",
  VolumeNotBound: "存储卷未就绪",
  MissingRetainedVolume: "保留卷丢失",
  MissingVolume: "实例存储卷丢失",
  UntrackedInstance: "发现未登记的实例",
  UntrackedVolume: "发现未登记的存储卷",
};
export function ResourceInventory({ base }: { base: string }) {
  const [open, setOpen] = useState(false),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [scheduled, setScheduled] = useState(false);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const value = await api<Snapshot>(base + "/inventory", {
          signal: abort.signal,
        });
        if (!abort.signal.aborted) {
          setSnapshot(value);
          setError("");
        }
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : "对账结果读取失败");
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(read, 10000);
      }
    }
    setSnapshot(null);
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [base, open, refresh]);
  async function schedule() {
    setBusy(true);
    setError("");
    setScheduled(false);
    try {
      await api(base + "/inventory/refresh", { method: "POST" });
      setScheduled(true);
      setRefresh((x) => x + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "对账请求失败");
    } finally {
      setBusy(false);
    }
  }
  const result = snapshot?.result;
  const stale =
    !!snapshot?.checkedAt &&
    Date.now() - Date.parse(snapshot.checkedAt) > 5 * 60000;
  return (
    <section className="panel">
      <h2>资源对账</h2>
      {!open ? (
        <button onClick={() => setOpen(true)}>查看资源对账</button>
      ) : (
        <>
          <p className="muted">
            核对平台记录与实际实例、存储卷。发现差异后需检查原因，不会自动删除或接管资源。
          </p>
          <button disabled={busy} onClick={() => void schedule()}>
            {busy ? "提交中…" : "请求重新对账"}
          </button>
          {scheduled && <p role="status">已安排对账，结果将自动刷新。</p>}
          {error && <p role="alert">{error}</p>}
          {!result && !error && <p role="status">等待对账结果…</p>}
          {snapshot?.checkedAt && (
            <p className="muted">
              上次核对：{new Date(snapshot.checkedAt).toLocaleString()}
            </p>
          )}
          {stale && <p role="alert">结果已过期，请重新对账后判断当前状态。</p>}
          {result && (
            <>
              <p role="status">
                {result.state === "Healthy"
                  ? stale
                    ? "上次未发现资源差异"
                    : "未发现资源差异"
                  : result.state === "Drift"
                    ? `发现 ${result.issueCount} 项资源差异`
                    : result.state === "InProgress"
                      ? "资源正在变化，等待下一次核对"
                      : "无法完成对账，请检查集群连接或权限"}
              </p>
              {result.counts && (
                <p>
                  已观察 {result.counts.instances} 个实例资源、
                  {result.counts.volumes} 个存储卷。
                </p>
              )}
              {result.busyInstances > 0 && (
                <p>
                  {result.busyInstances} 个实例有进行中的操作，暂缓判断其差异。
                </p>
              )}
              {result.issues.length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th>资源</th>
                      <th>类型</th>
                      <th>差异</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.issues.map((issue, index) => (
                      <tr key={index}>
                        <td>{issue.resourceName}</td>
                        <td>
                          {issue.kind === "CacheInstance" ? "实例" : "存储卷"}
                        </td>
                        <td>{messages[issue.code] ?? issue.code}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {result.truncated && (
                <p role="alert">
                  仅显示前 200 项差异，请先处理当前问题再核对。
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
