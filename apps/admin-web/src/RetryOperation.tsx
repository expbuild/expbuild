import { t } from "./i18n";
import { useRef, useState } from "react";
import { api, type Operation } from "./api";

export function RetryOperation({
  base,
  operation,
  onChange,
}: {
  base: string;
  operation: Operation;
  onChange: () => void;
}) {
  const key = useRef(crypto.randomUUID());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (busy || accepted) return;
    setBusy(true);
    setError("");
    try {
      await api(`${base}/operations/${operation.id}/retry`, {
        method: "POST",
        headers: { "Idempotency-Key": key.current },
      });
      setAccepted(true);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("恢复提交失败"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {accepted ? (
        <p role="status">{t("恢复请求已接受，请查看操作状态。")}</p>
      ) : confirming ? (
        <div className="notice">
          <p>
            {operation.kind === "instance.delete"
              ? t(
                  "继续删除原实例并清理凭据，按原删除操作已记录的策略处理存储卷。此操作不会撤销删除；存在后续操作时无法恢复。",
                )
              : ["instance.create", "instance.reclaim"].includes(
                    operation.kind,
                  ) && operation.target_generation == null
                ? t(
                    "查找并核对这次创建留下的实例。只恢复配置和归属完全匹配的已有资源；资源不存在时不会重新创建，也不会生成新密码。",
                  )
                : t(
                    "继续检查已提交配置的运行结果。不会重新创建实例、重置配置或生成新密码；存在后续操作时无法恢复。",
                  )}
          </p>
          <div className="actions">
            <button disabled={busy} onClick={() => void submit()}>
              {busy
                ? t("正在提交…")
                : operation.kind === "instance.delete"
                  ? t("确认继续删除")
                  : t("确认恢复")}
            </button>
            <button disabled={busy} onClick={() => setConfirming(false)}>
              {t("取消")}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setConfirming(true)}>
          {operation.kind === "instance.delete" ? t("继续删除") : t("恢复检查")}
        </button>
      )}
    </div>
  );
}
