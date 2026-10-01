import { t } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export function RotateCredential({
  base,
  id,
  revision,
  onClose,
  onChange,
  onBusyChange,
}: {
  base: string;
  id: string;
  revision: string;
  onClose: () => void;
  onChange: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(false),
    [credentials, setCredentials] = useState<{
      username: string;
      password: string;
    } | null>(null);
  const attempt = useRef({ key: crypto.randomUUID(), revision });
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  async function rotate() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        credentials?: { username: string; password: string };
      }>(`${base}/instances/${id}/credentials/rotate`, {
        method: "POST",
        headers: {
          "Idempotency-Key": attempt.current.key,
          "If-Match": `"${attempt.current.revision}"`,
        },
      });
      setCredentials(result.credentials ?? null);
      setDone(true);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("轮换提交失败"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="notice">
      <h3>{t("轮换缓存凭据")}</h3>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {done ? (
        <>
          <p>
            {t(
              "轮换已提交，请在操作记录中确认完成。服务切换期间可能短暂中断；完成后旧密码失效。暂停实例将在下次启动时使用新凭据。",
            )}
          </p>
          {credentials ? (
            <>
              <p>{t("请保存新密码，关闭后无法再次查看。")}</p>
              <label>
                {t("新用户名")}
                <input readOnly value={credentials.username} />
              </label>
              <label>
                {t("新密码")}
                <input
                  readOnly
                  value={credentials.password}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </label>
            </>
          ) : (
            <p>
              {t(
                "此操作已提交过，密码不会重复返回。如首次响应丢失，请等待当前操作结束后重新发起轮换。",
              )}
            </p>
          )}
          <div className="actions">
            <button onClick={onClose}>{t("关闭")}</button>
          </div>
        </>
      ) : (
        <>
          <p>
            {t(
              "将生成新密码并滚动重启服务。新配置生效后，旧凭据会被撤销。请准备更新构建工具中的密码。",
            )}
          </p>
          <div className="actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() => void rotate()}
            >
              {t("确认轮换")}
            </button>
            <button disabled={busy} onClick={onClose}>
              {t("取消")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
