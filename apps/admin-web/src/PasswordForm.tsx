import { t } from "./i18n";
import { useState, type FormEvent } from "react";
import { api } from "./api";

export function PasswordForm({
  target,
  onClose,
  onChanged,
}: {
  target?: { id: string; email: string };
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form);
    setError("");
    if (data.get("password") !== data.get("confirm")) {
      setError(t("两次输入的新密码不一致。"));
      return;
    }
    setBusy(true);
    try {
      await api(target ? `/users/${target.id}/password` : "/auth/password", {
        method: "POST",
        body: JSON.stringify({
          password: data.get("password"),
          ...(!target ? { currentPassword: data.get("currentPassword") } : {}),
        }),
      });
      form.reset();
      setDone(true);
      if (!target) {
        sessionStorage.removeItem("expbuild-csrf");
        onChanged?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("密码变更失败"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>
        {target
          ? t("重置 {value0} 的密码", { value0: target.email })
          : t("修改我的密码")}
      </h2>
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}
      {done ? (
        <>
          <p role="status">
            {t("密码已更新，旧会话已撤销。请使用新密码重新登录。")}
          </p>
          <button onClick={onClose}>{t("关闭")}</button>
        </>
      ) : (
        <form onSubmit={submit}>
          <p className="muted">
            {t("更新后，该账号所有设备上的登录会话都会失效。")}
          </p>
          <div className="form-grid">
            {!target && (
              <label>
                {t("当前密码")}
                <input
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
            )}
            <label>
              {t("新密码")}
              <input
                name="password"
                type="password"
                minLength={12}
                maxLength={1024}
                autoComplete="new-password"
                required
              />
            </label>
            <label>
              {t("确认新密码")}
              <input
                name="confirm"
                type="password"
                minLength={12}
                maxLength={1024}
                autoComplete="new-password"
                required
              />
            </label>
          </div>
          <div className="actions">
            <button className="primary" disabled={busy}>
              {busy ? t("正在更新…") : t("确认更新密码")}
            </button>
            <button type="button" disabled={busy} onClick={onClose}>
              {t("取消")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
