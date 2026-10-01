import { PlatformHealth, ProjectObservability, InstanceObservability } from "./Observability";
import { t, formatDate, formatNumber, useLocale } from "./i18n";
import {
  Brand,
  Dialog,
  Icon,
  LanguageSelect,
  sections,
  useRoute,
  type Section,
} from "./ui";
import { ConnectionInfo } from "./ConnectionInfo";
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

import {
  RetainedVolume,
  type Volume as RetainedVolumeInfo,
} from "./RetainedVolume";
import { RetryOperation } from "./RetryOperation";
import { Statistics } from "./Statistics";
import { PasswordForm } from "./PasswordForm";
import { RotateCredential } from "./RotateCredential";
import { UsersPanel, Members, AuditLog } from "./Management";

const message = (e: unknown) =>
  e instanceof Error ? e.message : t("请求失败，请重试");
const Badge = ({ state }: { state: string }) => (
  <span className={`badge ${state}`}>{t(stateNames[state] ?? state)}</span>
);
const Alert = ({ text }: { text: string }) =>
  text ? (
    <div className="alert" role="alert">
      {t(text)}
    </div>
  ) : null;

export function App() {
  useLocale();
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
  if (loading) return <main className="loading">{t("正在恢复会话…")}</main>;
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
        <Brand />
        <h1>
          {t("让每一次构建，")}
          <br />
          {t("少一些等待。")}
        </h1>
        <p>{t("在一个地方管理团队的构建缓存、资源配置与服务状态。")}</p>
        <div className="protocols">{t("构建缓存管理")}</div>
      </section>
      <div className="login-side">
        <div className="login-language">
          <LanguageSelect />
        </div>
        <form className="login-card" onSubmit={submit}>
          <p className="eyebrow">{t("欢迎回来")}</p>
          <h2>{t("登录管理控制台")}</h2>
          <Alert text={error} />
          <label>
            {t("邮箱")}
            <input
              name="email"
              type="email"
              autoComplete="username"
              required
              autoFocus
            />
          </label>
          <label>
            {t("密码")}
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? t("正在登录…") : t("登录")}
          </button>
          <p className="muted">{t("没有账号？请联系平台管理员。")}</p>
        </form>
        <p className="login-footer">expbuild · Build cache management</p>
      </div>
    </main>
  );
}

