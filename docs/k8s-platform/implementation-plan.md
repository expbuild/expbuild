# expbuild Kubernetes 平台实现方案

日期：2026-09-29。状态：实现基线，首批代码已启动，尚未部署。配套 [架构与产品说明](README.md)。

当前进度见 [实施状态](progress.md)。`feat/k8s-cache-platform` 已有 [Operator](../../operator/README.md) 与 [新管理 API](../../apps/admin-api/README.md)。完成部分资源调谐、权限和数据库基础不等于端到端平台完成；引擎认证、实例操作队列、管理界面、多引擎及交付验收仍需继续。

## 1. 交付目标与决策

实现一个企业自托管的缓存服务管理平台：用户在控制台选择引擎模板，创建独立实例，获得访问地址与客户端配置，查看实例统计，调整缓存策略，并管理暂停、恢复、升级和删除。

首期正式交付需要两种引擎适配：bazel-remote（REAPI 与 Bazel HTTP）和经过验证的 WebDAV 引擎。只有 bazel-remote 的版本属于可演示里程碑，不称为首期全部完成。Gradle HTTP、HTTP 上游代理、更多 REAPI 引擎后续扩展。

| 决策 | 实现基线 |
|---|---|
| 仓库 | 统一仓库，管理界面、API、Operator 独立组件 |
| 管理界面 | React + TypeScript，迁移有用 UI，围绕项目与实例重构 |
| 管理 API | TypeScript，Kubernetes SDK，OpenAPI 契约 |
| 管理数据 | PostgreSQL，版本化 migration |
| 实例调谐 | Go + controller-runtime，CacheInstance CRD |
| 工作负载 | 首期单副本 StatefulSet，每实例独立 PVC |
| 模板 | 随平台发布的版本化描述、schema、编译内适配器 |
| 统计 | Prometheus 兼容查询，业务指标与资源指标分离 |
| 入口 | 共享 TLS 入口、每实例稳定域名；首期只认证一个入口适配实现 |
| 交付 | Helm 安装包、固定镜像清单、企业仓库映射 |
| 扩展边界 | 新引擎接入模板适配器，不改用户/项目/API 基础模型 |

单集群和单副本是首期范围，不承诺所有引擎可直接多副本运行。开发机器、操作系统、K3s、kind 或云厂商不作为约束。旧统一 CacheCatalog、跨引擎去重及远程执行方案不进入当前实现。

## 2. 模块职责与调用关系

```text
admin-web → admin-api → PostgreSQL（身份、归属、操作和审计）
                    → Kubernetes API（CacheInstance、凭据）
                    → Prometheus API（授权后的限定查询）

operator → Kubernetes API（监听 CR，维护工作负载/卷/入口，写 status）

构建工具 → 实例域名 → 共享入口 → 缓存引擎 → PVC
```

管理 API 不执行 shell/kubectl 来完成日常管理，不通过用户输入拼装任意 Kubernetes 对象。Operator 不处理用户登录、项目成员和缓存文件内容。管理组件故障时已运行的缓存实例应可继续服务，前提是其原生凭据和存储仍有效。

管理 API 的 Kubernetes 客户端与指标客户端分别封装，错误转换为稳定业务错误码。Operator 的模板适配器接收已校验配置，输出确定性的资源描述和状态判断规则；业务状态不依赖 controller 进程内存。

## 3. 管理数据与实例归属

首期采用“用户 → 项目成员 → 项目 → 实例”的权限模型；实例不绑定永久个人所有权。`created_by` 只作审计。预留组织边界，但不实现 SaaS 计费或跨组织共享。

| 数据表 | 最小字段 / 约束 |
|---|---|
| users | id、登录标识、凭据校验信息或外部身份引用、状态 |
| projects | id、name、cluster_id、namespace、status；集群与 namespace 映射唯一 |
| project_members | project_id、user_id、role；组合唯一 |
| instance_bindings | id、project_id、cluster_id、namespace、resource_name、kubernetes_uid、created_by、lifecycle；资源定位唯一 |
| operations | id、project_id、instance_id、kind、idempotency_key、request_hash、target_generation、state、error、时间戳 |
| audit_events | actor、project_id、instance_id、operation_id、动作、脱敏变更摘要、结果、时间 |
| instance_credentials | id、instance_id、名称、Secret 引用、版本、生效/撤销状态；不保存可直接读取的明文凭据 |

