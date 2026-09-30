# 实施状态

分支：`feat/k8s-cache-platform`。本文件记录实际代码与验证边界，不替代完整实现计划。重构以新架构为准，旧代码不强制保留。

## 已实现

- `operator/api/v1alpha1`：CacheInstance API、生成的 CRD、不可变项目/实例身份与状态子资源。
- `operator/internal/bazelremote`：配置校验和确定性资源生成，独立 PVC、不可变配置版本、Service、StatefulSet。
- `operator/internal/controller`：调谐、凭据归属与资源 UID 校验、配置/凭据版本更新、暂停、finalizer 与 Retain/Delete 存储流程。
- Operator readiness：当前工作负载版本、卷绑定、认证 HTTP 状态及容量、认证 REAPI capabilities 探测。
- 主仓库 Node workspaces 与 `apps/admin-api`：新 PostgreSQL 模型、checksum migration、管理员 bootstrap、密码哈希、哈希化会话、Origin/CSRF、用户管理、项目成员权限与审计。
- Go 和 API 的 CI 工作流。
- `apps/admin-web`：React/TypeScript 管理界面，登录/会话恢复、项目创建与切换、实例创建/配置编辑/暂停恢复/删除确认、状态与连接地址、操作记录轮询及一次性凭据展示。
- 用户创建/启停、项目成员按邮箱授权/改角色/移除及审计查询界面；成员变更在数据库事务内校验权限和唯一管理员约束，移除立即影响已有会话的项目访问。
- 三个多阶段容器构建定义，以及 Helm 控制面部署、分离 ServiceAccount/RBAC、迁移/初始化 Job、同源 HTTPS 入口与安装升级卸载文档。

- 本人修改密码与平台管理员重置密码，变更后撤销目标账号全部会话；登录在事务内复查密码版本，避免并发重置后签发旧密码会话。

## 已编码，待端到端验证

- 管理 API 的 Kubernetes 适配、项目 namespace 初始化、实例创建/更新/删除与操作查询。
- OpenAPI 3.1 运行时入口、离线 JSON 导出和客户端接入指南；包含会话/CSRF、权限、异步操作、幂等和版本条件。CR spec/status 的精细类型仍以 CRD 为准。
- 项目初始化失败后的管理员重试 API/界面，沿用原 namespace，事务内权限校验、幂等去重及单次初始化约束；真实 PostgreSQL 测试覆盖失败到恢复。
- PostgreSQL 异步 worker、租约、幂等请求、UID 与 generation 冲突保护。
- 实例凭据生成及 AES-GCM 加密交接，操作结束清除队列中的密文。
- 管理员凭据轮换 API/界面：新建不可变 Secret、切换实例引用、等待新配置生效、清理更旧版本；普通更新保留已轮换的引用，删除实例清理所有已记录凭据版本。

以上链路尚未通过真实集群验收。Operator 已支持多项目 namespace，并在操作前校验 namespace 项目归属；集群级 RBAC 清单已获授权编写和测试，未应用到实际集群。

- 实例统计 API/界面：按项目授权读取引擎容量、条目数和预留空间，固定服务地址、校验凭据归属、限制响应体和超时；失败不返回伪造零值，界面标记采集时间。命中率与历史趋势尚未实现。

- Operator 在滚动就绪/确认暂停后清理旧不可变 ConfigMap，保留当前模板和所有已观察 Pod 引用；检查控制器 UID、实例 generation、工作负载版本及删除前置条件。

- WebDAV Apache 渲染器、CRD 引擎能力约束、Operator PROPFIND 就绪检查和可选 Helm 镜像已实现，已接入管理 API 的模板启用和能力校验，管理界面已支持模板目录选择、保留原引擎编辑以及隐藏不支持的统计与预算；详见 [WebDAV 进度](webdav.md)。

## 已验证

