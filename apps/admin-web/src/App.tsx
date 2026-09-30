import { ResourceInventory } from "./ResourceInventory";
import { ProjectQuota } from "./ProjectQuota";
import { LookupHistory } from "./LookupHistory";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  APIError,
  operationNames,
  stateNames,
  templateLabel,
  type Template,
  type Detail,
  type Input,
  type Instance,
  type Operation,
  type Project,
  type User,
} from "./api";

import { RetainedVolume } from "./RetainedVolume";
import { RetryOperation } from "./RetryOperation";
import { Statistics } from "./Statistics";
import { PasswordForm } from "./PasswordForm";
import { RotateCredential } from "./RotateCredential";
import { UsersPanel, ProjectManagement } from "./Management";

const message = (e: unknown) =>
  e instanceof Error ? e.message : "请求失败，请重试";
const Badge = ({ state }: { state: string }) => (
  <span className={`badge ${state}`}>{stateNames[state] ?? state}</span>
);
const Alert = ({ text }: { text: string }) =>
  text ? (
    <div className="alert" role="alert">
      {text}
    </div>
  ) : null;

export function App() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    const expired = () => {
      setUser(null);
      sessionStorage.removeItem("expbuild-csrf");
    };
    window.addEventListener("expbuild-session-expired", expired);
    if (sessionStorage.getItem("expbuild-csrf"))
      api<{ user: User }>("/auth/me", { signal: abort.signal })
        .then((x) => setUser(x.user))
        .catch((e) => {
          if (
            e.name !== "AbortError" &&
            !(e instanceof APIError && e.status === 401)
          )
            setError(message(e));
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    else setLoading(false);
    return () => {
      abort.abort();
      window.removeEventListener("expbuild-session-expired", expired);
    };
  }, []);
  if (loading) return <main className="loading">正在恢复会话…</main>;
  if (!user) return <Login error={error} onLogin={setUser} />;
  return <Console user={user} onLogout={() => setUser(null)} />;
}

function Login({
  onLogin,
  error: initial,
}: {
  onLogin: (u: User) => void;
  error: string;
}) {
  const [error, setError] = useState(initial),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const login = await api<{ csrfToken: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: data.get("email"),
          password: data.get("password"),
        }),
      });
      sessionStorage.setItem("expbuild-csrf", login.csrfToken);
      const me = await api<{ user: User }>("/auth/me");
      onLogin(me.user);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <section className="login-story">
        <div className="brand">
          expbuild<span> / </span>缓存平台
        </div>
        <h1>
          让每一次构建，
          <br />
          少一些等待。
        </h1>
        <p>在一个地方管理团队的构建缓存、资源配置与服务状态。</p>
        <div className="protocols">构建缓存管理</div>
      </section>
      <form className="login-card" onSubmit={submit}>
        <p className="eyebrow">欢迎回来</p>
        <h2>登录管理控制台</h2>
        <Alert text={error} />
        <label>
          邮箱
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            autoFocus
          />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? "正在登录…" : "登录"}
        </button>
        <p className="muted">没有账号？请联系平台管理员。</p>
      </form>
    </main>
  );
}