实例 spec 不另存一份可独立修改的业务副本。操作请求可短期保存脱敏目标配置用于重试，但不是实例配置权威来源。高频运行状态缓存有更新时间，不能在 Kubernetes 不可达时显示为刚刚确认的状态。

`instance_bindings.id` 是平台生成的稳定随机 ID，Kubernetes 资源名采用该 ID；用户可修改的显示名称单独保存为实例展示信息。记录 CR UID 后，所有变更/删除都核对 UID，防止同名资源重建导致误操作。

权限角色：

| 角色 | 权限 |
|---|---|
| 平台管理员 | 平台配置、项目与模板管理、故障恢复 |
| 项目管理员 | 项目成员、实例创建/修改/删除、凭据、统计 |
| 项目维护者 | 实例创建、配置、暂停/恢复和统计；不管理成员、凭据或破坏性清空/删除 |
| 项目查看者 | 实例非敏感信息、统计和脱敏事件 |

首期提供本地账号、服务端会话和密码哈希；所有请求重新检查有效用户与项目权限，浏览器状态变更具有 CSRF 防护。OIDC 作为后续登录适配，不把它作为首期基础运行条件。

平台凭据管理与缓存数据访问分离：只把引擎已验证的凭据能力暴露给用户。生成秘密值只在创建时返回，常规 GET 不返回；引擎所需文件写入同实例 namespace 的 Secret。撤销/轮换作为异步操作，需确认引擎已应用后才报告完成，不把 Secret 更新视为即时撤销。

## 4. 项目与 Kubernetes 边界

平台管理员创建项目时，API 以专门的受限集群引导权限创建 namespace 和所需 RBAC/配额/基础网络策略，或绑定经核验的专用 namespace；只有初始化完成后允许创建实例。项目 namespace 不被普通成员任意指定。普通实例操作使用受限权限，不要求 cluster-admin。

管理 API 写 CacheInstance spec 及受控凭据；Operator 写 CacheInstance status、finalizer 和受管资源。两者使用不同 ServiceAccount。CRD 安装及集群权限引导由安装流程执行，日常调谐不创建任意集群级资源。

namespace 内实例之间默认不互访，按需要允许入口、监控和 DNS 等流量；能否执行该规则以 CNI 验收为准。镜像、StorageClass、入口配置和 Secret 引用均由平台白名单和实例归属校验约束。禁止将“可以改 CR”变成任意镜像/挂载/服务账号执行权限。

管理员绕过 API 修改 CR 时仍需通过 CRD 校验和 Operator 能力校验；操作将以外部变更记录展示。未绑定 CR 需要平台管理员显式导入，不能仅靠 label 自动授予所有权。首期不自动删除未绑定资源。

## 5. CacheInstance 与模板契约

资源 schema 以架构说明中的示例为基础，补充以下规则：

- metadata 中记录不可变平台 instance ID 和 project ID，spec 固定模板引用、资源、存储、访问与淘汰配置；工程实现时由校验约束不可变归属。
- `desiredState` 首期只有 Running、Suspended。模板跨引擎切换不允许原地执行。
- 容量扩展必须通过存储能力检查；禁止卷缩容。更换 StorageClass/迁移数据不属于普通 PATCH。
- 凭据引用必须是平台创建并绑定到该实例的 Secret，不能引用同 namespace 其他实例的秘密。
- 所有更新带版本前提。API 接受 If-Match 对应资源版本，不无条件覆盖并发配置。
- status 保存 `observedGeneration`、`appliedTemplateVersion`、`appliedConfigHash`、`credentialRevision`、`endpoints[]`、conditions。每个 condition 关联观测版本。
- endpoints 区分协议、URL 与就绪性；整体 Ready 必须对应当前配置和要求的端点。更新过程中可显示旧服务仍可用，但不能称新策略已生效。

