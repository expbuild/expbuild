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

上述基本管理链路已通过下文的隔离 kind + Helm + WebDAV 验收；故障恢复分支仍需真实集群验证。Operator 支持多项目 namespace，并在操作前校验 namespace 项目归属；集群级 RBAC 已在一次性 CI 集群中运行，未应用到业务集群。

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
- 轮换切换响应丢失后的恢复、就绪前保留旧凭据、就绪后清理、普通更新不回退密码，以及 UI 重试保留原版本/幂等键。WebDAV 真实引擎拒绝旧密码已通过下文 Helm/API 集群验收；REAPI 轮换链路仍待验收。

以上 API Server 测试没有 kubelet，不证明缓存容器启动、挂载或真实存储故障行为。已完成 bazel-remote v2.6.2 官方二进制的真实 HTTP CAS、REAPI FindMissing、认证和重启持久性测试，详见 [引擎验证记录](engine-validation.md)；仍不替代镜像/PVC/真实集群 PoC。当前没有认证生产镜像；已有隔离 kind 的 Helm 安装验证，仍缺生产集群兼容性认证。

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

新增 `tools/helm_lifecycle.py` 与 CI Helm 任务：使用独立临时集群安装实际 Chart，通过管理 API 创建项目/实例、暂停恢复、密码轮换、升级与删除，再卸载控制面。安装迁移与 bootstrap 使用 Chart 原有钩子。关闭 Ingress，通过本地端口转发访问，因而不验证 TLS 或网络隔离。实际运行结果见下文。

Helm 与管理 API 全链路验收（2026-09-30，提交 922b1fc）：

