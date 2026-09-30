import { useEffect, useState, type FormEvent } from "react";
import { PasswordForm } from "./PasswordForm";
import { api, type User } from "./api";

const message = (e: unknown) => (e instanceof Error ? e.message : "请求失败");
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
      {text}
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
          <p className="eyebrow">平台管理</p>
          <h1>用户管理</h1>
          <p className="muted">
            创建账号，再按项目分配权限。停用账号会立即撤销登录会话。
          </p>
        </div>
      </header>
      <ErrorBox text={mutationError || error} />
      <section className="panel">
        <h2>创建用户</h2>
        <form onSubmit={create}>
          <div className="form-grid">
            <label>
              用户邮箱
              <input name="email" type="email" autoComplete="off" required />
            </label>
            <label>
              初始密码
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
            初始密码至少 12 字符，请通过安全渠道交给账号使用者。
          </p>
          <button className="primary" disabled={busy}>
            创建账号
          </button>
        </form>
      </section>
      <section className="panel">
        <div className="section-title">
          <h2>用户列表</h2>
          <button onClick={reload} disabled={loading}>
            刷新
          </button>
        </div>
        {loading && <p role="status">正在加载…</p>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>邮箱</th>
                <th>平台身份</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((account) => (
                <tr key={account.id}>
                  <td>{account.email}</td>
                  <td>{account.platform_admin ? "平台管理员" : "普通用户"}</td>
                  <td>{account.active ? "启用" : "停用"}</td>
                  <td>
                    <button
                      disabled={busy || account.id === actor.id}
                      onClick={() =>
                        account.active
                          ? setConfirm(account)
                          : void toggle(account)
                      }
                    >
                      {account.active ? "停用" : "启用"}
                    </button>
                    <button
                      disabled={busy || account.id === actor.id}
                      onClick={() => setPasswordTarget(account)}
                    >
                      重置密码
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
          <h2>停用账号</h2>
          <p>
            确认停用 {confirm.email}
            ？该账号的会话将立即失效。唯一项目管理员必须先移交权限。
          </p>
          <div className="actions">
            <button
              className="danger"
              disabled={busy}
              onClick={() => void toggle(confirm)}
            >
              确认停用
            </button>
            <button disabled={busy} onClick={() => setConfirm(null)}>
              取消
            </button>
          </div>
        </section>
      )}
    </>
  );
}

export function ProjectManagement({ base }: { base: string }) {
  const [tab, setTab] = useState<"closed" | "members" | "audit">("closed");
  return (
    <section className="panel">
      <div className="section-title">
        <h2>项目管理</h2>
        <div className="management-actions">
          <button
            aria-pressed={tab === "members"}
            onClick={() => setTab(tab === "members" ? "closed" : "members")}
          >
            成员权限
          </button>
          <button
            aria-pressed={tab === "audit"}
            onClick={() => setTab(tab === "audit" ? "closed" : "audit")}
          >
            审计记录
          </button>
        </div>
      </div>
      {tab === "members" && <Members base={base} />}{" "}
      {tab === "audit" && <AuditLog base={base} />}
    </section>
  );
}

function Members({ base }: { base: string }) {
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
        按邮箱添加已有账号。管理员管理成员及凭据；维护者配置实例；只读成员查看状态。
      </p>
      <form onSubmit={add} className="inline-form">
        <label>
          成员邮箱
          <input name="email" type="email" required />
        </label>
        <label>
          项目角色
          <select name="role" defaultValue="viewer">
            {Object.entries(roles).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={busy}>
          添加成员
        </button>
      </form>
      {loading && <p role="status">正在加载…</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>邮箱</th>
              <th>角色</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((member) => (
              <tr key={member.id}>
                <td>{member.email}</td>
                <td>
                  <select
                    aria-label={`${member.email} 的角色`}
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
                        {label}
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
                    移除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {remove && (
        <div className="notice">
          <p>移除 {remove.email} 对此项目的访问权限？</p>
          <div className="actions">
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void write(`${base}/members/${remove.id}`, "DELETE")
              }
            >
              确认移除
            </button>
            <button disabled={busy} onClick={() => setRemove(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function AuditLog({ base }: { base: string }) {
  const { rows, error, reload, loading } = useRows<Audit>(`${base}/audit`);
  const actions: Record<string, string> = {
    "project.create": "创建项目",
    "project.retry": "重试项目初始化",
    "member.update": "更新成员权限",
    "member.remove": "移除成员",
    "instance.create": "创建实例",
    "instance.update": "更新实例",
    "instance.delete": "删除实例",
    "volume.delete": "清理保留卷",
    "credential.rotate": "轮换凭据",
    "operation.succeeded": "操作完成",
    "operation.failed": "操作失败",
    "operation.retry": "恢复操作检查",
    "operation.superseded": "操作被替代",
  };
  return (
    <>
      <ErrorBox text={error} />
      <p className="muted">最近 100 条记录；系统操作以“系统”显示。</p>
      <button onClick={reload} disabled={loading}>
        刷新记录
      </button>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>事件</th>
              <th>操作者</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((event) => (
              <tr key={event.id}>
                <td>{new Date(event.created_at).toLocaleString()}</td>
                <td>{actions[event.action] ?? event.action}</td>
                <td>{event.actor_id ?? "系统"}</td>
                <td>
                  <code>{JSON.stringify(event.details)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !rows.length && <p>暂无审计记录</p>}
    </>
  );
}