模板的最小适配操作：

| 操作 | 输入与输出 |
|---|---|
| Validate | 配置 + 平台能力 → 接受或明确错误 |
| Render | 实例 + 锁定模板 → 工作负载、配置、服务和监控描述 |
| Observe | 当前资源与必要探测结果 → conditions 与实际版本 |
| PlanUpdate | 新旧配置 → 允许更新、需重启或拒绝及原因 |
| PlanMaintenance | 已支持操作 → 维护方案、互斥条件与完成判定 |
| ConnectionInfo | 端点 + 鉴权方式 → 无秘密值的客户端示例 |

schema、默认配置、能力表、镜像锁定和指标映射一起版本化。模板 API 显示是否支持 TTL、LRU、在线调整、清空、凭据轮换等；不支持的输入直接拒绝。管理员不能通过前端上传任意执行代码来扩展模板。

API 校验用于及时反馈，Operator 再次校验；两端针对同一模板版本的契约 fixtures 测试，避免 UI 接受而调谐器无法执行。

## 6. 异步操作、幂等与故障恢复

### 创建

1. 校验用户权限、模板和项目状态；数据库事务创建稳定实例 ID、pending binding、operation 和审计意图。
2. API 返回 202 和 operation ID。后台操作 worker 通过有过期时间的领取机制处理 pending 操作，崩溃后可接管；首期不依赖额外消息队列。
3. worker 幂等创建凭据、CR；固定资源名和请求指纹用于核验重试。已有对象不一致时标记冲突，不能覆盖。
4. 写回 CR UID 与目标 generation。Operator 负责调谐实际资源。
5. operation 跟踪目标版本状态。所需条件就绪后完成；超过操作截止时间报告超时，不自动删除已创建的存储。

幂等键按项目和动作作用域唯一；相同 key 与相同请求返回同一 operation，不同请求返回冲突。重试前核查权限和操作归属，不能借历史 operation 读取别人的信息。数据库提交后 Kubernetes 请求失败由 worker 重试；Kubernetes 成功而回写数据库失败时按资源 ID/指纹/UID 对账。

### 更新与操作排队

首期同一实例只允许一个活动变更操作；新变更返回冲突及当前操作 ID。数据库串行化平台请求，Kubernetes resourceVersion 同时防止外部修改。操作领取过期不代表允许第二个配置变更绕过尚未确认的第一项操作；接管的是同一个操作。

状态建议 `pending → applying → reconciling → succeeded/failed`，外部新版本覆盖目标时记录 `superseded`。超时可以终结用户可见等待，但后续调谐仍可能完成；页面分别展示操作结果与实例最新状态，不能把超时解释为资源已回滚。

### 暂停、删除和保留

暂停使工作负载停止服务并保留 PVC，恢复重新启动。删除使用 UID 前提，先撤销路由和访问，再等待工作负载停止，最后按 storage.deletionPolicy 处理存储。

Retain PVC 不随 CR 垃圾回收；数据库保留归属与 detached 状态，提供管理员查看、显式清理和受控领回操作。删除实例不等于删除项目；项目仍有实例或保留卷时，首期拒绝直接删除项目，要求先处理资源。

删除中的 finalizer 由 Operator 可重试推进。管理 API 超时不移除 finalizer；故障恢复记录每一步的实际资源，人工强制处理属于管理员审计动作。

### 控制面不可用

Kubernetes API 不可用时，查询返回最后观测时间与不可达状态，变更操作保持待重试或明确失败。数据库不可用时拒绝新的管理写操作。监控不可用只标记统计不可用。任何一种情况都不应伪造“实例不存在”“指标为零”或触发清空。

## 7. 独立域名与访问配置

管理员配置 baseDomain、共享入口适配和 TLS Secret，DNS 将通配子域名指向入口。首期不调用 DNS 厂商 API，不强制公网；内网域名同样支持。