[隔离集群 CI](https://github.com/expbuild/expbuild/actions/runs/36663871167)两个任务均成功，Operator 生命周期回归和新增 Helm/API 链路均通过。

- 实际 Chart 安装、迁移 Job、管理员 bootstrap、三个控制面工作负载就绪。
- 登录与 CSRF 后通过 API 创建项目，worker 创建真实 namespace 和网络策略资源。
- API 创建 WebDAV 实例、写入数据、暂停恢复、轮换密码；旧密码返回 401，新密码读取原数据；就绪后旧 Secret 被清理。
- 对同一版本执行 Helm upgrade，迁移钩子重新运行，已有缓存数据可读。该检查不代表跨版本升级兼容性已验证。
- API 删除 Delete 策略实例后，CR、工作负载、Service、PVC 和凭据均清理；随后 Helm uninstall 清理控制面 Deployment 并保留 CRD。

测试仍使用固定摘要 Apache 上游镜像；未创建 REAPI 实例。未验证网络策略的实际拦截、外部 TLS/域名、生产 CSI、真实浏览器、worker 故障注入或跨版本数据库迁移。复现步骤见 [测试说明](testing.md)。

保留卷管理：新增 detached 实例的 PVC 查询和管理员异步清理 API，界面详情要求输入卷名确认，操作/审计名称已接入。清理核对 namespace/项目/实例/原 CR UID/PVC UID，禁止存在 CR、ownerReference 或任意 Pod 引用时删除；使用 UID/resourceVersion 前置条件，只在 PVC 消失后完成。API 新增 PVC get/delete、Pod list 权限，仍不能删除 PV。数据库与 SDK 测试通过权限拒绝、替换卷拒绝、占用拒绝、删除响应丢失恢复、并发拒绝和幂等重放；UI 21 项、API 17 项通过；隔离 API Server 已验证新增权限边界。真实 Helm/API 清理链路已通过下文 CI。保留卷领回、定期盘点与生产存储回收认证仍未实现。

保留卷管理验收（2026-09-30，提交 e5a980a）：

- [管理 API 与界面](https://github.com/expbuild/expbuild/actions/runs/36664989493)：成功。
- [Kubernetes/Helm 权限与协议回归](https://github.com/expbuild/expbuild/actions/runs/36664989610)：成功。
- [四个镜像构建与运行检查](https://github.com/expbuild/expbuild/actions/runs/36664989478)：成功。
- [Operator 与 Helm/API 隔离集群](https://github.com/expbuild/expbuild/actions/runs/36664989541)：成功。新增链路通过 API 创建 Retain 实例、删除实例、查询实际 PVC UID、明确提交保留卷清理、等待 PVC 消失并核对实例记录转为 deleted。

所有测试均使用一次性资源；没有向业务集群应用权限或发布镜像。生产存储回收、物理数据擦除、领回和定期盘点仍不在本次验收范围。

独立域名入口适配已编码：采用 Gateway API v1.2.1 HTTPRoute/GRPCRoute，HTTP 与 gRPC 分离子域名并绑定 CR UID；API/界面支持可选 exposure，Helm 管理共享 Gateway 引用与启用配置。Operator 检查当前 Gateway/监听器/路由接纳状态，保留 ExternalReachability=Unknown，并在暂停、切回内部访问或删除前撤销路由。入口网络策略同时匹配数据面 namespace 和 Pod 标签。渲染、状态版本、所有权、暂停清理与真实 Gateway CRD 幂等测试已通过；尚未运行实际 Gateway 代理，DNS/TLS、WebDAV 大文件、外部 REAPI 和 CNI 隔离均待验收。配置和验收边界见 [Gateway 说明](gateway.md)。

Gateway 适配回归（2026-09-30，提交 5edc651）：

- [管理 API/界面](https://github.com/expbuild/expbuild/actions/runs/36666795790)：成功，API 17 项、界面 22 项。
- [Go、协议、Helm/RBAC 与 Gateway CRD 契约](https://github.com/expbuild/expbuild/actions/runs/36666795791)：成功，包含 race、真实 Gateway CRD 重复调谐无写入、状态版本/路由 spec 变化拒绝检查。Gateway 接纳状态由测试模拟，未运行实际代理。
- [四镜像构建与运行](https://github.com/expbuild/expbuild/actions/runs/36666795764)：成功。
- [原有 Operator 与 Helm/API 集群链路](https://github.com/expbuild/expbuild/actions/runs/36666795753)：成功，保持默认 Gateway 关闭，覆盖 WebDAV 和保留卷清理回归。

独立域名仍未完成实际代理认证，不能以以上成功记录替代 TLS、外部 WebDAV/REAPI 和真实网络隔离验收。下一步继续固定一个实际 Gateway 实现并完成数据面测试。

真实入口验收正在推进：新增固定 Envoy Gateway v1.8.5 Chart/镜像摘要与临时 CA，测试 WebDAV TLS、16 MiB 传输、锁与路由撤销。首轮提交 55b270c 的内部 Helm/WebDAV 回归通过，Gateway 任务已完成路由接纳及匿名 HTTPS 拒绝，但负向 TLS 请求导致 kubectl 转发会话退出，后续连接被拒绝；已隔离负向测试会话。提交 1dea942 增加 REAPI 非 root UID/fsGroup、只读根文件系统、独立 tmp 卷以及经 Gateway 的 8 MiB ByteStream/FindMissing/认证轮换测试，本地 Go 回归通过，真实入口结果待 CI 确认。

真实入口第二轮（提交 1dea942）：[隔离集群任务](https://github.com/expbuild/expbuild/actions/runs/36668366042)中的 WebDAV 与内部 Helm 链路通过；Gateway 通过 TLS 负向校验、16 MiB 读写与加锁，但带锁删除断言失败。本地 Apache 复现为未标记 URL 的 If 条件同时影响父目录，返回 424/父目录 412；改为带 HTTPS 文件 URL 的 tagged-list 后原生测试通过。提交 ea1aaa7 修正此测试请求并补充失败响应诊断，继续真实入口验收。

真实入口最终验收（2026-09-30，提交 ea1aaa7）：[隔离 Kubernetes 生命周期 CI](https://github.com/expbuild/expbuild/actions/runs/36669207282)三个任务全部成功：Operator WebDAV、Helm 内部模式、Helm Gateway 模式。实际日志确认 WebDAV TLS/16 MiB/锁、暂停恢复与删除后的数据面撤销；REAPI TLS capabilities/FindMissing/8 MiB ByteStream、HTTP CAS、非 root PVC 运行和凭据轮换保留数据均通过。两个 Go RPC 阶段确实执行并通过，没有跳过。该结果更新以上历史记录中的入口待验收状态；详见 [Gateway 验证边界](gateway.md)和[引擎记录](engine-validation.md)。

下一阶段仍需真实 CNI 流量隔离、Bazel 构建客户端与 ActionCache、独立指标及历史趋势、WebDAV 淘汰适配、配额和模板扩展、资源对账与浏览器端到端验证。整体重构目标继续进行中。

策略生效状态：新增 `PolicyApplied`，当前工作负载和认证引擎容量验证通过后才标为 True；未就绪或探测失败撤回为 Unknown，WebDAV 明确 NotSupported。管理端核对 observedGeneration 与当前 revision，拒绝显示旧版本策略为已生效；表单解释 LRU、重启生效和 WebDAV 无自动清理。模板目录发布 policyApplyMode/policyCondition。Go 与隔离 API Server 回归、API 17 项和 UI 24 项通过。新增真实集群测试将 REAPI 缓存预算从 1 GiB 改为 2 GiB，核对运行容量、状态版本和数据保留；该新增链路等待远程 CI，不提前声称已通过。

策略状态真实集群验收：提交 94be03a 的[隔离集群 CI](https://github.com/expbuild/expbuild/actions/runs/36670160457)三个任务全部成功。Gateway 日志确认容量预算从 1 GiB 调整到 2 GiB 后，PolicyApplied 版本匹配、实际引擎容量更新且数据保留。

独立历史统计第一阶段：新增可选 Prometheus 查询适配、按项目/原 CR UID 授权的历史 API 与按需查看界面；区分 AC/CAS、get/contains、hit/miss，缺失数据不转成零。支持已删除实例的授权历史查询。自动采集部署和真实 Prometheus 联调尚未完成，部署与验证边界见 [监控说明](monitoring.md)。

历史统计真实查询验证：本地使用 SHA256 锁定的 Prometheus v3.15.0 启动独立 TSDB 和受控认证 exporter；三组项目/CR UID 计数速率通过实际采集和 PromQL range 查询验证隔离，缺失序列与有效零值保持区分。已加入 Management API CI，远程运行结果待确认。这不是真实缓存引擎自动采集验收；下一步仍需采集对象生成、网络授权及凭据同步。

真实 Prometheus 合约已通过[远程 Management API CI](https://github.com/expbuild/expbuild/actions/runs/36671435062)（提交 b64d88c）。新增可选 ServiceMonitor 自动化：实例凭据引用同步、固定归属标签、headless 去重、采集网络入口、独立 MonitoringConfigured 状态和关闭/暂停/删除清理。官方 ServiceMonitor v0.94.1 CRD 的隔离 API Server 测试已验证幂等、轮换、归属冲突与关闭清理；缓存就绪不被监控 API 故障阻断的回归通过。真实 Prometheus Operator 与缓存引擎、网络策略执行以及轮换期间采集恢复仍待验证。

ServiceMonitor 补充验证：暂停/恢复、实例删除后的采集对象清理和无变化时 CR 状态/ServiceMonitor 均不重复写入已通过真实 API Server 测试。Helm 启用配置 lint、隔离权限验证与 Go 回归通过；可选监控使用周期调谐，ServiceMonitor 权限限定 get/create/patch/delete。此前历史统计提交 e80621a 和真实 Prometheus 提交 b64d88c 的隔离集群回归也均已通过，均未启用新 ServiceMonitor 功能。

ServiceMonitor 提交 89d3332 的本地 race 与[远程 Kubernetes 回归](https://github.com/expbuild/expbuild/actions/runs/36672451980)通过。新增真实集群监控 fixture，固定官方 Prometheus Operator 部署包与三个镜像摘要，在已有 Gateway 场景中接入实际 bazel-remote 指标、认证轮换、管理历史 API、采集目标去重及删除撤销；完整链路结果等待 CI。

原生淘汰补充验证：本地固定 bazel-remote v2.6.2、默认压缩存储、1 GiB 预算通过三个 400 MiB 不可压缩 CAS 块的超预算测试。完整读取刷新 LRU 后，较旧块被淘汰，保留块 SHA256、最终条目数和实际容量正确。已接入原生引擎 CI；不代表并发、磁盘满或生产存储认证。自动采集完整集群任务 36672925904 仍在运行，等待实际结果。

自动采集完整验收（提交 6966aec）：[隔离集群 CI](https://github.com/expbuild/expbuild/actions/runs/36672925904)三个任务全部成功。固定 Prometheus Operator/Prometheus 镜像实际运行，真实 bazel-remote 的唯一采集目标与管理 API CAS 历史通过；轮换后旧指标凭据拒绝、新凭据成功，并出现晚于轮换完成时间的新健康采样和历史点；删除后 ServiceMonitor 与活跃目标移除。未验证真实 CNI 执行、监控 HA/持久存储和浏览器端到端。

原生 LRU 的[远程 Kubernetes CI](https://github.com/expbuild/expbuild/actions/runs/36673243140)通过（提交 940e507），包含超过 1 GiB 预算的不可压缩数据淘汰测试。统计界面另修复实例切换后旧请求晚到覆盖当前数据的竞态，并增加回归。

网络隔离验收已接入独立 CI 模式：kind 禁用默认 CNI，安装兼容 Kubernetes 1.32 的固定 Cilium 1.19.7 Chart/镜像摘要；真实 Pod 分别对 Service/Pod IP 验证项目、客户端、Gateway、监控的 AND 选择器与端口范围，并撤销/恢复 namespace 和 Pod 标签测试新连接。已有 TLS/监控链路在相同 CNI 环境继续执行。本地渲染和连接探针分类通过，实际 CNI 结果待远程任务，尚不宣称已完成隔离验收。

Cilium 首轮结果（提交 a83b85d）：[隔离集群 CI](https://github.com/expbuild/expbuild/actions/runs/36674390223)的内部、WebDAV、Gateway 三个任务成功。isolation 任务中 Service/Pod IP 的全部隔离矩阵与 namespace/Pod 授权撤销恢复通过，随后 REAPI TLS、预算更新、真实指标和轮换后 REAPI 也通过；在旧指标凭据的 HTTPS 请求遭遇 RemoteDisconnected 后整项失败，不能记录为完整成功。测试客户端现对 GET 的连接中断最多重试两次，每次重新建连；不重试写入、证书验证失败或 HTTP 状态响应，认证断言仍要求精确状态。待新 CI 验证。

真实 Bazel 客户端新增本地验收：固定 8.8.1 对 HTTP 与 REAPI 分别执行首次构建、全新本地缓存的远程命中构建、禁用远程缓存的失败对照，六次构建全部符合预期，确认 ActionCache/CAS 产物恢复而非本地复用。已接入原生引擎 CI；该客户端尚未经 Gateway/TLS，详见引擎验证记录。

项目配额第一阶段：新增实例数、存储、CPU、内存四项额度，平台管理员可调整，项目成员可查看；请求受理与预留在同一事务中，worker 完成后按生命周期释放，失败资源和保留卷不提前释放。升级按历史配置最大值回填，未知预留不当零。已补配额界面、OpenAPI、审计与版本保护；本地 PostgreSQL 并发/迁移测试、原 worker 生命周期配额断言及界面组件测试通过。真实 Helm/API 场景已增加超额拒绝、暂停预留和保留卷清理释放断言，待 CI 验证。当前是管理 API 限额，Kubernetes ResourceQuota 和资源对账尚待接入，见 [配额说明](quotas.md)。

提交 bd49142 的[真实引擎与 Operator CI](https://github.com/expbuild/expbuild/actions/runs/36675328802)通过，固定 Bazel 客户端 HTTP/REAPI 构建及禁用缓存对照已在 CI 执行。镜像构建通过；完整 Cilium 集群任务仍待最终结果。

Cilium 第二轮（提交 bd49142）：[集群 CI](https://github.com/expbuild/expbuild/actions/runs/36675328813)中内部、WebDAV、Gateway 成功；隔离模式再次通过完整流量矩阵和 REAPI TLS，但 HTTPS GET 断线重试后本机转发端口拒绝连接。测试传输层新增进程句柄检查，仅在 kubectl 已退出时重建转发，保留三次尝试上限、证书验证及精确 HTTP 状态断言。单元测试覆盖已退出/仍存活进程、重试上限、写入和证书错误不重试；真实集群结果待新 CI。

Kubernetes 硬配额已接入：后台同步 namespace ResourceQuota，观察 spec/status.hard/used 的当前版本，实例写操作等待配额就绪，清理操作不被同步门槛阻断；归属、scope、数量等价与 UID/resourceVersion 保护已覆盖。管理界面区分保存与同步。真实 PostgreSQL 多副本/失败恢复/操作等待测试、SDK 请求契约、32 项界面测试和 envtest 最小权限检查通过；真实集群准入拒绝验收已加入，待 CI。

Cilium 第三轮（提交 90a77c5）：[集群回归](https://github.com/expbuild/expbuild/actions/runs/36676376014)的内部、WebDAV、Gateway 成功。隔离流量矩阵和 REAPI TLS 通过后，HTTP CAS PUT 遭遇 RemoteDisconnected；写操作没有被重试，整项仍失败。新增私有临时文件保留端口转发进程的有限日志，下一轮失败将输出退出状态与有界错误尾部，以查明传输中断根因。没有将这一结果记为完整 Cilium 验收通过。

只读资源对账已实现：后台租约分工、分页读取 CR/PVC、namespace 身份核对、实例绑定和操作指纹变化检测；报告缺失、归属/UID 冲突、配置差异、保留卷异常和未登记资源。新增项目授权 API、刷新入口和带时间/过期提示的管理面板。不改写生命周期或配额，不自动删除。PostgreSQL 租约/变化/失败测试、SDK 分页和归属测试、35 项界面测试、构建与 envtest 只读权限检查通过；真实 Helm/API 注入孤立 PVC 并检查检测/不删除/恢复的场景待 CI。详见 [资源对账](inventory.md)。

提交 f1a62a6 的[隔离集群验收](https://github.com/expbuild/expbuild/actions/runs/36677378119)中 WebDAV、Gateway、Cilium isolation 三个任务成功；Cilium 首次完整通过网络隔离及授权撤销、REAPI TLS/HTTP CAS、预算变更、认证轮换、真实 Prometheus 采集、删除与卸载。日志确认两次 GET 断线后，已退出的 kubectl 转发会话被恢复，写断言未放宽。该结果仅覆盖单节点 kind 与固定 Cilium，生产多节点等仍待验证。

同一轮 internal 任务在首次 ResourceQuota used 初始化处超过四分钟。原生 Kubernetes 1.32 控制器的隔离复现确认：运行中新增 CRD 后，内置资源计数已初始化而自定义 count 项暂缺；平台正确保持 Pending。验收窗口已调整为七分钟，覆盖官方默认五分钟重同步周期，实际请求超时和就绪判断保持原要求。另修复连接地址尾斜杠导致 SDK 请求路径出现双斜杠的问题，并补充配额失败的安全状态码和 CI 状态诊断。

配额启动时序复现完成：本机独立 API Server/etcd 加固定 SHA256 的官方 kube-controller-manager v1.32.0，仅启用 resourcequota 控制器；控制器启动后再安装 CRD，先观察到 used 缺少自定义 count，约五分钟后由真实控制器补齐，平台原有判断返回就绪。没有手工填充本次 status，也没有放宽缺失计数条件。隔离进程已正常停止。

提交 3872cfe 的[隔离集群 CI](https://github.com/expbuild/expbuild/actions/runs/36679678906)四项全部成功：WebDAV、Helm internal、Gateway、Cilium isolation。包含只读资源对账的孤立 PVC 检测、不自动删除、人工移除后恢复，以及首次硬配额初始化等待窗口的回归。管理 API、平台回归和四镜像构建亦成功。

模板扩展第一步：Operator 新增 internal/templates 注册表，以完整名称/版本选择编译内适配器，统一受信镜像、淘汰策略校验、资源渲染和内部端点生成。未知版本不回退，调用者无法覆盖安装配置中的镜像。控制器与双引擎回归和模板边界测试通过。当前不支持动态插件；API schema/能力目录、探测、入口和监控仍需进一步统一，不能将这一阶段视为完整模板扩展框架。

模板探测适配：认证 WebDAV 和 REAPI/容量探测已从通用 controller 移入各自引擎包，由模板注册表按名称及精确版本选择。未知模板或版本直接拒绝，不再隐式回退到 REAPI；镜像是否启用仍在渲染阶段独立检查。测试覆盖未知版本在网络访问前拒绝、已注册模板调用认证探测、真实 Apache 正确/错误凭据和既有协议断言；真实 bazel-remote、隔离 API Server 契约和受影响模块 race 检查通过。API 能力/schema、Gateway、监控和策略状态仍有引擎相关分支，继续统一；这次改动不增加新的协议或淘汰能力。

API 模板目录统一：新增 template-catalog.ts，将配置 schema、版本、策略映射、公开协议/能力和创建启用判断集中定义；目录接口与 desiredObject 使用相同定义，不再分别硬编码策略和版本。停用模板仅阻止新建，已有实例仍可维护。新增 tests/contracts/templates.json，由 TypeScript 与 Go 两侧测试共同读取，验证目录完整性、版本/策略与实际渲染和内部端点契约；样例变化触发双方 CI。公共 WebDAV 的 http 标识表示传输能力，内部连接端点仍只声明 webdav。当前仍是编译内模板，Gateway/监控/策略状态与管理界面还需进一步按能力解耦，未提供动态插件或引擎升级。

入口与监控模板能力统一：注册表按精确模板版本提供 HTTP 协议/端口、可选 gRPC 端口和可选指标端口/路径；Gateway 路由、入口 NetworkPolicy、ServiceMonitor、采集 NetworkPolicy 及监控启用条件读取此定义，删除对应引擎名判断。未知版本不能渲染路由/监控或发布端点，WebDAV 仍无 gRPC 和自动采集。共享契约补充端口与统计支持字段，测试实际 Service 端口与声明一致；TypeScript 契约及 Go 受影响模块 race 测试通过。具体协议探测、指标认证语义仍由编译内适配负责，不能仅添加一个端口就宣称支持新引擎。

本轮隔离 API Server 验收：CacheInstance/RBAC、Gateway v1.2.1 和固定 ServiceMonitor CRD 三项契约测试实际运行通过，覆盖重复调谐、归属及清理；不把 API 对象验证等同于新提交的完整代理/采集链路，完整集群回归由后续 CI 确认。

管理界面模板表单：移除创建目录的模板名称白名单，按模板 capacity 能力显示预算输入，读取公共数值字段 schema 的上下界；切换模板时清除不受支持的 Gateway 选项，无预算模板初始化为零。编辑现有实例按模板名称和版本匹配目录；停用模板不阻断编辑，目录缺失时保留实例已有预算能力，不套用其他版本。新增组件场景覆盖额外模板名称、数值范围、无预算初始化和入口切换。当前仅支持已有公共配置字段，不宣称已实现任意 JSON Schema 表单；详情统计和连接指引仍需能力化。

客户端连接指引：详情页按实际就绪端点提供 REAPI/Bazel HTTP 构建命令和 WebDAV 只读 PROPFIND 示例；仅在 Ready 的 observedGeneration 匹配当前 revision 且实例运行时展示。Bash 交互输入凭据，页面不读取或保存真实密码，拒绝含 userinfo/query/fragment 的端点和不匹配协议，地址采用单引号转义。说明内网可达性、TLS 信任和 Bazel 项目目标；不添加远程执行配置。组件回归覆盖旧状态、暂停、保留卷和异常端点，真实 Bash 加受控客户端函数验证参数与认证编码、地址不会执行命令替换。该测试检查示例生成，不等同于真实浏览器或新一轮外部客户端验收。

模板探测重构的完整集群回归：提交 6246d9d 的任务 36684833656 中 WebDAV、internal、Gateway 成功，Cilium isolation 失败。失败发生在 REAPI 后的 HTTP CAS PUT，RemoteDisconnected；新增转发日志确认 kubectl 以 1 退出，Pod 内 127.0.0.1:10443 返回 connection reset by peer，代理 Pod 为 Running 且无重启。不能据此断言是 Operator 回归，也不能据此证明代理无问题。保持写请求不重试、严格 HTTP 状态断言不变；失败现场新增 Envoy Pod 状态与最近 100 条日志中的传输字段白名单输出，省略原始日志、请求头和路径，诊断异常不会覆盖原始错误。五项传输恢复/诊断测试通过，仍需真实失败现场或完整成功结果确认。实例详情统计能力统一暂缓，优先补充此验收问题的可观测信息。

实例能力与版本持久化：migration 008 为绑定记录增加 template_version，新建时与操作请求同时保存；旧数据从名称匹配的创建请求回填，缺失或冲突版本保持 NULL。详情发布 templateVersion 和可空 capabilities，按实际 CR 精确版本或删除后绑定版本解析；未知版本不回退最新版。历史查询按持久化版本的 lookupHistory 能力授权，实时查询按实际版本 statistics 能力，读写拒绝已记录版本与 CR 不一致。UI 按详情能力显示实时统计、历史入口与策略，未知能力不请求指标。迁移幂等/缺失/冲突/未来版本及 PostgreSQL 生命周期、删除后历史授权测试通过；界面新增不同模板名与未知能力场景，OpenAPI 已同步。该变更不实现引擎升级，未来升级需事务性更新版本绑定；未接入 WebDAV 指标。

真实浏览器第一阶段完成本地验收：固定 @playwright/test 1.63.0 与配套无头 Chromium，使用生产前端构建、实际管理 API 和独立 PostgreSQL 数据库；两条浏览器流程通过登录退出、项目创建、配额持久化、CSRF/跨项目拒绝、多标签页旧配额版本冲突。启动器只管理随机测试数据库，未接入 Kubernetes，项目保持 pending；CI 已加入同一入口。首次本机缺少浏览器运行库和临时空间，已通过隔离目录补齐后实际执行成功。浏览器创建缓存实例和数据面操作仍待后续。自动审批拒绝了失败截图/trace 的外部上传，因此 CI 仅执行测试，没有上传步骤。

模板阶段完整集群结果更新：a1af3a1（36685206113）、3a1be3f（36685638018）、91a646e（36686046776）、0c5a3ec（36686403726）的隔离集群任务均成功，覆盖 internal、Gateway、Cilium 和 WebDAV。此前 6246d9d 的单次连接重置仍保留为历史失败，不能据后续通过宣称已定位其根因。

企业监控查询认证：管理 API 支持可选 Prometheus Bearer token，Helm 引用控制面现有 Secret 的 bearer-token 键，仅向 API 注入；默认不认证，配置 token 时必须有查询 URL。凭据校验拒绝空值、控制字符和超长输入，使用 JS 私有字段避免对象序列化泄漏；请求仍拒绝重定向。真实 HTTP 服务验证正确/错误认证和不跟随重定向，31 项 API 回归全部通过，包含真实 Prometheus 采集历史；Helm 渲染和真实 API Server/RBAC 契约通过。Secret 轮换需重启 API，尚不支持其他查询认证适配。

浏览器 CI 首轮 cfe6799 在 npm ci 阶段失败，原因是新增包的锁文件使用本机镜像源 mirrors.tencentyun.com，GitHub runner 无法解析。三个 Playwright 包已逐个核对官方 npm 完整性摘要，并替换为 registry.npmjs.org 下载地址；不更换包版本或摘要。继续以干净安装、构建和真实浏览器流程验证修复。

资源对账增强：新增独立模板名称/版本核对，以及实际 CR CPU/内存/存储、归属 PVC 请求与分配容量是否超过预留的只读校验。暂停保留资源承诺，detached 只核对存储，未知预留与无效数量明确报告；不自动释放历史较高预留。资源数量采用有界 BigInt 比例比较，避免浮点精度和不同单位导致的错误结论。模板/预留字段纳入扫描指纹，真实 PostgreSQL 测试确认扫描中改账撤回为 InProgress。32 项 API 测试通过（1 项真实 Prometheus 本轮未启用），44 项界面测试及构建通过；新增具体用例覆盖模板冲突、预留不足、卷实际扩容、暂停、detached 和只读语义。自动修复与账目校正仍待实现。

浏览器远程验收：ddc0f91 的管理 API CI 36688902197 成功，已包含安装 Chromium 与真实浏览器管理流程；官方源锁文件修复生效。同提交 Kubernetes 平台与容器构建成功，完整隔离集群仍在运行。

资源预留单实例校正：平台管理员入口在重新扫描 namespace、核对实例/PVC 归属与 UID、模板/配置、并发操作及数据库扫描指纹后，将存储/CPU/内存历史预留提高到实际资源需求；detached 仅校正存储，不降低旧预留或改写 Kubernetes。真实 PostgreSQL 测试覆盖权限、超额仍如实记账、只增不减、扫描并发拒绝和审计；界面仅在新鲜无其他异常的差异中显示处理按钮。该功能不处理其他资源差异，也不能代替分布式资源的持续扫描。最新 2fde2b4 隔离 CI 的 internal、Gateway、WebDAV 通过；isolation 在安装 Cilium 时因 helm.cilium.io 连接重置失败，尚未进入流量断言。固定摘要下载增加有限重试，等待新 CI 验证。

真实 Helm/API 生命周期脚本新增资源预留故障注入：实例和 PVC 就绪后，只在一次性 PostgreSQL 中压低该实例账面存储预留，等待资源对账报告不足；再通过平台管理员 API 修正，核对额度恢复、清单转 Healthy 且 PVC 仍存在。该场景尚待新提交的隔离集群 CI 执行，不把脚本存在视为真实验收通过。

提交 b04b322 的[隔离集群 CI](https://github.com/expbuild/expbuild/actions/runs/36692547210)四个任务全部成功：内部、Gateway、Cilium 隔离与 WebDAV。真实 PostgreSQL 账目故障注入报告预留不足，管理 API 校正后配额和清单恢复，PVC 保留；Cilium 固定摘要下载重试未削弱隔离流量断言。

保留卷领回实现进行中：CRD 增加固定旧实例 UID/PVC UID 的不可变领回字段，Operator 只有在新 CR UID 已持久绑定并收到授权标记后才转移 PVC；逐项核对归属、容量、访问模式、Pod 占用及卷状态。管理 API 已接入配额预留、独立凭据和异步操作，worker 支持创建响应丢失恢复与就绪后旧凭据清理，界面复用实例配置表单。PostgreSQL + 模拟 Kubernetes、SDK 合约和 Operator 单元测试通过；真实 PVC 数据保留、Helm/RBAC 和 CRD admission 验收仍待本轮执行。详见[领回设计](retained-volume-reclaim.md)。

提交 9048b17 的[隔离集群 CI](https://github.com/expbuild/expbuild/actions/runs/36698708924)四个任务全部成功，覆盖 WebDAV、Helm 内部、Gateway 和 Cilium 模式。Helm/API 真实领回场景确认同一个 PVC UID 与内容保留，新旧 CR UID 不同，PVC 归属转移，新凭据可读取原文件，随后再次 Retain 删除及显式清理成功。管理 API、平台测试和四镜像构建也成功；生产 CSI 的多节点重挂与故障恢复仍待认证。

WebDAV 实时内容统计实现进行中：新建模板提升为 0.2.0，旧 0.1.0 精确版本继续维护。受信 Operator 镜像加入只读扫描程序，通过独立受认证端口报告文件数、大小和申请卷容量；sidecar 与 Apache 分摊实例原有 CPU/内存预算，管理 API 与界面按版本显示近似快照，不宣称硬配额或命中率。单元测试及真实 kind/Helm/API 断言已加入，完整验收以新 CI 结果为准。WebDAV 淘汰与请求指标仍未实现。

提交 78b7d62 的[集群 CI](https://github.com/expbuild/expbuild/actions/runs/36703169393)四项均失败：WebDAV 示例被 CRD admission 拒绝，三个 Helm 场景在首个 WebDAV 创建操作返回 `kubernetes_422`。根因是 CRD 的模板版本枚举仍只有 `0.1.0`。已扩展版本枚举并用 CEL 限定 Bazel 仍只接受 `0.1.0`，两份 CRD 清单重新生成；实际 API Server 测试同时覆盖新版本接受和不支持版本拒绝。需等待修复后的完整集群 CI，不能把本地测试视为新功能真实通过。

提交 7b413b1 的[隔离集群 CI](https://github.com/expbuild/expbuild/actions/runs/36704385247)四项全部成功：WebDAV、Helm 内部、Gateway 和 Cilium 隔离。真实 WebDAV 模式验证 `/status` 认证、文件数量与大小采样及轮换后旧凭据拒绝；Helm 内部日志明确确认管理 API 读取到内容快照，同时再次验证保留卷领回。镜像构建与平台测试亦通过。后续扫描器将目录读取改为每批 256 项并限制目录深度 128，以免平铺大目录单次载入所有名称；该优化的真实集群回归仍待下一轮 CI。

提交 87a04da 的[隔离集群 CI](https://github.com/expbuild/expbuild/actions/runs/36706302289)四个模式全部成功；平台测试和镜像构建也成功。浏览器验收扩展为真实前端、管理 API、独立 PostgreSQL 与异步 worker 的实例创建、一次性凭据、暂停、恢复和删除流程；仅 Kubernetes 边界使用确定性的测试替身，不能替代上述真实集群的数据面验收。本地三条浏览器流程全部通过。WebDAV 创建表单的说明已按模板版本展示 0.2.0 的近似内容快照能力，仍明确无自动淘汰。
