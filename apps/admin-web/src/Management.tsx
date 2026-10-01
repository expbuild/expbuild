import { t, formatDate } from "./i18n";
import { useEffect, useState, type FormEvent } from "react";
import { PasswordForm } from "./PasswordForm";
import { api, type User } from "./api";

const message = (e: unknown) =>
  e instanceof Error ? e.message : t("请求失败");
type Account = User & { active: boolean };
type Member = { id: string; email: string; role: string };
type Audit = {
  id: string;
  actor_id: string | null;
  action: string;
  details: Record<string, unknown>;
  created_at: string;
};
const roles: Record<string, string> = {
  admin: "管理员",
  maintainer: "维护者",
  viewer: "只读",
};
function useRows<T>(path: string) {
  const [rows, setRows] = useState<T[]>([]),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    api<{ items: T[] }>(path, { signal: abort.signal })
      .then((x) => {
        setRows(x.items);
        setError("");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [path, revision]);
  return { rows, error, loading, reload: () => setRevision((x) => x + 1) };
}
function ErrorBox({ text }: { text: string }) {
  return text ? (
    <div role="alert" className="alert">
      {t(text)}
    </div>
  ) : null;
}

export function UsersPanel({ actor }: { actor: User }) {
  const { rows, error, loading, reload } = useRows<Account>("/users");
  const [mutationError, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<Account | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<Account | null>(null);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form);
    setBusy(true);
    setError("");
    try {
      await api("/users", {
        method: "POST",
        body: JSON.stringify({
          email: data.get("email"),
          password: data.get("password"),
        }),
      });
      form.reset();
      reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function toggle(account: Account) {
    setBusy(true);
    setError("");
    try {
      await api(`/users/${account.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !account.active }),
      });
      setConfirm(null);
      reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">{t("平台管理")}</p>
          <h1>{t("用户管理")}</h1>
          <p className="muted">
            {t("创建账号，再按项目分配权限。停用账号会立即撤销登录会话。")}
          </p>
        </div>
      </header>
      <ErrorBox text={mutationError || error} />
      <section className="panel">
        <h2>{t("创建用户")}</h2>
        <form onSubmit={create}>
          <div className="form-grid">
            <label>
              {t("用户邮箱")}
              <input name="email" type="email" autoComplete="off" required />
            </label>
            <label>
              {t("初始密码")}
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={1024}
                required
              />
            </label>
          </div>
          <p className="muted">
            {t("初始密码至少 12 字符，请通过安全渠道交给账号使用者。")}
          </p>
          <button className="primary" disabled={busy}>
            {t("创建账号")}
          </button>
        </form>
      </section>
      <section className="panel">
        <div className="section-title">
          <h2>{t("用户列表")}</h2>
          <button onClick={reload} disabled={loading}>
            {t("刷新")}
          </button>
        </div>
        {loading && <p role="status">{t("正在加载…")}</p>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("邮箱")}</th>
                <th>{t("平台身份")}</th>
                <th>{t("状态")}</th>
                <th>{t("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((account) => (
                <tr key={account.id}>
                  <td>{account.email}</td>
                  <td>
                    {account.platform_admin ? t("平台管理员") : t("普通用户")}
                  </td>
                  <td>{account.active ? t("已启用") : t("已停用")}</td>
                  <td>
                    <button
                      disabled={busy || account.id === actor.id}
                      onClick={() =>
                        account.active
                          ? setConfirm(account)
                          : void toggle(account)
                      }
                    >
                      {account.active ? t("停用") : t("启用")}
                    </button>
                    <button
                      disabled={busy || account.id === actor.id}
                      onClick={() => setPasswordTarget(account)}
                    >
                      {t("重置密码")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {passwordTarget && (
        <PasswordForm
          key={passwordTarget.id}
          target={passwordTarget}
          onClose={() => setPasswordTarget(null)}
        />
      )}
      {confirm && (
        <section className="panel">
          <h2>{t("停用账号")}</h2>
          <p>
            {t(
              "确认停用 {email}？该账号的会话将立即失效。唯一项目管理员必须先移交权限。",
              { email: confirm.email },
            )}
          </p>
          <div className="actions">
            <button
              className="danger"
              disabled={busy}
              onClick={() => void toggle(confirm)}
            >
              {t("确认停用")}
            </button>
            <button disabled={busy} onClick={() => setConfirm(null)}>
              {t("取消")}
            </button>
          </div>
        </section>
      )}
    </>
  );
}

export function Members({ base }: { base: string }) {
  const { rows, error, reload, loading } = useRows<Member>(`${base}/members`),
    [mutationError, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [remove, setRemove] = useState<Member | null>(null);
  async function write(path: string, method: string, body?: object) {
    setBusy(true);
    setError("");
    try {
      await api(path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      setRemove(null);
      reload();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form);
    if (
      await write(`${base}/members`, "POST", {
        email: data.get("email"),
        role: data.get("role"),
      })
    )
      form.reset();
  }
  return (
    <>
      <ErrorBox text={mutationError || error} />
      <p className="muted">
        {t(
          "按邮箱添加已有账号。管理员管理成员及凭据；维护者配置实例；只读成员查看状态。",
        )}
      </p>
      <form onSubmit={add} className="inline-form">
        <label>
          {t("成员邮箱")}
          <input name="email" type="email" required />
        </label>
        <label>
          {t("项目角色")}
          <select name="role" defaultValue="viewer">
            {Object.entries(roles).map(([value, label]) => (
              <option key={value} value={value}>
                {t(label)}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={busy}>
          {t("添加成员")}
        </button>
      </form>
      {loading && <p role="status">{t("正在加载…")}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("邮箱")}</th>
              <th>{t("角色")}</th>
              <th>{t("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((member) => (
              <tr key={member.id}>
                <td>{member.email}</td>
                <td>
                  <select
                    aria-label={t("{value0} 的角色", { value0: member.email })}
                    value={member.role}
                    disabled={busy}
                    onChange={(e) =>
                      void write(`${base}/members/${member.id}`, "PUT", {
                        role: e.target.value,
                      })
                    }
                  >
                    {Object.entries(roles).map(([value, label]) => (
                      <option key={value} value={value}>
                        {t(label)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => setRemove(member)}
                  >
                    {t("移除")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {remove && (
        <div className="notice">
          <p>
            {t("移除 {email} 对此项目的访问权限？", { email: remove.email })}
          </p>
          <div className="actions">
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void write(`${base}/members/${remove.id}`, "DELETE")
              }
            >
              {t("确认移除")}
            </button>
            <button disabled={busy} onClick={() => setRemove(null)}>
              {t("取消")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function AuditLog({ base }: { base: string }) {
  const { rows, error, reload, loading } = useRows<Audit>(`${base}/audit`);
  const actions: Record<string, string> = {
    "project.create": t("创建项目"),
    "project.retry": t("重试项目初始化"),
    "member.update": t("更新成员权限"),
    "member.remove": t("移除成员"),
    "instance.create": t("创建实例"),
    "instance.update": t("更新实例"),
    "instance.delete": t("删除实例"),
    "volume.delete": t("清理保留卷"),
    "credential.rotate": t("轮换凭据"),
    "operation.succeeded": t("操作完成"),
    "operation.failed": t("操作失败"),
    "operation.retry": t("恢复操作检查"),
    "operation.superseded": t("操作被替代"),
  };
  return (
    <>
      <ErrorBox text={error} />
      <p className="muted">{t("最近 100 条记录；系统操作以“系统”显示。")}</p>
      <button onClick={reload} disabled={loading}>
        {t("刷新记录")}
      </button>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("时间")}</th>
              <th>{t("事件")}</th>
              <th>{t("操作者")}</th>
              <th>{t("详情")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((event) => (
              <tr key={event.id}>
                <td>{formatDate(event.created_at)}</td>
                <td>{actions[event.action] ?? event.action}</td>
                <td>{event.actor_id ?? t("系统")}</td>
                <td>
                  <code>{JSON.stringify(event.details)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !rows.length && <p>{t("暂无审计记录")}</p>}
    </>
  );
}