默认 `cache-<instance-id>.<base-domain>`。如首个入口不能可靠地将同 hostname 的 gRPC 和 HTTP 分流，使用 `grpc-<id>` 与 `http-<id>` 两个域名，分别指向同一实例的对应 Service 端口。协议分流不能依靠“能打开网页”来判定成功。

TLS 在共享入口终止，首期验证客户端 → 入口 → 引擎完整认证链路。原生引擎鉴权信息必须正确转发。mTLS 如需在入口或引擎终止，必须由模板明确支持位置，不能把客户端证书穿透当作默认能力。

Operator 只维护当前实例的路由，不改共享 DNS/证书。EndpointReady 判断包括路由接纳、后端就绪和可执行的协议探测；DNS/TLS 的外部可达性作为单独诊断，不能因集群内请求成功就报告所有外部网络可达。

域名和 endpoint 展示绑定实例 ID，不因展示名变更而变化。实例删除撤销路由；ID 不复用，降低旧地址指向新实例的混淆。

## 8. 统计、淘汰与维护

Prometheus 存储时序；API 按项目权限构造有限查询。基础面板包含请求量、错误率、延迟、读写流量、资源与容量；REAPI AC/CAS、HTTP 和 WebDAV 分别定义业务统计，不强制统一命中率。

每个指标映射记录引擎名称、源指标、单位、计数/直方图类型、查询窗口和不可用条件。指标标签绑定 instance UID，历史实例删除后仍可按授权查询保留期内数据。GET 2xx 或 gRPC OK 不能自动代表缓存命中。

淘汰首先由引擎执行。bazel-remote 首期暴露容量预算与原生 LRU；WebDAV 必须验证容量/清理行为后再公布支持列表。在线配置更新没有证据时，明确按重启生效。PolicyApplied 需要目标配置已被运行进程应用的可验证条件。

维护 Job 仅用于模板明确支持的操作，具有操作 ID 与互斥机制。需离线的清理先停止引擎、确认无活动写入，维护完成后恢复；不能让通用清理器和引擎同时操作未知内部文件格式。失败时保留维护状态和原因，不默认返回运行状态。

## 9. 安装、升级与仓库迁移

主仓库目标目录：`apps/admin-web`、`apps/admin-api`、`operator`、`templates`、`images`、`deploy/charts/expbuild`、`tests/e2e`、`docs`；可选 `dev` 辅助开发。迁移管理端是实施任务，本方案编写不直接移动源码。

Helm 安装平台组件与权限；实例由 Operator 调谐。外部 PostgreSQL、指标服务、StorageClass 与入口是明确的部署配置；可提供演示依赖包，但不要求企业重复部署已有基础设施。

安装前校验 CRD、Kubernetes 版本、存储、入口与镜像可达性。CRD 升级采用显式、有版本的步骤，不假设普通 Helm upgrade 自动升级 crds 目录。数据库迁移由单一 migration job/部署步骤执行，多 API 副本不自行竞跑迁移。

升级先检查 API/Operator 对模板和 CR schema 的兼容范围；旧实例锁定镜像和模板，不随平台升级自动升级引擎。回滚需校验数据库 schema 与引擎数据格式兼容，不能只回滚镜像标签。

卸载 runbook 先处理缓存实例及保留卷，再卸载 Operator；管理员若仅暂停或移除控制面，必须明确缓存工作负载不会由 Helm 自动完整清理。禁止在仍有 CR 时盲删 CRD，避免丢失管理记录。

## 10. 实施里程碑与验收

| 阶段 | 主要交付 | 完成条件 |
|---|---|---|
| M0 契约与引擎验证 | bazel-remote 固定版本、WebDAV 候选结论、入口/存储基线、模板能力清单 | 真实客户端与清理/恢复验证记录；未支持能力明确禁用 |
| M1 平台骨架 | 单仓目录、API/前端骨架、PG migrations、CRD、Operator、CI | 合约可校验，镜像可构建，基础调谐测试通过 |
| M2 首个实例闭环 | bazel-remote 创建/访问/更新/暂停/恢复/删除 | 实际远程命中、身份拒绝、重启恢复、Retain 行为通过 |
| M3 管理与治理 | 项目角色、异步操作、凭据、域名、统计、策略 UI | 跨项目拒绝，重试幂等，并发冲突和操作状态正确 |
| M4 第二引擎 | WebDAV 模板、协议指标与已认证清理能力 | 不改权限/实例基础模型即可接入；真实客户端和清理并发通过 |
| M5 企业交付 | Helm、镜像映射、安装升级/恢复/卸载文档 | 目标集群组合安装及升级通过，无意外数据清理 |