- Go 单元测试、控制器 fake client 生命周期测试、真实 HTTP/gRPC 探测测试。
- 真实 Kubernetes 1.32 API Server + etcd 的 CRD 安装、不可变归属、generation/status 和资源调谐测试。
- TypeScript 编译，以及真实 PostgreSQL 18 的迁移、登录、CSRF、用户与项目权限隔离测试。
- 操作凭据加密的随机性、操作身份绑定、错误密钥与篡改/截断拒绝测试。
- 真实 PostgreSQL 配合模拟 Kubernetes 的创建响应丢失恢复、过期 worker 租约接管且仅提交一次完成记录、并发更新拒绝、旧版本拒绝、Retain 删除与密文清除。
- Kubernetes SDK 实际 HTTP 请求的 NetworkPolicy 来源限制序列化、请求超时与配置被外部修改后的重试拒绝。
- 隔离 API Server 上安装 RBAC 清单并通过 SubjectAccessReview 验证允许/拒绝边界，包括 Secret 只读、禁止删除 PV、选主仅限控制面 namespace。
- Helm 渲染后的身份和权限也在隔离 API Server 中安装验证：22 项授权检查覆盖跨 namespace 实例管理、Secret 读写职责、状态更新、选主范围，以及管理页面无资源权限；不启动工作负载，不应用到实际集群。
- 前后端生产构建；界面组件测试覆盖登录、只读用户、容量校验、CSRF 与一次性凭据清除。操作列表有真实 PostgreSQL 的跨项目权限测试。尚未做真实浏览器视觉验收。
- Helm strict lint、资源渲染、隔离 API Server 的 Deployment/Service/Job/Ingress/RBAC dry-run 校验、错误配置拒绝与 CRD 同步检查。本机没有容器运行时；提交 d90d0a7 的四个容器镜像已通过 GitHub Actions 实际构建，后续提交 69a520f 已增加并通过下述容器运行检查，完整集群验收仍待完成。
- 用户管理确认交互、按邮箱添加成员、移除成员后的即时权限撤销、唯一管理员不可移除和审计落库；最近验证：API 16 项、界面 18 项测试通过。
- 轮换切换响应丢失后的恢复、就绪前保留旧凭据、就绪后清理、普通更新不回退密码，以及 UI 重试保留原版本/幂等键。真实引擎拒绝旧密码仍待完整集群验收。

以上 API Server 测试没有 kubelet，不证明缓存容器启动、挂载或真实存储故障行为。已完成 bazel-remote v2.6.2 官方二进制的真实 HTTP CAS、REAPI FindMissing、认证和重启持久性测试，详见 [引擎验证记录](engine-validation.md)；仍不替代镜像/PVC/真实集群 PoC。当前没有认证生产镜像或完整集群安装。

真实引擎测试已在提交 d90d0a7 的 Kubernetes platform 远程 CI 中执行通过。

OpenAPI 标准校验、全部已注册路由覆盖、引用解析、发布 JSON 与运行时契约一致性测试已通过。

真实 Apache 2.4.66 的认证、MKCOL、PUT/GET、PROPFIND、LOCK 与受锁约束的 DELETE 已通过。

## 后续必需工作

1. 完整集群验证实例 CRUD、worker 恢复及凭据轮换，补齐失败操作处理与资源对账。
2. 多项目 Operator 完整部署联调、细分 conditions 与保留卷管理。
3. bazel-remote 固定镜像与真实客户端验证；WebDAV 浏览器联调、淘汰和指标适配。
4. 管理界面补齐模板扩展、统计与策略页面；浏览器联调与连接配置验证。
5. TLS/独立域名入口、NetworkPolicy、指标采集和授权查询。
6. Helm 完整安装升级卸载联调、Operator 集群运行、API/SDK 真实集群 E2E 与兼容矩阵。

完整目标保持进行中；不能以当前模块测试通过代替上述验收。

实例列表新增持久化模板字段；迁移从已有创建操作恢复引擎名称，真实 PostgreSQL 测试覆盖历史 WebDAV 数据回填及重复迁移。界面测试覆盖启用目录、WebDAV 创建、已有实例暂停提交与不采集不支持的统计。

失败操作恢复第一步：新增管理员操作重试 API 与幂等记录，针对已绑定 UID/目标版本的 create/update/rotate 恢复原操作就绪检查；禁止重试被后续操作替代的请求，保留失败审计。不重新创建资源或恢复已清理的明文凭据。真实 PostgreSQL + 模拟 Kubernetes 测试覆盖超时、重复请求、UID 替换拒绝和后续操作冲突；管理员界面已接入恢复确认、错误展示和幂等请求重试；删除失败恢复已接入；未绑定失败创建的已有资源认领已实现；资源缺失与孤立凭据清理仍待实现。

