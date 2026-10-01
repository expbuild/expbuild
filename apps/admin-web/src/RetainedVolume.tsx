import { t } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { api, type Operation } from "./api";

export type Volume = {
  name: string;
  namespace: string;
  uid: string;
  capacity: string;
  allocatedCapacity: string;
  storageClass: string;
  phase: string;
  deleting: boolean;
};
export function RetainedVolume({
  path,
  canAdmin,
  onChange,
  onReclaim,
  failed = false,
}: {
  path: string;
  canAdmin: boolean;
  onChange: () => void;
  onReclaim?: (volume: Volume) => void;
  failed?: boolean;
}) {
  const [volume, setVolume] = useState<Volume | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [refresh, setRefresh] = useState(0);
  const key = useRef(crypto.randomUUID());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const abort = new AbortController();
    setVolume(null);
    setError("");
    void api<Volume>(path, { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setVolume(value);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [path, refresh]);
  useEffect(() => {
    if (
      !operation ||
      ["succeeded", "failed", "superseded"].includes(operation.state)
    )
      return;
    const abort = new AbortController();
    const base = path.split("/instances/")[0];
    const timer = setTimeout(() => {
      void api<Operation>(`${base}/operations/${operation.id}`, {
        signal: abort.signal,
      })
        .then((value) => {
          if (abort.signal.aborted) return;
          setOperation(value);
          setError("");
          if (value.state === "succeeded") onChangeRef.current();
        })
        .catch((e) => {
          if (!abort.signal.aborted) {
            setError(e.message);
            setOperation({ ...operation });
          }
        });
    }, 3000);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [path, operation]);
  async function remove() {
    if (!volume || busy || operation || confirm !== volume.name) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ operation: Operation }>(path, {
        method: "DELETE",
        headers: { "If-Match": volume.uid, "Idempotency-Key": key.current },
      });
      setOperation(result.operation);
      onChangeRef.current();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("清理提交失败"));
    } finally {
      setBusy(false);
    }
  }
  function reload() {
    key.current = crypto.randomUUID();
    setOperation(null);
    setConfirm("");
    setRefresh((x) => x + 1);
  }
  return (
    <div className="notice">
      <h3>{t("保留的存储卷")}</h3>
      <p>
        {failed
          ? t(
              "操作失败后先核对原实例与存储卷；只在原实例已不存在且卷归属验证通过时继续处理。",
            )
          : t("实例已删除，存储卷可能仍占用容量和产生存储费用。")}
        {t(
          "清理会删除卷声明；底层数据按存储系统的回收策略处理，平台不保证可恢复。",
        )}
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {volume && (
        <p>
          {volume.name} · {volume.capacity} · {volume.storageClass} ·{" "}
          {volume.deleting ? t("正在删除") : volume.phase}
        </p>
      )}
      {operation ? (
        <>
          <p role="status">
            {operation.state === "succeeded"
              ? t("存储卷声明已清理。")
              : operation.state === "failed" || operation.state === "superseded"
                ? t("清理失败：{value0}", {
                    value0: operation.error_code ?? operation.state,
                  })
                : t("清理请求已接受，等待结果。")}
          </p>
          {["failed", "superseded"].includes(operation.state) && (
            <button onClick={reload}>{t("重新检查存储卷")}</button>
          )}
        </>
      ) : volume && canAdmin ? (
        <>
          {onReclaim && !volume.deleting && volume.phase === "Bound" && (
            <button onClick={() => onReclaim(volume)}>
              {t("使用保留卷恢复实例")}
            </button>
          )}
          <label>
            {t("输入卷名确认清理")}
            <input
              aria-label={t("输入卷名确认清理")}
              value={confirm}
              disabled={busy}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <button
            className="danger"
            disabled={busy || volume.deleting || confirm !== volume.name}
            onClick={() => void remove()}
          >
            {busy ? t("正在提交…") : t("永久清理保留卷")}
          </button>
        </>
      ) : !volume && error ? (
        <button onClick={reload}>{t("重新检查存储卷")}</button>
      ) : null}
      {!canAdmin && <p>{t("仅项目管理员可以恢复或清理保留卷。")}</p>}
    </div>
  );
}
