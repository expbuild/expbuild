import { t, formatDate, formatNumber } from "./i18n";
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
  TemplateIdentityConflict: "模板名称或版本与平台绑定不一致",
  TemplateVersionUnknown: "平台记录缺少模板版本",
  ResourceReservationUnknown: "资源预留记录未知，需要核对",
  ResourceReservationInsufficient: "实际资源配置超过账面预留",
  ResourceQuantityInvalid: "资源数量无法解析，不能确认预留",
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
export function ResourceInventory({
  base,
  canReconcile = false,
  initiallyOpen = false,
}: {
  base: string;
  canReconcile?: boolean;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen),
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
          setError(e instanceof Error ? e.message : t("对账结果读取失败"));
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
      setError(e instanceof Error ? e.message : t("对账请求失败"));
    } finally {
      setBusy(false);
    }
  }
  async function reconcile(instanceId: string) {
    if (
      !window.confirm(
        t(
          "重新核对实际资源，并只增加该实例的资源预留？如果超出项目额度，后续创建和扩容会被阻止。",
        ),
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(
        base +
          "/instances/" +
          encodeURIComponent(instanceId) +
          "/reservations/reconcile",
        { method: "POST" },
      );
      setScheduled(true);
      setRefresh((x) => x + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("资源预留校正失败"));
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
      <h2>{t("资源对账")}</h2>
      {!open ? (
        <button onClick={() => setOpen(true)}>{t("查看资源对账")}</button>
      ) : (
        <>
          <p className="muted">
            {t(
              "核对平台记录与实际实例、存储卷。发现差异后需检查原因，不会自动删除或接管资源。",
            )}
          </p>
          <button disabled={busy} onClick={() => void schedule()}>
            {busy ? t("提交中…") : t("请求重新对账")}
          </button>
          {scheduled && (
            <p role="status">{t("已安排对账，结果将自动刷新。")}</p>
          )}
          {error && <p role="alert">{error}</p>}
          {!result && !error && <p role="status">{t("等待对账结果…")}</p>}
          {snapshot?.checkedAt && (
            <p className="muted">
              {t("上次核对：")}
              {formatDate(snapshot.checkedAt)}
            </p>
          )}
          {stale && (
            <p role="alert">{t("结果已过期，请重新对账后判断当前状态。")}</p>
          )}
          {result && (
            <>
              <p role="status">
                {result.state === "Healthy"
                  ? stale
                    ? t("上次未发现资源差异")
                    : t("未发现资源差异")
                  : result.state === "Drift"
                    ? t("发现 {value0} 项资源差异", {
                        value0: result.issueCount,
                      })
                    : result.state === "InProgress"
                      ? t("资源正在变化，等待下一次核对")
                      : t("无法完成对账，请检查集群连接或权限")}
              </p>
              {result.counts && (
                <p>
                  {t("已观察 {instances} 个实例资源、{volumes} 个存储卷。", {
                    instances: formatNumber(result.counts.instances),
                    volumes: formatNumber(result.counts.volumes),
                  })}
                </p>
              )}
              {result.busyInstances > 0 && (
                <p>
                  {t("{count} 个实例有进行中的操作，暂缓判断其差异。", {
                    count: formatNumber(result.busyInstances),
                  })}
                </p>
              )}
              {result.issues.length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th>{t("资源")}</th>
                      <th>{t("类型")}</th>
                      <th>{t("差异")}</th>
                      {canReconcile && <th>{t("处理")}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {result.issues.map((issue, index) => (
                      <tr key={index}>
                        <td>{issue.resourceName}</td>
                        <td>
                          {issue.kind === "CacheInstance"
                            ? t("实例")
                            : t("存储卷")}
                        </td>
                        <td>{t(messages[issue.code] ?? issue.code)}</td>
                        {canReconcile && (
                          <td>
                            {issue.instanceId &&
                              !stale &&
                              !result.truncated &&
                              [
                                "ResourceReservationUnknown",
                                "ResourceReservationInsufficient",
                              ].includes(issue.code) &&
                              !result.issues.some(
                                (other) =>
                                  other.instanceId === issue.instanceId &&
                                  ![
                                    "ResourceReservationUnknown",
                                    "ResourceReservationInsufficient",
                                  ].includes(other.code),
                              ) && (
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    void reconcile(issue.instanceId!)
                                  }
                                >
                                  {t("校正资源预留")}
                                </button>
                              )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {result.truncated && (
                <p role="alert">
                  {t("仅显示前 200 项差异，请先处理当前问题再核对。")}
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