阶段体现依赖和交付顺序，不作为日历工期承诺。M0 对每个决策设置短 PoC：未通过就更换候选或明确阻塞对应模板，不无限延长平台抽象设计。

建议实现任务：

| 编号 | 任务 | 依赖 |
|---|---|---|
| K01 | 迁移边界、目录与组件构建配置 | 本方案 |
| K02 | bazel-remote 版本/协议/指标/淘汰验证 | 无 |
| K03 | WebDAV 引擎、清理语义与许可验证 | 无 |
| K04 | CRD、模板 schema、共享契约 fixtures | K02，兼顾 K03 结论 |
| K05 | Operator 资源调谐、状态、finalizer | K04 |
| K06 | PG 模型、身份、项目与 RBAC | K01 |
| K07 | 操作 worker、Kubernetes client、实例 API | K04、K06 |
| K08 | 入口适配、域名、凭据与协议访问 | K02、K05、K07 |
| K09 | 控制台项目/实例/操作页面 | K06、K07 |
| K10 | 指标映射、查询 API、策略与统计页面 | K02、K05、K09 |
| K11 | WebDAV 适配与完整验收 | K03、K05、K08、K10 |
| K12 | Helm、镜像清单、升级卸载和全流程测试 | K08–K11 |

必需验收场景：

- 两个项目中的用户不能越权读取实例信息、指标、事件或凭据，也不能借 Secret 引用访问另一实例。
- 同幂等键重复创建、Kubernetes 成功后 API 崩溃、worker 领取过期、Operator 重启均能恢复，不重复创建实例或丢失存储归属。
- 同名资源被外部重建时 UID 校验拒绝误更新/删除；并发 PATCH 明确冲突。
- 真实客户端 REAPI/Bazel HTTP/WebDAV 读写，独立客户端证明远程命中，不能用本地缓存掩盖服务端问题。
- 容量逼近、淘汰和并发上传/下载；错误配置不报告 PolicyApplied；凭据轮换只有确认生效才完成。
- 暂停恢复、Pod 重建、删除中断、Retain 卷领回与清理、平台组件故障和集群 API 断连。
- gRPC、WebDAV 方法、大文件、域名路由、TLS、生产存储与网络策略均在认证组合验证。

性能按真实客户端负载测量：实例创建阶段耗时、空闲资源开销、协议延迟/吞吐、重启扫描时间、实例数量增长时的调谐与指标开销。具体 SLO 由基线测试确定，未测量前不声称秒级启动或某个集群规模。

## 11. 尚待验证的有限决策

| 项目 | 决策责任与截止点 | 默认处理 |
|---|---|---|
| bazel-remote 镜像版本/digest、客户端版本 | 引擎适配负责人，K02 完成时锁定 | 不使用浮动 latest |
| WebDAV 引擎与可安全清理能力 | 引擎适配负责人，K03 完成时锁定 | 不把通用文件服务器直接标成完整缓存引擎 |
| 入口实现及多协议路由 | 平台负责人，K08 前完成 PoC | 一个认证适配器，必要时协议独立子域名 |
| Kubernetes/存储/CNI 版本组合 | 平台负责人，M0 起建立兼容矩阵 | 至少一个完整认证组合，其他标未验证 |
| 资源默认值与性能 SLO | 协议端到端验证后，M5 前 | 模板示例值不当成容量承诺 |

这些是实现前置验证任务，不要求用户回答无关的技术选型问题，也不把先前的学习性询问转化为限制。