function Console({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState(""),
    [error, setError] = useState("");
  const [creatingProject, setCreatingProject] = useState(false),
    [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const x = await api<{ items: Project[] }>("/projects", {
          signal: abort.signal,
        });
        setProjects(x.items);
        setProjectId((current) =>
          x.items.some((p) => p.id === current)
            ? current
            : (x.items[0]?.id ?? ""),
        );
        setError("");
      } catch (e) {
        if (!abort.signal.aborted) setError(message(e));
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(load, 5000);
      }
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [refresh]);
  async function createProject(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const name = new FormData(e.currentTarget).get("name");
    try {
      const p = await api<Project>("/projects", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setProjectId(p.id);
      setCreatingProject(false);
      setRefresh((x) => x + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);
  const project = projects.find((p) => p.id === projectId);
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          expbuild<span> / </span>
        </div>
        <p className="eyebrow">工作空间</p>
        <nav aria-label="项目">
          {projects.map((p) => (
            <button
              key={p.id}
              className={projectId === p.id ? "selected" : ""}
              onClick={() => {
                setProjectId(p.id);
                setUsersOpen(false);
              }}
            >
              <span className="project-icon">{p.name.slice(0, 1)}</span>
              {p.name}
            </button>
          ))}
        </nav>
        {user.platform_admin && (
          <button
            className="add-project"
            onClick={() => setCreatingProject(true)}
          >
            ＋ 新建项目
          </button>
        )}
        {user.platform_admin && (
          <button className="add-project" onClick={() => setUsersOpen(true)}>
            用户管理
          </button>
        )}
        <div className="account">
          <small>{user.email}</small>
          <button onClick={() => setPasswordOpen(true)}>修改密码</button>
          <button
            onClick={async () => {
              try {
                await api("/auth/logout", { method: "POST" });
                sessionStorage.removeItem("expbuild-csrf");
                onLogout();
              } catch (e) {
                setError(message(e));
              }
            }}
          >
            退出登录
          </button>
        </div>
      </aside>
      <main className="workspace">
        <Alert text={error} />
        {passwordOpen && (
          <PasswordForm
            onClose={() => setPasswordOpen(false)}
            onChanged={onLogout}
          />
        )}
        {creatingProject && (
          <section className="panel">
            <form className="inline-form" onSubmit={createProject}>
              <label>
                项目名称
                <input name="name" required maxLength={100} autoFocus />
              </label>
              <button className="primary" disabled={busy}>
                创建项目
              </button>
              <button type="button" onClick={() => setCreatingProject(false)}>
                取消
              </button>
            </form>
          </section>
        )}
        {usersOpen && user.platform_admin ? (
          <UsersPanel actor={user} />
        ) : project ? (
          <ProjectView key={project.id} project={project} user={user} />
        ) : (
          <section className="empty">
            <h1>开始管理构建缓存</h1>
            <p>
              {user.platform_admin
                ? "创建第一个项目，为团队配置缓存实例。"
                : "尚未加入项目，请联系管理员。"}
            </p>
          </section>
        )}
      </main>
    </div>
  );
}

function ProjectView({ project, user }: { project: Project; user: User }) {
  const [instances, setInstances] = useState<Instance[]>([]),
    [operations, setOperations] = useState<Operation[]>([]),
    [error, setError] = useState("");
  const [creating, setCreating] = useState(false),
    [selected, setSelected] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [credentials, setCredentials] = useState<{
    username: string;
    password: string;
  } | null>(null);
  const canWrite =
    user.platform_admin || ["admin", "maintainer"].includes(project.role ?? "");
  const canAdmin = user.platform_admin || project.role === "admin";
  const base = `/projects/${project.id}`;
  const [retryBusy, setRetryBusy] = useState(false),
    [retryOperation, setRetryOperation] = useState(""),
    [retryError, setRetryError] = useState("");
  const retryKey = useRef(crypto.randomUUID());
  useEffect(() => {
    if (
      retryOperation &&
      operations.some((o) => o.id === retryOperation && o.state === "failed")
    ) {
      retryKey.current = crypto.randomUUID();
      setRetryOperation("");
      setRetryError("初始化再次失败，请查看操作记录，修复后可继续重试。");
    }
  }, [operations, retryOperation]);
  async function retryProject() {
    setRetryBusy(true);
    setRetryError("");
    try {
      const result = await api<{ operation: { id: string } }>(`${base}/retry`, {
        method: "POST",
        headers: { "Idempotency-Key": retryKey.current },
      });
      setRetryOperation(result.operation.id);
      setRefresh((x) => x + 1);
    } catch (e) {
      setRetryError(message(e));
    } finally {
      setRetryBusy(false);
    }
  }

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const [i, o] = await Promise.all([
          api<{ items: Instance[] }>(`${base}/instances`, {
            signal: abort.signal,
          }),
          api<{ items: Operation[] }>(`${base}/operations`, {
            signal: abort.signal,
          }),
        ]);
        setInstances(i.items);
        setOperations(o.items);
        setError("");
      } catch (e) {
        if (!abort.signal.aborted) setError(message(e));
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(load, 3000);
      }
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [base, refresh]);
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">项目 / {project.name}</p>
          <h1>缓存实例</h1>
          <p className="muted">
            独立配置、按需分配。让团队复用每一次构建成果。
          </p>
        </div>
        <button
          className="primary"
          disabled={!canWrite || project.state !== "ready"}
          onClick={() => setCreating(true)}
        >
          ＋ 创建实例
        </button>
      </header>
      <Alert text={error} />
      {project.state !== "ready" && (
        <div className="notice">
          项目状态：
          <Badge state={project.state} />
          。初始化完成后可以创建实例。
          {project.state === "failed" && canAdmin && (
            <div className="actions">
              <button
                disabled={retryBusy || !!retryOperation}
                onClick={() => void retryProject()}
              >
                {retryBusy
                  ? "正在提交…"
                  : retryOperation
                    ? "重试已提交"
                    : "重试初始化"}
              </button>
            </div>
          )}
          <Alert text={retryError} />
        </div>
      )}
      <section className="summary">
        <div>
          <strong>
            {
              instances.filter(
                (i) => !["deleted", "detached"].includes(i.lifecycle),
              ).length
            }
          </strong>
          <span>当前实例</span>
        </div>
        <div>
          <strong>
            {
              operations.filter((o) =>
                ["pending", "applying", "reconciling"].includes(o.state),
              ).length
            }
          </strong>
          <span>进行中的操作</span>
        </div>
      </section>
      {credentials && (
        <section className="credential panel">
          <h2>保存连接凭据</h2>
          <p>
            密码只显示一次，关闭后无法再次查看。请保存到团队的凭据管理工具。
          </p>
          <label>
            用户名
            <input readOnly value={credentials.username} />
          </label>
          <label>
            密码
            <input
              readOnly
              value={credentials.password}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <button onClick={() => setCredentials(null)}>已保存，关闭</button>
        </section>
      )}
      {creating && (
        <section className="panel">
          <h2>创建缓存实例</h2>
          <p className="muted">选择协议模板，配置独立的存储与运行资源。</p>
          <InstanceForm
            base={base}
            onCancel={() => setCreating(false)}
            onSaved={(value) => {
              setCreating(false);
              setCredentials(value.credentials ?? null);
              setRefresh((x) => x + 1);
            }}
          />
        </section>
      )}
      <section className="panel">
        <div className="section-title">
          <h2>实例列表</h2>
          <span className="muted">每 3 秒刷新</span>
        </div>
        {instances.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>协议</th>
                  <th>管理状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {instances.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <strong>{i.display_name}</strong>
                      <small>{i.resource_name}</small>
                    </td>
                    <td>{templateLabel(i.template_name)}</td>
                    <td>
                      <Badge state={i.lifecycle} />
                    </td>
                    <td>
                      <button
                        onClick={() =>
                          setSelected(selected === i.id ? "" : i.id)
                        }
                      >
                        {selected === i.id ? "收起" : "详情"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            <h3>尚无缓存实例</h3>
            <p>创建一个实例，接入团队的构建工具。</p>
          </div>
        )}
      </section>
      {selected && (
        <InstanceDetail
          key={selected}
          base={base}
          id={selected}
          canWrite={canWrite}
          canAdmin={canAdmin}
          onChange={() => setRefresh((x) => x + 1)}
        />
      )}
      <section className="panel">
        <h2>最近操作</h2>
        {operations.length ? (
          <ul className="operations">
            {operations.map((o) => (
              <li key={o.id}>
                <div>
                  <strong>{operationNames[o.kind] ?? o.kind}</strong>
                  <small>
                    {new Date(o.created_at).toLocaleString()}{" "}
                    {o.error_code && `· ${o.error_code}`}
                  </small>
                  {canAdmin &&
                    o.state === "failed" &&
                    (o.kind === "instance.delete" ||
                      o.kind === "instance.create" ||
                      (o.target_generation != null &&
                        [
                          "instance.create",
                          "instance.update",
                          "instance.rotate",
                        ].includes(o.kind))) && (
                      <RetryOperation
                        key={`${o.id}:${o.updated_at}`}
                        base={base}
                        operation={o}
                        onChange={() => setRefresh((x) => x + 1)}
                      />
                    )}
                </div>
                <Badge state={o.state} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">暂无操作记录</p>
        )}
      </section>
      <ResourceInventory key={"inventory-" + base} base={base} />
      <ProjectQuota key={base} base={base} canEdit={user.platform_admin} />
      {canAdmin && <ProjectManagement base={base} />}
    </>
  );
}

const defaults: Input = {
  exposure: "ClusterInternal",
  template: "bazel-remote",
  name: "",
  storageGiB: 20,
  cacheGiB: 16,
  cpuMillis: 500,
  memoryMiB: 512,
  desiredState: "Running",
  deletionPolicy: "Retain",
};
function InstanceForm({
  base,
  detail,
  onCancel,
  onSaved,
}: {
  base: string;
  detail?: Detail;
  onCancel: () => void;
  onSaved: (x: {
    credentials?: { username: string; password: string };
  }) => void;
}) {
  const baseline = useRef(detail).current;
  const spec = baseline?.spec;
  const [input, setInput] = useState<Input>(
    spec
      ? {
          template: spec.templateRef.name,
          exposure: spec.access?.exposure ?? "ClusterInternal",
          name: baseline?.name ?? "",
          storageGiB: parseInt(spec.storage.capacity),
          cacheGiB: spec.eviction.maxCacheGiB,
          cpuMillis: spec.resources.limits.cpu.endsWith("m")
            ? parseInt(spec.resources.limits.cpu)
            : Number(spec.resources.limits.cpu) * 1000,
          memoryMiB: parseInt(spec.resources.limits.memory),
          desiredState: spec.desiredState,
          deletionPolicy: spec.storage.deletionPolicy,
        }
      : defaults,
  );
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [catalogError, setCatalogError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void api<{ items: Template[] }>("/templates", { signal: abort.signal })
      .then((value) => {
        if (abort.signal.aborted) return;
        const supported = value.items;
        setTemplates(supported);
        if (baseline) return;
        if (!supported.length) setCatalogError("当前没有可创建的模板。");
        else
          setInput((previous) => {
            const selected = supported.find(t => t.name === previous.template) ?? supported[0];
            return {
              ...previous,
              template: selected.name,
              exposure: selected.exposures?.includes(previous.exposure) ? previous.exposure : "ClusterInternal",
              cacheGiB: selected.capabilities.capacity ? previous.cacheGiB : 0,
            };
          });
      })
      .catch((e) => {
        if (!abort.signal.aborted) setCatalogError(message(e));
      });
    return () => abort.abort();
  }, [baseline]);
  const selectedTemplate = templates.find(t => t.name === input.template && (!spec || t.version === spec.templateRef.version));
  // Disabled templates remain editable; preserve the existing engine budget
  // instead of inferring capabilities from a possibly newer catalog version.
  const supportsCapacity = selectedTemplate?.capabilities.capacity ?? (!!spec && spec.eviction.maxCacheGiB > 0);
  const canSubmit = !!baseline || !!selectedTemplate;
  const last = useRef({ body: "", key: "" });
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!canSubmit) return;
    if (
      supportsCapacity &&
      input.cacheGiB >= input.storageGiB
    ) {
      setError("缓存容量必须小于存储卷容量，以预留运行空间。");
      return;
    }
    setBusy(true);
    const body = JSON.stringify(input);
    if (last.current.body !== body)
      last.current = { body, key: crypto.randomUUID() };
    try {
      const x = await api<{
        credentials?: { username: string; password: string };
      }>(`${base}/instances${detail ? `/${detail.id}` : ""}`, {
        method: detail ? "PATCH" : "POST",
        headers: {
          "Idempotency-Key": last.current.key,
          ...(detail ? { "If-Match": `"${baseline?.revision}"` } : {}),
        },
        body,
      });
      onSaved(x);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <Alert text={error} />
      <Alert text={catalogError} />
      {!baseline && !templates.length && !catalogError && (
        <p>正在加载可用模板…</p>
      )}
      <div className="form-grid">
        <label>
          协议模板
          <select
            value={input.template}
            disabled={!!baseline || !templates.length || busy}
            onChange={(e) => {
              const selected = templates.find(
                (t) => t.name === e.target.value,
              )!;
              setInput({
                ...input,
                template: selected.name,
                exposure: selected.exposures?.includes(input.exposure) ? input.exposure : "ClusterInternal",
                cacheGiB: selected.capabilities.capacity
                  ? Math.min(16, input.storageGiB - 1)
                  : 0,
              });
            }}
          >
            {baseline ? (
              <option value={input.template}>
                {templateLabel(input.template)}
              </option>
            ) : (
              templates.map((t) => (
                <option key={t.name} value={t.name}>
                  {templateLabel(t.name)}
                </option>
              ))
            )}
          </select>
        </label>
        <label>
          访问方式
          <select value={input.exposure} onChange={e => setInput({ ...input, exposure: e.target.value as Input['exposure'] })}>
            <option value="ClusterInternal">集群内部</option>
            {(input.exposure === 'Gateway' || templates.find(t => t.name === input.template)?.exposures?.includes('Gateway')) && <option value="Gateway">独立域名（HTTPS / gRPC TLS）</option>}
          </select>
        </label>
        <label>
          实例名称
          <input
            value={input.name}
            required
            maxLength={100}
            onChange={(e) => setInput({ ...input, name: e.target.value })}
          />
        </label>
        {(
          [
            ["storageGiB", "存储卷容量（GiB）", 2, 1048576],
            ["cacheGiB", "缓存容量（GiB）", 1, 1048575],
            ["cpuMillis", "CPU（毫核）", 100, 64000],
            ["memoryMiB", "内存（MiB）", 128, 262144],
          ] as const
        )
          .filter(
            ([key]) => key !== "cacheGiB" || supportsCapacity,
          )
          .map(([key, label, min, max]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                required
                min={
                  key === "storageGiB" && spec
                    ? parseInt(spec.storage.capacity)
                    : selectedTemplate?.inputSchema?.properties?.[key]?.minimum ?? min
                }
                max={selectedTemplate?.inputSchema?.properties?.[key]?.maximum ?? max}
                step="1"
                value={Number.isNaN(input[key]) ? "" : input[key]}
                onChange={(e) =>
                  setInput({ ...input, [key]: e.target.valueAsNumber })
                }
              />
            </label>
          ))}
        <p className="muted">
          {supportsCapacity
            ? "缓存预算必须小于存储卷容量。配置调整可能重启实例，以策略生效状态为准。"
            : "此模板未提供引擎容量预算。存储卷容量不是自动清理阈值，请预留空间并管理文件。"}
          {selectedTemplate?.capabilities.lru && " 引擎支持 LRU 淘汰。"}
          {selectedTemplate && !selectedTemplate.capabilities.ttl && " 暂不支持 TTL。"}
        </p>
        <label>
          运行状态
          <select
            value={input.desiredState}
            onChange={(e) =>
              setInput({
                ...input,
                desiredState: e.target.value as Input["desiredState"],
              })
            }
          >
            <option value="Running">运行</option>
            <option value="Suspended">暂停</option>
          </select>
        </label>
        <label>
          删除实例时
          <select
            value={input.deletionPolicy}
            onChange={(e) =>
              setInput({
                ...input,
                deletionPolicy: e.target.value as Input["deletionPolicy"],
              })
            }
          >
            <option value="Retain">保留存储卷</option>
            <option value="Delete">同时删除存储卷</option>
          </select>
        </label>
      </div>
      {input.template === "webdav-apache" && (
        <p className="notice">
          WebDAV
          支持认证文件读写与锁，不提供自动淘汰或容量统计。存储卷容量不是文件系统硬配额。
        </p>
      )}
      <div className="actions">
        <button className="primary" disabled={busy || !canSubmit}>
          {busy ? "正在提交…" : detail ? "保存配置" : "创建实例"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

function InstanceDetail({
  base,
  id,
  canWrite,
  canAdmin,
  onChange,
}: {
  base: string;
  id: string;
  canWrite: boolean;
  canAdmin: boolean;
  onChange: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(false),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState(false);
  const deleteKey = useRef(crypto.randomUUID());
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        setDetail(
          await api<Detail>(`${base}/instances/${id}`, {
            signal: abort.signal,
          }),
        );
        setError("");
      } catch (e) {
        if (!abort.signal.aborted) setError(message(e));
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(load, 3000);
      }
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [base, id]);
  const available =
    detail?.spec &&
    detail.revision &&
    !["deleted", "detached", "deleting", "pending"].includes(detail.lifecycle);
  return (
    <section className="panel">
      <h2>{detail?.name ?? "实例详情"}</h2>
      {detail?.lifecycle === 'detached' && <RetainedVolume path={`${base}/instances/${id}/retained-volume`} canAdmin={canAdmin} onChange={onChange} />}
      <Alert text={error} />
      {detail?.spec && (
        <>
          <div className="detail-grid">
            <p>
              协议<strong>{templateLabel(detail.spec.templateRef.name)}</strong>
            </p>
            <p>
              淘汰策略
              <strong>
                {detail.spec.templateRef.name === "bazel-remote"
                  ? `LRU · ${detail.spec.eviction.maxCacheGiB} GiB`
                  : "不支持自动淘汰"}
              </strong>
            </p>
            <p>
              存储卷<strong>{detail.spec.storage.capacity}</strong>
            </p>
            <p>
              期望状态
              <strong>
                {detail.spec.desiredState === "Running" ? "运行" : "暂停"}
              </strong>
            </p>
          </div>
          {detail.status?.conditions?.map((c) => (
            <div className="notice" key={c.type}>
              {c.type === "Ready"
                ? c.status === "True"
                  ? "服务已就绪"
                  : "服务尚未就绪"
                 : c.type === "PolicyApplied"
                  ? c.reason === "NotSupported"
                    ? "不支持自动淘汰"
                    : c.status === "True" && String(c.observedGeneration) === detail.revision?.split(":").at(-1)
                      ? "缓存策略已生效"
                      : "缓存策略尚未确认生效"
                  : c.type}{" "}
              · {c.reason}
              {c.message && <p>{c.message}</p>}
            </div>
          ))}
          {detail.status?.endpoints?.map((e) => (
            <p key={e.protocol}>
              {e.protocol} <code>{e.url}</code>
            </p>
          ))}
          <p className="muted">{detail.spec.access?.exposure === "Gateway"
            ? "通过独立域名访问，请确认证书受信任且域名可达。"
            : "连接地址当前仅供集群内部使用。"}</p>
          {detail.spec.templateRef.name === "bazel-remote" ? (
            <Statistics
              path={`${base}/instances/${id}`}
              running={
                detail.spec.desiredState === "Running" &&
                !["deleted", "detached", "deleting"].includes(detail.lifecycle)
              }
            />
          ) : (
            <p className="muted">此模板暂不支持容量统计。</p>
          )}
          <div className="actions">
            {canWrite && (
              <button
                disabled={!available}
                onClick={() => setEditing(!editing)}
              >
                编辑配置
              </button>
            )}
            {canAdmin && (
              <button disabled={!available} onClick={() => setRotating(true)}>
                轮换凭据
              </button>
            )}
            {canAdmin && (
              <button
                className="danger"
                disabled={!available}
                onClick={() => setConfirm(true)}
              >
                删除实例
              </button>
            )}
          </div>
        </>
      )}
      {(detail?.template ?? detail?.spec?.templateRef.name) === "bazel-remote" && <LookupHistory path={`${base}/instances/${id}`} />}
      {editing && detail && (
        <InstanceForm
          key={detail.id}
          base={base}
          detail={detail}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChange();
          }}
        />
      )}
      {rotating && detail?.revision && (
        <RotateCredential
          base={base}
          id={id}
          revision={detail.revision}
          onClose={() => setRotating(false)}
          onChange={onChange}
        />
      )}
      {confirm && detail && (
        <div className="notice">
          <p>
            确认删除「{detail.name}」？
            {detail.spec?.storage.deletionPolicy === "Delete"
              ? "存储卷也会被删除，缓存数据将丢失。"
              : "存储卷将保留，服务访问会停止。"}
          </p>
          <div className="actions">
            <button
              className="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`${base}/instances/${id}`, {
                    method: "DELETE",
                    headers: { "Idempotency-Key": deleteKey.current },
                  });
                  setConfirm(false);
                  onChange();
                } catch (e) {
                  setError(message(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              确认删除
            </button>
            <button disabled={busy} onClick={() => setConfirm(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