function Console({ user, onLogout }: { user: User; onLogout: () => void }) {
  const route = useRoute();
  const [mobileNav, setMobileNav] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState(route.project),
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
        if (!abort.signal.aborted) {
          setProjectsLoading(false);
          timer = setTimeout(load, 5000);
        }
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
      window.location.hash = `/projects/${p.id}/instances`;
      setCreatingProject(false);
      setRefresh((x) => x + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const [passwordOpen, setPasswordOpen] = useState(false);
  useEffect(() => {
    if (route.project && projects.some((p) => p.id === route.project))
      setProjectId(route.project);
  }, [route.project, projects]);
  useEffect(() => {
    setMobileNav(false);
  }, [route.project, route.section, route.users]);
  const usersOpen = route.users && user.platform_admin;
  const healthOpen = route.health && user.platform_admin;
  const canAdmin =
    user.platform_admin ||
    projects.find((p) => p.id === projectId)?.role === "admin";
  const section =
    !canAdmin && ["members", "audit"].includes(route.section)
      ? "instances"
      : route.section;
  function selectProject(id: string) {
    setProjectId(id);
    window.location.hash = `/projects/${id}/${section}`;
  }

  const project = projects.find((p) => p.id === projectId);
  return (
    <div className="shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        {t("跳至主要内容")}
      </a>
      <aside className={mobileNav ? "sidebar mobile-open" : "sidebar"}>
        <Brand />
        <div className="sidebar-label">{t("工作空间")}</div>
        <nav aria-label={t("项目导航")}>
          {sections
            .filter((item) => !item.admin || canAdmin)
            .map((item) => (
              <a
                key={item.id}
                href={`#/projects/${projectId}/${item.id}`}
                aria-current={
                  !usersOpen && !healthOpen && section === item.id ? "page" : undefined
                }
              >
                <Icon name={item.id} />
                <span>{t(item.label)}</span>
              </a>
            ))}
        </nav>
        {user.platform_admin && (
          <>
            <div className="sidebar-label">{t("平台管理")}</div>
            <nav aria-label={t("平台导航")}>
              <a href="#/health" aria-current={healthOpen ? "page" : undefined}><Icon name="operations"/><span>{t("平台健康")}</span></a>
              <a href="#/users" aria-current={usersOpen ? "page" : undefined}>
                <Icon name="members" />
                <span>{t("用户管理")}</span>
              </a>
            </nav>
          </>
        )}
        {user.platform_admin && (
          <button
            className="mobile-new-project"
            onClick={() => {
              setMobileNav(false);
              setCreatingProject(true);
            }}
          >
            {t("＋ 新建项目")}
          </button>
        )}
        <div className="account">
          <small>{user.email}</small>
          <button onClick={() => setPasswordOpen(true)}>{t("修改密码")}</button>
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
            {t("退出登录")}
          </button>
        </div>
      </aside>
      <div className="main-column">
        <div className="topbar">
          <button
            className="icon-button mobile-toggle"
            aria-label={t("切换导航")}
            aria-expanded={mobileNav}
            onClick={() => setMobileNav(!mobileNav)}
          >
            <Icon name="menu" />
          </button>
          <div className="project-switcher">
            <span className="project-avatar">
              {project?.name.slice(0, 1).toUpperCase() ?? "E"}
            </span>
            <label>
              <span className="sr-only">{t("切换项目")}</span>
              <select
                value={projectId}
                disabled={projectsLoading || !projects.length}
                onChange={(event) => selectProject(event.target.value)}
              >
                {!projects.length && (
                  <option value="">
                    {projectsLoading ? t("正在加载…") : t("暂无项目")}
                  </option>
                )}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {user.platform_admin && (
            <button
              className="text-button new-project"
              onClick={() => setCreatingProject(true)}
            >
              {t("＋ 新建项目")}
            </button>
          )}
          <div className="topbar-end">
            <LanguageSelect />
            <span className="avatar" title={user.email}>
              {user.email.slice(0, 1).toUpperCase()}
            </span>
          </div>
        </div>
        <main className="workspace" id="main-content" tabIndex={-1}>
          <div className="breadcrumb">
            <span>{t("工作空间")}</span>
            <span>/</span>
            <span>
              {(usersOpen || healthOpen) ? t("平台管理") : (project?.name ?? t("项目"))}
            </span>
            <span>/</span>
            <strong>
              {t(
                healthOpen ? "平台健康" : usersOpen
                  ? "用户管理"
                  : sections.find((item) => item.id === section)!.label,
              )}
            </strong>
          </div>
          <Alert text={error} />
          {passwordOpen && (
            <Dialog
              title={t("修改密码")}
              onClose={() => setPasswordOpen(false)}
            >
              <PasswordForm
                onClose={() => setPasswordOpen(false)}
                onChanged={onLogout}
              />
            </Dialog>
          )}
          {creatingProject && (
            <Dialog
              title={t("创建项目")}
              busy={busy}
              onClose={() => {
                if (!busy) setCreatingProject(false);
              }}
            >
              <form className="inline-form" onSubmit={createProject}>
                <label>
                  {t("项目名称")}
                  <input name="name" required maxLength={100} autoFocus />
                </label>
                <button className="primary" disabled={busy}>
                  {t("创建项目")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setCreatingProject(false)}
                >
                  {t("取消")}
                </button>
              </form>
            </Dialog>
          )}
          {healthOpen ? <PlatformHealth /> : usersOpen && user.platform_admin ? (
            <UsersPanel actor={user} />
          ) : project ? (
            <ProjectView
              key={project.id}
              project={project}
              user={user}
              section={section}
            />
          ) : projectsLoading ? (
            <p role="status">{t("正在加载…")}</p>
          ) : (
            <section className="empty">
              <h1>{t("开始管理构建缓存")}</h1>
              <p>
                {user.platform_admin
                  ? t("创建第一个项目，为团队配置缓存实例。")
                  : t("尚未加入项目，请联系管理员。")}
              </p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function ProjectView({
  project,
  user,
  section,
}: {
  project: Project;
  user: User;
  section: Section;
}) {
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [protocol, setProtocol] = useState("all");
  const [lifecycle, setLifecycle] = useState("all");
  const [loading, setLoading] = useState(true);
  const [hasSnapshot, setHasSnapshot] = useState(false);
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
      setRetryError(t("初始化再次失败，请查看操作记录，修复后可继续重试。"));
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
        setHasSnapshot(true);
        setInstances(i.items);
        setOperations(o.items);
        setError("");
      } catch (e) {
        if (!abort.signal.aborted) setError(message(e));
      } finally {
        if (!abort.signal.aborted) {
          setLoading(false);
          timer = setTimeout(load, 3000);
        }
      }
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [base, refresh]);
  const page = sections.find((item) => item.id === section)!;
  const visibleInstances = instances.filter(
    (instance) =>
      (protocol === "all" || instance.template_name === protocol) &&
      (lifecycle === "all" || instance.lifecycle === lifecycle) &&
      `${instance.display_name} ${instance.resource_name}`
        .toLowerCase()
        .includes(search.toLowerCase().trim()),
  );
  const currentInstances = instances.filter(
    (instance) => !["deleted", "detached"].includes(instance.lifecycle),
  ).length;
  const pending = operations.filter((operation) =>
    ["pending", "applying", "reconciling"].includes(operation.state),
  ).length;
  const failed = operations.filter(
    (operation) => operation.state === "failed",
  ).length;
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">{project.name}</p>
          <h1>{t(page.label)}</h1>
          <p className="muted">{t(page.description)}</p>
        </div>
        <button
          className="primary"
          disabled={!canWrite || project.state !== "ready"}
          onClick={() => setCreating(true)}
        >
          {t("＋ 创建实例")}
        </button>
      </header>
      <Alert text={error} />
      {project.state !== "ready" && (
        <div className="notice">
          {t("项目状态：")}
          <Badge state={project.state} />
          {t("。初始化完成后可以创建实例。")}
          {project.state === "failed" && canAdmin && (
            <div className="actions">
              <button
                disabled={retryBusy || !!retryOperation}
                onClick={() => void retryProject()}
              >
                {retryBusy
                  ? t("正在提交…")
                  : retryOperation
                    ? t("重试已提交")
                    : t("重试初始化")}
              </button>
            </div>
          )}
          <Alert text={retryError} />
        </div>
      )}
      {(section === "overview" || section === "instances") && (
        <section
          className="summary"
          aria-label={t("项目摘要")}
          aria-busy={loading}
        >
          <div>
            <span>{t("当前实例")}</span>
            <strong>
              {!hasSnapshot ? "—" : formatNumber(currentInstances)}
            </strong>
            <small>{t("不含已删除或已保留卷的实例")}</small>
          </div>
          <div>
            <span>{t("进行中的操作")}</span>
            <strong>{!hasSnapshot ? "—" : formatNumber(pending)}</strong>
            <small>{t("等待、提交或部署中的变更")}</small>
          </div>
          <div>
            <span>{t("失败操作")}</span>
            <strong className={failed ? "text-danger" : ""}>
              {!hasSnapshot ? "—" : formatNumber(failed)}
            </strong>
            <small>{t("最近 100 条操作中的失败记录")}</small>
          </div>
          <div>
            <span>{t("协议类型")}</span>
            <strong>
              {!hasSnapshot
                ? "—"
                : formatNumber(
                    new Set(
                      instances
                        .filter(
                          (i) => !["deleted", "detached"].includes(i.lifecycle),
                        )
                        .map((i) => i.template_name),
                    ).size,
                  )}
            </strong>
            <small>{t("当前实例使用的缓存协议")}</small>
          </div>
        </section>
      )}
      {section === "overview" && (
        <section className="panel overview-intro">
          <div>
            <span className="eyebrow">{t("缓存服务")}</span>
            <h2>{t("为团队管理每一份构建缓存")}</h2>
            <p className="muted">
              {t("查看实例配置、连接客户端，或跟踪最近的变更。")}
            </p>
          </div>
          <a className="button" href={`#/projects/${project.id}/instances`}>
            {t("查看所有实例")}
            <Icon name="arrow" />
          </a>
        </section>
      )}
      {credentials && (
        <section className="credential panel">
          <h2>{t("保存连接凭据")}</h2>
          <p>
            {t(
              "密码只显示一次，关闭后无法再次查看。请保存到团队的凭据管理工具。",
            )}
          </p>
          <label>
            {t("用户名")}
            <input readOnly value={credentials.username} />
          </label>
          <label>
            {t("密码")}
            <input
              readOnly
              value={credentials.password}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <button onClick={() => setCredentials(null)}>
            {t("已保存，关闭")}
          </button>
        </section>
      )}
      {creating && (
        <Dialog
          title={t("创建缓存实例")}
          busy={creatingBusy}
          onClose={() => setCreating(false)}
        >
          <p className="muted">
            {t("选择协议模板，配置独立的存储与运行资源。")}
          </p>
          <InstanceForm
            base={base}
            onBusyChange={setCreatingBusy}
            onCancel={() => setCreating(false)}
            onSaved={(value) => {
              setCreating(false);
              setCredentials(value.credentials ?? null);
              setRefresh((x) => x + 1);
            }}
          />
        </Dialog>
      )}
      {section === "instances" && (
        <section className="panel instances-panel">
          <div className="section-title">
            <h2>
              {t("实例列表")}
              <span className="count">{formatNumber(instances.length)}</span>
            </h2>
            <span className="muted">{t("每 3 秒刷新")}</span>
          </div>
          <div className="table-toolbar">
            <label className="search-field">
              <Icon name="search" />
              <span className="sr-only">{t("搜索实例")}</span>
              <input
                type="search"
                placeholder={t("搜索名称或资源标识…")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label>
              <span className="sr-only">{t("筛选协议")}</span>
              <select
                value={protocol}
                onChange={(event) => setProtocol(event.target.value)}
              >
                <option value="all">{t("所有协议")}</option>
                {[...new Set(instances.map((i) => i.template_name))].map(
                  (name) => (
                    <option key={name} value={name}>
                      {templateLabel(name)}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label>
              <span className="sr-only">{t("筛选状态")}</span>
              <select
                value={lifecycle}
                onChange={(event) => setLifecycle(event.target.value)}
              >
                <option value="all">{t("所有状态")}</option>
                {[...new Set(instances.map((i) => i.lifecycle))].map(
                  (state) => (
                    <option key={state} value={state}>
                      {t(stateNames[state] ?? state)}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>
          {loading ? (
            <div className="empty" role="status">
              {t("正在加载…")}
            </div>
          ) : !hasSnapshot ? (
            <div className="empty" role="status">
              {t("数据暂不可用，正在重试…")}
            </div>
          ) : visibleInstances.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("名称")}</th>
                    <th>{t("协议")}</th>
                    <th>{t("管理状态")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visibleInstances.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <div className="instance-name">
                          <span className="instance-icon">
                            <Icon name="instances" />
                          </span>
                          <strong>{i.display_name}</strong>
                        </div>
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
                          {selected === i.id ? t("收起") : t("详情")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">
              <Icon name="instances" />
              <h3>
                {instances.length ? t("没有匹配的实例") : t("尚无缓存实例")}
              </h3>
              <p>
                {instances.length
                  ? t("调整搜索条件或清除筛选后重试。")
                  : t("创建一个实例，接入团队的构建工具。")}
              </p>
              {instances.length > 0 && (
                <button
                  onClick={() => {
                    setSearch("");
                    setProtocol("all");
                    setLifecycle("all");
                  }}
                >
                  {t("清除筛选")}
                </button>
              )}
            </div>
          )}
          <div className="table-footer">
            {t("显示 {shown} / {total} 个实例", {
              shown: hasSnapshot ? formatNumber(visibleInstances.length) : "—",
              total: hasSnapshot ? formatNumber(instances.length) : "—",
            })}
          </div>
        </section>
      )}
      {selected && (
        <Dialog
          title={t("实例详情")}
          wide
          busy={detailBusy}
          onClose={() => setSelected("")}
        >
          <InstanceDetail
            key={selected}
            base={base}
            id={selected}
            onBusyChange={setDetailBusy}
            canWrite={canWrite}
            canAdmin={canAdmin}
            onChange={() => setRefresh((x) => x + 1)}
          />
        </Dialog>
      )}
      {(section === "overview" || section === "operations") && (
        <section className="panel">
          <div className="section-title">
            <h2>{t("最近操作")}</h2>
            {section === "overview" && (
              <a href={`#/projects/${project.id}/operations`}>
                {t("查看全部")}
                <span aria-hidden="true">→</span>
              </a>
            )}
          </div>
          <p className="muted">{t("最近 100 条操作记录，按创建时间排序。")}</p>
          {!hasSnapshot ? (
            <p role="status">
              {loading ? t("正在加载…") : t("数据暂不可用，正在重试…")}
            </p>
          ) : operations.length ? (
            <ul className="operations">
              {(section === "overview"
                ? operations.slice(0, 5)
                : operations
              ).map((o) => (
                <li key={o.id}>
                  <div>
                    <strong>{t(operationNames[o.kind] ?? o.kind)}</strong>
                    <small>
                      {formatDate(o.created_at)}{" "}
                      {o.error_code && `· ${o.error_code}`}
                    </small>
                    {canAdmin &&
                      o.state === "failed" &&
                      (o.kind === "instance.delete" ||
                        o.kind === "instance.create" ||
                        o.kind === "instance.reclaim" ||
                        (o.target_generation != null &&
                          [
                            "instance.create",
                            "instance.reclaim",
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
            <p className="muted">{t("暂无操作记录")}</p>
          )}
        </section>
      )}
      {(section === "observability" || section === "alerts") && <ProjectObservability key={section} base={base} canEdit={canWrite} alertsOnly={section === "alerts"} />}
      {section === "resources" && (
        <div className="resource-sections">
          <ProjectQuota
            key={base}
            base={base}
            canEdit={user.platform_admin}
            initiallyOpen
          />
          <ResourceInventory
            key={"inventory-" + base}
            base={base}
            canReconcile={user.platform_admin}
            initiallyOpen
          />
        </div>
      )}
      {section === "members" && canAdmin && (
        <section className="panel">
          <Members base={base} />
        </section>
      )}
      {section === "audit" && canAdmin && (
        <section className="panel">
          <AuditLog base={base} />
        </section>
      )}
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
type ReclaimFormTarget = {
  path: string;
  volume: RetainedVolumeInfo;
  name: string;
  template: string;
  templateVersion: string | null;
};
function volumeGiB(quantity: string): number | null {
  const parsed = /^(\d+)(Ki|Mi|Gi|Ti)$/.exec(quantity);
  if (!parsed) return null;
  const factor: Record<string, bigint> = {
    Ki: 1024n,
    Mi: 1024n ** 2n,
    Gi: 1024n ** 3n,
    Ti: 1024n ** 4n,
  };
  const bytes = BigInt(parsed[1]) * factor[parsed[2]];
  const gib = (bytes + 1024n ** 3n - 1n) / 1024n ** 3n;
  return gib <= 1048576n ? Number(gib) : null;
}
function InstanceForm({
  base,
  detail,
  reclaim,
  onBusyChange,
  onCancel,
  onSaved,
}: {
  base: string;
  detail?: Detail;
  reclaim?: ReclaimFormTarget;
  onBusyChange?: (busy: boolean) => void;
  onCancel: () => void;
  onSaved: (x: {
    credentials?: { username: string; password: string };
  }) => void;
}) {
  const baseline = useRef(detail).current;
  const spec = baseline?.spec;
  const reclaimInitial = useRef(reclaim).current;
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
      : reclaimInitial
        ? (() => {
            const minimum = Math.max(
              volumeGiB(reclaimInitial.volume.capacity) ?? 0,
              volumeGiB(reclaimInitial.volume.allocatedCapacity) ?? 0,
              2,
            );
            return {
              ...defaults,
              name: reclaimInitial.name,
              template: reclaimInitial.template,
              storageGiB: minimum,
              cacheGiB:
                reclaimInitial.template === "webdav-apache"
                  ? 0
                  : Math.max(1, Math.min(16, minimum - 1)),
            };
          })()
        : defaults,
  );
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [catalogError, setCatalogError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void api<{ items: Template[] }>("/templates", { signal: abort.signal })
      .then((value) => {
        if (abort.signal.aborted) return;
        const supported = value.items;
        setTemplates(supported);
        if (reclaimInitial) {
          const legacyWebDAV =
            reclaimInitial.template === "webdav-apache" &&
            reclaimInitial.templateVersion === "0.1.0" &&
            supported.some((t) => t.name === "webdav-apache");
          if (
            !legacyWebDAV &&
            !supported.some(
              (t) =>
                t.name === reclaimInitial.template &&
                t.version === reclaimInitial.templateVersion,
            )
          )
            setCatalogError(t("原协议模板版本当前不可用，无法领回该实例。"));
          return;
        }
        if (baseline) return;
        if (!supported.length) setCatalogError(t("当前没有可创建的模板。"));
        else
          setInput((previous) => {
            const selected =
              supported.find((t) => t.name === previous.template) ??
              supported[0];
            return {
              ...previous,
              template: selected.name,
              exposure: selected.exposures?.includes(previous.exposure)
                ? previous.exposure
                : "ClusterInternal",
              cacheGiB: selected.capabilities.capacity ? previous.cacheGiB : 0,
            };
          });
      })
      .catch((e) => {
        if (!abort.signal.aborted) setCatalogError(message(e));
      });
    return () => abort.abort();
  }, [baseline, reclaimInitial]);
  const selectedTemplate = templates.find(
    (t) =>
      t.name === input.template &&
      (!spec || t.version === spec.templateRef.version) &&
      (!reclaimInitial || t.version === reclaimInitial.templateVersion),
  );
  // Disabled templates remain editable; preserve the existing engine budget
  // instead of inferring capabilities from a possibly newer catalog version.
  const supportsCapacity =
    selectedTemplate?.capabilities.capacity ??
    (!!spec && spec.eviction.maxCacheGiB > 0);
  const legacyWebDAV =
    reclaimInitial?.template === "webdav-apache" &&
    reclaimInitial.templateVersion === "0.1.0" &&
    templates.some((t) => t.name === "webdav-apache");
  const canSubmit = !!baseline || !!selectedTemplate || legacyWebDAV;
  const last = useRef({ body: "", key: "" });
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!canSubmit) return;
    if (supportsCapacity && input.cacheGiB >= input.storageGiB) {
      setError(t("缓存容量必须小于存储卷容量，以预留运行空间。"));
      return;
    }
    setBusy(true);
    const body = JSON.stringify(input);
    if (last.current.body !== body)
      last.current = { body, key: crypto.randomUUID() };
    try {
      const x = await api<{
        credentials?: { username: string; password: string };
      }>(
        reclaimInitial
          ? reclaimInitial.path + "/reclaim"
          : `${base}/instances${detail ? `/${detail.id}` : ""}`,
        {
          method: detail ? "PATCH" : "POST",
          headers: {
            "Idempotency-Key": last.current.key,
            ...(detail
              ? { "If-Match": `"${baseline?.revision}"` }
              : reclaimInitial
                ? { "If-Match": reclaimInitial.volume.uid }
                : {}),
          },
          body,
        },
      );
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
        <p>{t("正在加载可用模板…")}</p>
      )}
      <div className="form-grid">
        <label>
          {t("协议模板")}
          <select
            value={input.template}
            disabled={
              !!baseline || !!reclaimInitial || !templates.length || busy
            }
            onChange={(e) => {
              const selected = templates.find(
                (t) => t.name === e.target.value,
              )!;
              setInput({
                ...input,
                template: selected.name,
                exposure: selected.exposures?.includes(input.exposure)
                  ? input.exposure
                  : "ClusterInternal",
                cacheGiB: selected.capabilities.capacity
                  ? Math.min(16, input.storageGiB - 1)
                  : 0,
              });
            }}
          >
            {baseline || reclaimInitial ? (
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
          {t("访问方式")}
          <select
            value={input.exposure}
            onChange={(e) =>
              setInput({
                ...input,
                exposure: e.target.value as Input["exposure"],
              })
            }
          >
            <option value="ClusterInternal">{t("集群内部")}</option>
            {(input.exposure === "Gateway" ||
              templates
                .find((t) => t.name === input.template)
                ?.exposures?.includes("Gateway")) && (
              <option value="Gateway">
                {t("独立域名（HTTPS / gRPC TLS）")}
              </option>
            )}
          </select>
        </label>
        <label>
          {t("实例名称")}
          <input
            value={input.name}
            required
            maxLength={100}
            onChange={(e) => setInput({ ...input, name: e.target.value })}
          />
        </label>
        {(
          [
            ["storageGiB", t("存储卷容量（GiB）"), 2, 1048576],
            ["cacheGiB", t("缓存容量（GiB）"), 1, 1048575],
            ["cpuMillis", t("CPU（毫核）"), 100, 64000],
            ["memoryMiB", t("内存（MiB）"), 128, 262144],
          ] as const
        )
          .filter(([key]) => key !== "cacheGiB" || supportsCapacity)
          .map(([key, label, min, max]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                required
                min={
                  key === "storageGiB" && (spec || reclaimInitial)
                    ? spec
                      ? parseInt(spec.storage.capacity)
                      : Math.max(
                          volumeGiB(reclaimInitial!.volume.capacity) ?? 2,
                          volumeGiB(reclaimInitial!.volume.allocatedCapacity) ??
                            2,
                        )
                    : (selectedTemplate?.inputSchema?.properties?.[key]
                        ?.minimum ?? min)
                }
                max={
                  selectedTemplate?.inputSchema?.properties?.[key]?.maximum ??
                  max
                }
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
            ? t(
                "缓存预算必须小于存储卷容量。配置调整可能重启实例，以策略生效状态为准。",
              )
            : t(
                "此模板未提供引擎容量预算。存储卷容量不是自动清理阈值，请预留空间并管理文件。",
              )}
          {selectedTemplate?.capabilities.lru && t(" 引擎支持 LRU 淘汰。")}
          {selectedTemplate &&
            !selectedTemplate.capabilities.ttl &&
            t(" 暂不支持 TTL。")}
        </p>
        <label>
          {t("运行状态")}
          <select
            value={input.desiredState}
            onChange={(e) =>
              setInput({
                ...input,
                desiredState: e.target.value as Input["desiredState"],
              })
            }
          >
            <option value="Running">{t("运行")}</option>
            <option value="Suspended">{t("暂停")}</option>
          </select>
        </label>
        <label>
          {t("删除实例时")}
          <select
            value={input.deletionPolicy}
            onChange={(e) =>
              setInput({
                ...input,
                deletionPolicy: e.target.value as Input["deletionPolicy"],
              })
            }
          >
            <option value="Retain">{t("保留存储卷")}</option>
            <option value="Delete">{t("同时删除存储卷")}</option>
          </select>
        </label>
      </div>
      {input.template === "webdav-apache" && (
        <p className="notice">
          {t("WebDAV 支持认证文件读写与锁，不提供自动淘汰。")}
          {selectedTemplate?.capabilities.statistics
            ? t("运行后可查看近似内容快照。")
            : t("此版本不提供内容统计。")}
          {t("存储卷容量不是文件系统硬配额。")}
        </p>
      )}
      <div className="actions">
        <button className="primary" disabled={busy || !canSubmit}>
          {busy
            ? t("正在提交…")
            : detail
              ? t("保存配置")
              : reclaimInitial
                ? t("确认领回实例")
                : t("创建实例")}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {t("取消")}
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
  onBusyChange,
}: {
  base: string;
  id: string;
  canWrite: boolean;
  canAdmin: boolean;
  onChange: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(false),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false);
  const [formBusy, setFormBusy] = useState(false);
  const [rotationBusy, setRotationBusy] = useState(false);
  const [observationsOpen, setObservationsOpen] = useState(false);
  useEffect(() => {
    onBusyChange(busy || formBusy || rotationBusy);
  }, [busy, formBusy, rotationBusy, onBusyChange]);
  const [rotating, setRotating] = useState(false);
  const [reclaimTarget, setReclaimTarget] = useState<ReclaimFormTarget | null>(
    null,
  );
  const [reclaimCredentials, setReclaimCredentials] = useState<{
    username: string;
    password: string;
  } | null>(null);
  const [reclaimSubmitted, setReclaimSubmitted] = useState(false);
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
      <h2>{detail?.name ?? t("实例详情")}</h2>
      {(detail?.lifecycle === "detached" || detail?.lifecycle === "failed") && (
        <RetainedVolume
          path={`${base}/instances/${id}/retained-volume`}
          canAdmin={canAdmin}
          onChange={onChange}
          failed={detail.lifecycle === "failed"}
          onReclaim={
            canAdmin && detail.template && detail.templateVersion
              ? (volume) =>
                  setReclaimTarget({
                    path: `${base}/instances/${id}/retained-volume`,
                    volume,
                    name: detail.name,
                    template: detail.template!,
                    templateVersion: detail.templateVersion!,
                  })
              : undefined
          }
        />
      )}
      {reclaimTarget && (
        <div className="notice">
          <h3>{t("从保留卷恢复实例")}</h3>
          <p>
            {t(
              "将重新创建服务并沿用已确认的存储卷。请核对容量和协议配置；新密码只在提交时显示一次。",
            )}
          </p>
          <InstanceForm
            base={base}
            reclaim={reclaimTarget}
            onBusyChange={setFormBusy}
            onCancel={() => setReclaimTarget(null)}
            onSaved={(value) => {
              setReclaimTarget(null);
              setReclaimCredentials(value.credentials ?? null);
              setReclaimSubmitted(true);
              onChange();
            }}
          />
        </div>
      )}
      {reclaimSubmitted && !reclaimCredentials && (
        <div className="notice">
          <p>
            {t(
              "领回请求已提交。此请求已受理过，密码不会再次返回；请等待操作完成，再轮换凭据。",
            )}
          </p>
          <button onClick={() => setReclaimSubmitted(false)}>
            {t("关闭")}
          </button>
        </div>
      )}
      {reclaimCredentials && (
        <div className="notice">
          <p>{t("请保存恢复后的新密码，关闭后无法再次查看。")}</p>
          <label>
            {t("用户名")}
            <input readOnly value={reclaimCredentials.username} />
          </label>
          <label>
            {t("密码")}
            <input
              readOnly
              value={reclaimCredentials.password}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <button
            onClick={() => {
              setReclaimCredentials(null);
              setReclaimSubmitted(false);
            }}
          >
            {t("已保存，关闭")}
          </button>
        </div>
      )}
      <Alert text={error} />
      {detail?.spec && (
        <>
          <div className="detail-grid">
            <p>
              {t("协议")}
              <strong>{templateLabel(detail.spec.templateRef.name)}</strong>
            </p>
            <p>
              {t("淘汰策略")}
              <strong>
                {detail.capabilities?.lru
                  ? `LRU · ${detail.spec.eviction.maxCacheGiB} GiB`
                  : detail.capabilities
                    ? t("不支持自动淘汰")
                    : t("模板能力未知")}
              </strong>
            </p>
            <p>
              {t("存储卷")}
              <strong>{detail.spec.storage.capacity}</strong>
            </p>
            <p>
              {t("期望状态")}
              <strong>
                {detail.spec.desiredState === "Running" ? t("运行") : t("暂停")}
              </strong>
            </p>
          </div>
          {detail.status?.conditions?.map((c) => (
            <div className="notice" key={c.type}>
              {c.type === "Ready"
                ? c.status === "True"
                  ? t("服务已就绪")
                  : t("服务尚未就绪")
                : c.type === "PolicyApplied"
                  ? c.reason === "NotSupported"
                    ? t("不支持自动淘汰")
                    : c.status === "True" &&
                        String(c.observedGeneration) ===
                          detail.revision?.split(":").at(-1)
                      ? t("缓存策略已生效")
                      : t("缓存策略尚未确认生效")
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
          <p className="muted">
            {detail.spec.access?.exposure === "Gateway"
              ? t("通过独立域名访问，请确认证书受信任且域名可达。")
              : t("连接地址当前仅供集群内部使用。")}
          </p>
          <ConnectionInfo detail={detail} />
          {detail.capabilities?.statistics ? (
            <Statistics
              path={`${base}/instances/${id}`}
              running={
                detail.spec.desiredState === "Running" &&
                !["deleted", "detached", "deleting"].includes(detail.lifecycle)
              }
            />
          ) : (
            <p className="muted">
              {detail.capabilities
                ? t("此模板暂不支持容量统计。")
                : t("模板能力未知，暂不查询统计。")}
            </p>
          )}
          <div className="actions">
            {canWrite && (
              <button
                disabled={!available}
                onClick={() => setEditing(!editing)}
              >
                {t("编辑配置")}
              </button>
            )}
            {canAdmin && (
              <button disabled={!available} onClick={() => setRotating(true)}>
                {t("轮换凭据")}
              </button>
            )}
            {canAdmin && (
              <button
                className="danger"
                disabled={!available}
                onClick={() => setConfirm(true)}
              >
                {t("删除实例")}
              </button>
            )}
          </div>
        </>
      )}
      {detail?.revision && <details className="instance-observation-details" onToggle={event=>setObservationsOpen(event.currentTarget.open)}><summary>{t("指标与诊断")}</summary>{observationsOpen&&<InstanceObservability path={`${base}/instances/${id}`} canEdit={canWrite}/>}</details>}
      {detail?.capabilities?.lookupHistory && (
        <LookupHistory path={`${base}/instances/${id}`} />
      )}
      {editing && detail && (
        <InstanceForm
          key={detail.id}
          base={base}
          detail={detail}
          onBusyChange={setFormBusy}
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
          onBusyChange={setRotationBusy}
          onClose={() => setRotating(false)}
          onChange={onChange}
        />
      )}
      {confirm && detail && (
        <div className="notice">
          <p>
            {t("确认删除「{name}」？", { name: detail.name })}
            {detail.spec?.storage.deletionPolicy === "Delete"
              ? t("存储卷也会被删除，缓存数据将丢失。")
              : t("存储卷将保留，服务访问会停止。")}
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
              {t("确认删除")}
            </button>
            <button disabled={busy} onClick={() => setConfirm(false)}>
              {t("取消")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
