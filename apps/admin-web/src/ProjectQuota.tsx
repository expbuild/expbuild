import { t, formatDate, formatNumber } from "./i18n";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";

const fields = {
  instances: "实例数",
  storageGiB: "存储（GiB）",
  cpuMillis: "CPU（毫核）",
  memoryMiB: "内存（MiB）",
};
type Key = keyof typeof fields;
type Limits = Record<Key, number | null>;
type Snapshot = {
  limits: Limits;
  reserved: Record<Key, number>;
  unknownReservations: number;
  revision: string;
  synchronization?: {
    state: "Pending" | "Applied" | "Failed";
    observedRevision: string | null;
    checkedAt: string | null;
    error: string | null;
  };
};
const keys = Object.keys(fields) as Key[];
export function ProjectQuota({
  base,
  canEdit,
  initiallyOpen = false,
}: {
  base: string;
  canEdit: boolean;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen),
    [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Record<Key, string>>({
    instances: "",
    storageGiB: "",
    cpuMillis: "",
    memoryMiB: "",
  });
  const [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  function accept(value: Snapshot) {
    setSnapshot(value);
    setDraft(
      Object.fromEntries(
        keys.map((key) => [
          key,
          value.limits[key] === null ? "" : String(value.limits[key]),
        ]),
      ) as Record<Key, string>,
    );
  }
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setSaved(false);
    setSnapshot(null);
    api<Snapshot>(base + "/quota", { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) accept(value);
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : t("配额读取失败"));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [base, open, refresh]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!snapshot || loading || saving) return;
    const limits = Object.fromEntries(
      keys.map((key) => [
        key,
        draft[key].trim() === "" ? null : Number(draft[key]),
      ]),
    ) as Limits;
    if (
      Object.values(limits).some(
        (value) =>
          value !== null &&
          (!Number.isSafeInteger(value) || value < 0 || value > 2147483647),
      )
    ) {
      setError(t("配额请输入 0 到 2147483647 的整数，或留空表示不限。"));
      return;
    }
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      accept(
        await api<Snapshot>(base + "/quota", {
          method: "PUT",
          headers: { "If-Match": snapshot.revision },
          body: JSON.stringify(limits),
        }),
      );
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("保存失败"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="panel">
      <h2>{t("项目配额")}</h2>
      {!open ? (
        <button onClick={() => setOpen(true)}>{t("查看项目配额")}</button>
      ) : (
        <>
          <p className="muted">
            {t(
              "额度按已受理的配置预留，并非实时用量。暂停实例仍占用额度，保留卷继续占用存储。",
            )}
          </p>
          <button
            type="button"
            disabled={loading || saving}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {t("刷新配额")}
          </button>
          {loading && <p role="status">{t("正在读取配额…")}</p>}
          {error && (
            <p role="alert">
              {error}
              {t("可刷新后核对当前配额再操作。")}
            </p>
          )}
          {saved && <p role="status">{t("配额已保存")}</p>}
          {snapshot && (
            <>
              <p role="status">
                {t("集群硬配额：")}
                {snapshot.synchronization?.state === "Applied" &&
                snapshot.synchronization.observedRevision === snapshot.revision
                  ? t("已同步")
                  : snapshot.synchronization?.state === "Failed"
                    ? t("同步失败，后台会重试")
                    : t("待同步")}
              </p>
              {snapshot.synchronization?.checkedAt && (
                <p className="muted">
                  {t("最近核对：")}
                  {formatDate(snapshot.synchronization.checkedAt)}
                </p>
              )}
              {snapshot.unknownReservations > 0 && (
                <p role="alert">
                  {t("有 {count} 个资源预留待核对，已知预留不代表完整用量。", {
                    count: formatNumber(snapshot.unknownReservations),
                  })}
                </p>
              )}
              <table>
                <thead>
                  <tr>
                    <th>{t("资源")}</th>
                    <th>{t("已知预留")}</th>
                    <th>{t("上限")}</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <tr key={key}>
                      <th>{t(fields[key])}</th>
                      <td>{formatNumber(snapshot.reserved[key])}</td>
                      <td>
                        {snapshot.limits[key] === null
                          ? t("不限")
                          : formatNumber(snapshot.limits[key])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {canEdit ? (
                <form onSubmit={save}>
                  <p>
                    {t(
                      "留空表示不限，0 表示不允许预留。上限不能低于已有预留。",
                    )}
                  </p>
                  {keys.map((key) => (
                    <label key={key}>
                      {t("{resource}上限", { resource: t(fields[key]) })}
                      <input
                        type="number"
                        min="0"
                        max="2147483647"
                        step="1"
                        value={draft[key]}
                        disabled={saving}
                        onChange={(e) =>
                          setDraft((current) => ({
                            ...current,
                            [key]: e.target.value,
                          }))
                        }
                      />
                    </label>
                  ))}
                  <button type="submit" disabled={saving || loading}>
                    {saving ? t("保存中…") : t("保存配额")}
                  </button>
                </form>
              ) : (
                <p className="muted">{t("配额由平台管理员调整。")}</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