删除失败恢复：沿用原操作 UID 与已捕获策略，管理员显式确认继续删除。测试覆盖 CR 删除后凭据清理恢复、替换 UID 拒绝、策略变化拒绝和重复请求不重启操作；完整集群删除故障仍待验收。

未绑定创建恢复：响应丢失并终止失败后，凭据密文已清除，仍可通过原操作核对并绑定已有 CR。真实 PostgreSQL + 模拟 Kubernetes 测试覆盖缺失、操作标识、项目标签、spec 冲突拒绝及匹配资源恢复，不调用创建接口。完整集群响应丢失验收仍待完成。

客户端网络入口：项目初始化及创建实例前补齐项目客户端 NetworkPolicy，要求管理员授予 namespace 项目标签并且 Pod 标记 client=true，仅放行 TCP 8080/9092。SDK HTTP 测试覆盖 AND 选择器序列化、重复创建恢复及异属/篡改策略拒绝。未在真实 CNI 验证流量隔离，已有项目不创建新实例时仍需补装策略。

远程 CI 核验（提交 7fa6b92）：Kubernetes platform 成功；Management API 在 npm ci 阶段因锁文件的环境内镜像源无法解析而失败；容器构建因 httpd:2.4.66-bookworm 不存在失败，并取消了其他镜像任务。已将依赖地址改为公共 npm Registry，WebDAV 基础镜像更新为官方确认存在的 2.4.68-trixie 固定摘要，并关闭构建矩阵 fail-fast；修复后的提交 d90d0a7 已完成全部远程任务，结果如下。

远程验收记录（2026-09-30，提交 d90d0a7）：

- [管理 API 与界面构建、测试](https://github.com/expbuild/expbuild/actions/runs/36662004293)：成功。
- [Kubernetes、Helm、真实引擎协议测试](https://github.com/expbuild/expbuild/actions/runs/36662004283)：成功。
- [admin-api、admin-web、operator、webdav 四镜像构建](https://github.com/expbuild/expbuild/actions/runs/36662004310)：全部成功。

构建流程 push=false，未发布镜像。构建成功不证明入口命令、非 root 卷权限或完整集群运行成功。

容器运行检查（2026-09-30，提交 69a520f）：

[四镜像构建与运行检查](https://github.com/expbuild/expbuild/actions/runs/36662736536)全部成功；
[Kubernetes 回归](https://github.com/expbuild/expbuild/actions/runs/36662736517)成功。

- admin-api：生产依赖镜像以非 root、只读根文件系统运行，连接临时 PostgreSQL，迁移、bootstrap、健康/就绪接口、登录和会话读取通过。
- admin-web：非 root、只读根文件系统下启动，健康接口、页面、CSP 和 API 路径隔离通过。
- webdav：使用 Operator 嵌入的同一份 Apache 配置，非 root、只读根文件系统及 uid=1000 临时数据挂载下，通过匿名拒绝、认证 MKCOL、PUT/GET、PROPFIND、DELETE。
- operator：distroless 镜像中的可执行入口与参数帮助通过；未连接集群，不代表控制器在 Pod 内已完成调谐。

测试 Docker 容器、临时数据库和网络在任务结束时清理，不发布镜像、不连接业务集群。
WebDAV 使用 tmpfs，尚未验证 PVC、持久化重启及 CSI 权限；API 使用不执行实例操作的测试 kubeconfig。

隔离 Kubernetes 生命周期验收（2026-09-30，提交 614f283）：

[真实 kind 集群测试](https://github.com/expbuild/expbuild/actions/runs/36663333298)通过。Operator 以两副本运行，验证 WebDAV 的真实 PVC、Pod 重建后数据保留、暂停恢复、认证引用切换、选主接管、Retain 保留 PVC 和 Delete 删除 PVC。该流程直接创建 CR，尚不覆盖管理 API 或 Helm 安装。使用 kind 自带存储；不代表生产 CSI 或网络策略已认证。

新增 `tools/helm_lifecycle.py` 与 CI Helm 任务：使用独立临时集群安装实际 Chart，通过管理 API 创建项目/实例、暂停恢复、密码轮换、升级与删除，再卸载控制面。安装迁移与 bootstrap 使用 Chart 原有钩子。关闭 Ingress，通过本地端口转发访问，因而不验证 TLS 或网络隔离。实际运行结果待 CI 确认。
