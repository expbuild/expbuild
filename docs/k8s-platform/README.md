# expbuild：Kubernetes 缓存服务管理平台

更新日期：2026-09-29。状态：收敛后的实现方案；已开始首批基础代码，未在集群验证。

实施契约与任务拆分见 [implementation-plan.md](implementation-plan.md)。本文定义产品与架构，实现契约定义模块、数据、状态机和交付门槛；两者共同构成当前实现基线。

本文独立于此前 `docs/design`、`docs/strategy` 中的统一缓存引擎方案。旧方案保留为历史研究，不作为本方案的实现前提。

## 方案摘要

expbuild 定位为基于 Kubernetes 的缓存服务管理平台。用户选择服务模板、配置资源与存储，即可创建独立缓存实例；平台统一提供访问配置、生命周期管理、实例统计与淘汰策略管理。

已确定的方向：

- 企业自托管优先，以 Kubernetes 作为实例运行底座。
- 复用开源缓存引擎，首个 REAPI 模板采用 bazel-remote，具体版本待 PoC 锁定。
- 实例使用独立工作负载、存储和凭据；原生协议请求直接进入缓存服务。
- 平台统一管理能力和界面，不要求各引擎实现相同的协议语义或淘汰算法。
- 以小型独立服务为起点，不引入统一 CacheCatalog 或跨引擎内容索引。

首期实现基线：单集群、单副本持久实例、Go Operator、CacheInstance CRD、React/TypeScript 管理界面、TypeScript 管理 API、PostgreSQL 管理数据、共享 Prometheus 兼容指标基础设施。管理端纳入主仓库，选择性迁移现有代码。HTTP/WebDAV 引擎、外部入口实现、集群兼容版本及资源规格通过限时 PoC 锁定，再进入对应模板开发。

约束来源：用户明确要求 Kubernetes、多种缓存服务、小型独立实例、独立统计、可配置淘汰与扩展能力，企业自托管优先。语言、目录、单集群起步等属于本方案的工程选择。Mac、K3s/k3d、kind、具体云厂商和学习性技术问答不构成产品或架构约束；不要求用户使用某一种开发设备或购买某种云服务。

本文涵盖产品边界、架构、资源模型、模板契约、运行管理、引擎选型、镜像交付、开发环境与验收路径。配置与目录均为设计示例，不是已经存在的可执行实现。

## 1. 产品与首期边界

目标：用户按用途创建小型、独立的缓存服务，获得连接配置、实例统计、存储与淘汰策略管理。企业自托管优先。

平台负责实例生命周期和治理；缓存引擎负责协议与数据语义。首期不要求所有引擎共享索引、物理存储、去重或缓存条目模型。

首期建议：单集群、管理员提供模板、每实例单副本、持久卷、独立凭据、集群内访问与一个经过验证的外部入口、实例指标、原生淘汰策略。支持手动暂停与恢复，不提供透明缩容到零及请求唤醒。

“快速创建”分别测量 API 受理、资源创建、Pod 启动、应用就绪与首次协议请求成功时间。镜像拉取、卷供应和历史数据扫描分别记录；先实测再定 SLO。

## 2. 先区分协议与服务用途

HTTP 是传输方式，不能单独定义一种缓存语义。模板必须说明服务用途：

| 服务 profile | 主要行为 | 待验证内容 |
|---|---|---|
| REAPI cache | ActionCache + CAS，无远程执行 | 客户端兼容、鉴权、原生 GC、指标 |
| HTTP artifact cache | 通过约定的 key/path PUT、GET 构建产物 | Bazel HTTP、Gradle 等分别认证，不能假定通用互通 |
| HTTP proxy cache | 配置上游并缓存响应 | cache-control、认证响应隔离、重验证、上游限制 |
| WebDAV cache | 客户端写入/读取文件与目录 | 客户端所需方法、锁、并发写、可安全清理方式 |

首期目标覆盖 REAPI cache、HTTP artifact cache、WebDAV cache 三类能力。第一条可交付链路采用 bazel-remote，同时提供 REAPI 与 Bazel HTTP 接口；二者可以是同一实例的两个访问方式，不必重复部署两份引擎。WebDAV 为第二个独立引擎适配，Gradle HTTP 等按客户端需求后续认证。HTTP proxy cache 为下一批独立模板，不混用表单和命中率定义。版本和实际能力需做 PoC 后锁定，不因协议名称就宣称兼容。

## 3. 控制面和运行面

```text
Web / CLI → Management API → Kubernetes CacheInstance CR
                                  ↓
                              Operator
                                  ↓
                     StatefulSet / Service / PVC
                     ConfigMap / Secret refs / NetworkPolicy

构建客户端 → TLS 入口或集群 Service → 缓存引擎
监控系统   ← 引擎指标 / 可选 exporter / 集群资源指标
控制台     → 按实例授权的指标查询
```

Operator 使用调谐循环将声明转换为实际资源，符合 Kubernetes 的 Operator 模式 [S1]。管理 API 不直接修改 Operator 管理的 StatefulSet 等子资源。

使用 Go + controller-runtime 实现 Operator；控制台与管理 API 迁入主仓库，按新的项目权限和实例模型重构，现有 expbuild-admin 的原有授权实现不因复用而被认定合格。缓存实例运行各自引擎镜像，不要求统一语言。

首期不强制 sidecar。引擎原生鉴权、指标优先；只有能力缺失且有可靠实现时才增加代理或 exporter，避免小实例的辅助组件成本超过引擎本身。

## 4. 核心对象与权威来源

| 对象 | 职责与来源 |
|---|---|
| EngineTemplate | 管理员维护的版本化模板包；首期随平台发布，不要求动态模板 CRD |
| CacheInstance | namespaced CRD；实例期望配置的唯一权威来源 |
| CacheInstance.status | Operator 写入的观测状态、实际版本、条件、访问地址 |
| Kubernetes Secret | 实例凭据；CR 只放同 namespace 引用 |
| 平台数据库 | 用户、团队、项目授权、审计、异步操作记录；不另存一份可独立修改的实例 spec |
| 指标系统 | 时序统计；不向 CR status 写每个请求或高频指标 |

数据库与 Kubernetes 之间不假设跨系统事务。管理 API 先持久记录操作意图与幂等键，再写 CR，重试时按固定资源名和请求指纹核对，最后记录结果。失败或响应丢失可重试和对账。实例是否存在及期望配置最终以 CR 为准。

同名实例重建使用不同 CR UID；审计、指标与存储归属都关联 UID，避免历史数据混淆。API 服务账号校验项目映射，不能直接信任客户端提交的 Kubernetes namespace。

首期由 UI/API 管理。管理员直接创建的 CR 不会自动获得业务归属或向用户展示，需要显式导入和验证。GitOps 管理模式留到后续：届时 UI 修改入口禁用，仍以 CR 为权威，避免多个写入者互相覆盖。

## 5. CacheInstance 草案

以下为设计示例，尚无对应 CRD 或可安装模板。容量、资源仅说明字段，不代表引擎最低规格或性能承诺。

```yaml
apiVersion: cache.expbuild.io/v1alpha1
kind: CacheInstance
metadata:
  name: bazel-ci
  namespace: expbuild-team-a
spec:
  templateRef:
    name: reapi-cache
    version: "0.1.0"
  desiredState: Running
  resources:
    requests:
      cpu: "250m"
      memory: "256Mi"
    limits:
      cpu: "2"
      memory: "1Gi"
  storage:
    className: standard
    capacity: 100Gi
    deletionPolicy: Retain
  access:
    exposure: ClusterInternal
    credentialsSecretRef: bazel-ci-auth
  eviction:
    capacity:
      maxBytes: 85899345920
    enginePolicy: lru
  engineConfig: {}
```

资源 requests/limits 按模板校验。模板版本绑定固定镜像 digest、配置 schema 和指标映射；实例显式升级，不随模板最新版本自动漂移。`engineConfig` 是模板白名单配置，不允许用户注入任意 Pod spec、容器命令或宿主机挂载。

`eviction` 仅为跨引擎表单意图，不承诺所有引擎实现示例策略。不支持的字段应拒绝，不能静默忽略。

status 包含 `observedGeneration`、`appliedTemplateVersion`、`appliedConfigHash`、`credentialRevision`、`endpoints[]`、`conditions`、`lastOperationRef`。条件至少包括 `Accepted`、`StorageReady`、`WorkloadReady`、`EndpointReady`、`PolicyApplied`，以及失败 reason/message。Ready 需要对应当前 generation；Pod Running 不等于实例可用。

## 6. 模板的适配契约

一个模板包描述：

- 服务 profile、支持的客户端版本及能力矩阵。
- 固定镜像、配置 schema、默认资源和最小资源约束。
- 渲染工作负载、配置、端口、启动/就绪/存活探针。
- 支持的存储类型、副本数、更新与暂停策略。
- 原生鉴权方式、凭据轮换方式、只读/读写权限能力。
- 指标名称与语义映射；缺失能力明确标记 unavailable。
- 淘汰策略到原生配置/API 的映射及生效确认。
- 必要时的维护操作实现与并发保护，客户端连接示例。

首期采用编译进 Operator 的适配器和静态 schema，先验证不同服务 profile 的共性。后续确有独立发布需求再引入签名模板包与扩展 SDK。

## 7. Kubernetes 编排与生命周期

项目映射到一个平台管理的 Kubernetes namespace，实例使用独立工作负载、Service、PVC 和凭据。实例之间的网络访问通过标签选择器和 NetworkPolicy 控制。namespace 本身不等于网络隔离，NetworkPolicy 依赖 CNI 实际支持 [S3]。

首期持久实例默认单副本 StatefulSet；声明单副本不等于跨节点强制单写隔离。优先验证 CSI 的 ReadWriteOncePod 支持；ReadWriteOnce 表示单节点读写，不能当作单 Pod 锁。节点失联接管依赖存储 fencing，不能靠强删旧 Pod 就认定安全 [S2]。

调谐步骤：校验模板和输入 → 创建/核对存储 → 渲染配置及凭据引用 → 创建工作负载与 Service → 配置访问入口和监控发现 → 汇总就绪条件。每步幂等且支持重入；出错记录具体依赖，不要求删除重建整个实例。

生命周期：

- 创建：API 返回异步操作；显示等待卷、拉镜像、初始化、协议就绪等阶段。
- 更新：使用 resourceVersion 防止覆盖并发修改；声明与实际生效版本分开显示。
- 暂停：实例离线，保留 PVC；恢复会经历启动和可能的索引扫描。
- 升级：单副本允许维护中断，先验证引擎格式兼容；不承诺升级后都能直接回滚镜像。
- 扩容：仅在 StorageClass/CSI 支持且模板验证后开放；首期不提供卷缩容 [S2]。
- 删除：先撤销访问并停止工作负载，再依明确策略保留或清理存储。

默认 `Retain`。需要保留的 PVC 不设置会随 CR 删除而触发垃圾回收的 ownerReference，记录实例 UID 和归属；清理策略显式为 Delete 时才执行删除。PVC 删除与 PV 的 reclaimPolicy 是不同层，不能仅凭 PVC 消失宣称后端数据已擦除 [S2]。保留卷的领回、过期清理与占用统计需要管理入口。

finalizer 只保护必要且可重试的清理流程；删除失败展示阻塞资源与人工恢复步骤。模板卸载或升级后仍须能够处理旧实例的删除。

外部访问首期选择一个经过认证的入口实现：验证 gRPC/HTTP2、流式上传、超时、大请求以及 WebDAV 方法，不能只验证网页 GET。端点使用实例稳定身份，所有运行配置禁止把凭据写入 URL 示例或日志。

每实例支持独立子域名，默认 `cache-<instance-id>.<base-domain>`，必要时不同协议使用独立子域名；实例显示名变化不改变域名。共享入口按 hostname 路由，无需每实例独立公网 IP。首期由管理员准备基础域名、通配 DNS 和证书，Operator 创建路由并报告就绪状态。支持内网部署；用户自定义域名及 DNS 厂商自动化留到后续。详细契约见实现计划。

## 8. 淘汰策略

三种数量分别展示：卷容量、引擎缓存预算、当前实际占用。PVC 容量不会自动实现应用级 LRU 或 TTL。示例 100 GiB 卷、80 GiB 缓存预算只是预留索引、临时文件等空间的起点，需要引擎测试校准。

策略优先级：

1. 引擎原生配置/API：平台校验、应用并确认生效。
2. 经过引擎适配的维护任务：显式维护锁、进度、失败重试和状态展示。
3. 引擎无可靠支持：显示不支持，必要时仅提供维护窗口中的整体清空。

不提供跨引擎通用的“find 文件后删除”任务。REAPI 引用、WebDAV 锁与未完成上传都需要由各自适配器理解。Kubernetes CronJob 的并发策略不能替代引擎内部并发保护。

TTL 必须注明从创建时间、最后写入还是最后访问计算；不能统一称作保留时间却改变语义。LRU 是否近似、淘汰是否异步、容量是否短时超出也作为模板能力公开。配置成功与策略已生效分别显示。

WebDAV 实例创建时明确数据可被回收，并只提供模板已验证的清理方式。把普通文件服务标为缓存并不能自动使它具备可靠的淘汰策略。

## 9. 统计

统一展示资源使用、请求量、错误率、延迟、流量、容量与服务状态；请求级统计来源可以是引擎或经验证的入口，必须标明统计边界。资源指标不等于业务指标。

命中率按操作展示：REAPI ActionCache 命中、CAS 可用性检查、CAS 下载结果互相独立；HTTP proxy 命中由引擎报告；WebDAV GET 2xx 不自动称作缓存命中。缺失值显示未知，不能补成 0。

指标标签建议 `cluster_id / namespace / instance_uid / engine / operation / outcome`。禁止把 digest、完整路径、用户名或 token 作为常规时序标签。命中率采用同窗口计数增量的比值，分母为零显示无请求；明确包含与排除的错误类型。

平台提供按实例授权的查询 API，不开放任意 PromQL 给普通用户。指标采集异常不应被显示为缓存服务宕机。首期复用共享 Prometheus 类监控基础设施；ServiceMonitor 仅在已安装对应 CRD 时使用，否则提供标准 scrape 配置。

## 10. 接口与首期页面

建议管理接口（路径为草案）：

| 接口 | 用途 |
|---|---|
| GET /v1/templates | 模板及能力、版本、配置 schema |
| POST /v1/projects/{project}/instances | 幂等创建，202 + 操作 ID |
| GET /v1/projects/{project}/instances/{id} | 期望配置、观测状态与故障原因 |
| PATCH /v1/projects/{project}/instances/{id} | 带版本条件的更新，异步生效 |
| POST /v1/projects/{project}/instances/{id}/operations | 暂停、恢复及模板支持的维护操作 |
| GET /v1/projects/{project}/operations/{id} | 操作进度与结果 |
| GET /v1/projects/{project}/instances/{id}/metrics | 受限时间范围与指标集的查询 |
| DELETE /v1/projects/{project}/instances/{id} | 按明确存储策略删除，202 |

所有操作绑定项目权限，区分查看、维护、凭据管理、策略修改与删除。凭据值不出现在常规详情 API。清空与删除审计记录发起者、实例 UID、配置版本和最终结果。

页面：模板选择、实例创建、实例列表、详情概览、连接配置、统计、策略、事件与操作历史。模板不支持的能力明确说明，不提供无效按钮。

## 11. REAPI 引擎选型与首个实例模板

### 11.1 采用 bazel-remote

首个 REAPI 模板采用开源项目 [bazel-remote](https://github.com/buchgr/bazel-remote)，不继续扩展旧 expbuild 原型作为首期协议引擎。该项目采用 Apache-2.0 许可证，提供独立程序和容器部署方式 [S4、S5]。

官方文档已说明的能力与平台映射：

| 引擎能力 | expbuild 接入方式 |
|---|---|
| REAPI ActionCache、CAS、Capabilities 及相应 ByteStream 接口 | REAPI profile，无 Execute/worker 要求 |
| Bazel HTTP `/ac`、`/cas` 读写 | 同一实例可暴露 Bazel HTTP 端点 |
| 本地磁盘缓存和容量上限、最近最少使用文件淘汰 | 独立 PVC，模板映射缓存预算 |
| Prometheus 指标、状态接口 | 实例指标采集和概览 |
| htpasswd、mTLS 等鉴权方式 | Secret 注入，经验证的凭据配置流程 |
| 对象存储等代理后端 | 后续模板能力，首期先验证本地 PVC |

REAPI 的 FindMissingBlobs 属于缓存上传的存在性查询路径，不要求启用远程执行。平台复用引擎实现；PoC 包含上传批量查询与真实客户端验证，不开发另一个全局存在性服务。

首期资源映射：

```text
CacheInstance: bazel-ci
  ├── StatefulSet: 单副本 bazel-remote，固定镜像 digest
  ├── PVC: 引擎缓存目录
  ├── ConfigMap: 容量、监听地址、指标及认证文件路径
  ├── Secret: 凭据或证书
  ├── Service: REAPI gRPC 与可选 Bazel HTTP
  └── 监控发现: 关联 instance_uid
```

Bazel HTTP 不是通用 Gradle HTTP 或 WebDAV。不得把 `instance_name` 或 AC key 的命名处理当作租户隔离：平台隔离单位仍是独立实例、凭据、存储与网络访问边界。

### 11.2 模板公开能力的限制

首期公开容量控制与引擎原生淘汰。以下能力在 PoC 前标记待验证，不对用户承诺：任意 TTL、按凭据区分只读/读写、精确条目删除、无重启配置修改、凭据即时热更新、多个进程安全共享同一缓存目录。

默认要求鉴权；如果只验证了实例级鉴权，则只暴露实例级能力。匿名读取配置不等于“已认证只读用户”权限。需要更细权限时，先验证引擎或协议感知代理，不能仅按 HTTP 方法推断所有 gRPC 操作的权限。

配置变更首期按可能重启处理，展示维护影响。对 StatefulSet 写入新配置不代表引擎已应用策略；运行配置确认方式和探针在模板 PoC 中锁定。

### 11.3 后续候选

[Buildbarn bb-storage](https://github.com/buildbarn/bb-storage) 可独立提供远程缓存，支持可组合存储后端并提供容器镜像，采用 Apache-2.0 许可证 [S6]。在需要不同存储拓扑时评估为第二种 REAPI 引擎，不与首个模板同时扩大首期范围。

## 12. 镜像、模板与企业交付

### 12.1 三类内容分别存放

| 内容 | 存放位置 | 生命周期 |
|---|---|---|
| 容器镜像 | OCI 镜像仓库 | 构建、发布、同步、版本保留 |
| 模板、Dockerfile、配置 schema | Git 仓库 | 代码审查与版本发布 |
| 缓存内容和运行期索引 | 实例 PVC | 随实例存储策略管理 |

不把运行数据写入镜像；不把容器可写层作为持久缓存；不将大体积镜像压缩包提交 Git。

建议目录，尚未创建相应实现：

```text
expbuild/
├── apps/
│   ├── admin-web/                 # 管理界面，从现有仓库选择性迁移
│   └── admin-api/                 # 管理 API、项目权限、审计和操作队列
├── operator/                       # CRD、调谐与模板适配器
├── templates/
│   ├── bazel-remote/               # 模板描述、schema、默认配置、指标映射
│   └── webdav/
├── images/                         # 仅放确需自定义的 Dockerfile 与脚本
├── deploy/charts/expbuild/          # 平台安装包；实例由 Operator 管理
├── dev/                            # 可选开发环境配置与辅助脚本
└── tests/e2e/                      # 实例生命周期与真实协议测试
```

以上是目标目录；本次只更新设计，不执行仓库迁移。迁移时保留旧仓库与历史引用，先审核依赖和许可，再迁入有用模块；旧 Rust 协议原型不进入新平台默认构建与交付链路。三个平台组件独立构建镜像，统一仓库并不要求合并部署进程。

优先使用通过验证的上游镜像；需要启动脚本或模块才维护封装镜像；必须修改引擎行为时才维护源码分支。模板锁定镜像 digest，并记录上游版本、架构与来源。项目许可证和镜像所含依赖的分发信息随交付清单保留。

### 12.2 企业私有仓库和离线安装

平台安装配置允许管理员覆盖镜像仓库及拉取凭据引用：

```yaml
global:
  imageRegistry: registry.company.internal
  imagePullSecrets:
    - company-registry
```

这是安装包设计示例，尚未实现。仓库覆盖需要明确原始镜像到目标 repository 的映射，不能假设仅替换 hostname 即可。同步后校验目标 digest；如同步工具改变 manifest，则生成经过校验的新镜像锁定清单。

imagePullSecrets 必须存在于使用镜像的工作负载 namespace。平台不会因为某个 Secret 存在于控制面 namespace，就默认所有实例都能引用它；安装流程负责在受管 namespace 配置获准的凭据引用或受控复制。

每次发布提供：平台安装包、CRD、模板版本、完整镜像清单、支持架构、配置与数据格式升级说明。离线交付包含对应镜像归档或镜像同步包；安装时不能再隐式从公网下载插件或引擎。

发布链路：Git 变更 → 配置/适配器测试 → 镜像构建或上游镜像验证 → 协议端到端测试 → 发布模板与镜像清单。实例固定模板版本，由用户显式升级，不跟随 latest 漂移。

## 13. 验证分层与可选开发环境

日常开发不要求始终运行完整 Kubernetes。测试分层如下：

| 层次 | 环境 | 验证内容 |
|---|---|---|
| 控制台 | API fixtures | 表单、状态、权限展示与交互 |
| 配置及模板 | 普通单元测试 | 校验、配置映射、资源渲染 |
| Operator | controller-runtime envtest | CRD、API 行为、调谐、状态及重试 |
| 引擎 | 独立 Docker 容器 | 协议、认证、指标、容量淘汰 |
| 完整联调 | kind；k3d 可选 | 真实 Pod、PVC、服务、客户端和生命周期 |
| 生产适配 | 接近部署目标的测试集群 | CSI、CNI、入口、节点故障及恢复 |

envtest 启动 API Server 和 etcd，但没有 kubelet 或内置工作负载控制器，因此不能验证真实 Pod 运行或 ownerReference 自动垃圾回收 [S7]。测试中手动设置就绪状态仅代表模拟，不算实际运行成功。

kind 在容器节点中运行 Kubernetes；k3d 在 Docker 中运行 K3s [S8、S9]。两者均是可选联调环境，也可以使用远程或托管集群。验收依据是协议、资源和生命周期行为，不是某个本地工具。具体 CI 环境在实现时选择并锁定版本；本地集群不自动证明生产 CSI 和网络隔离行为正确。

本机资源不足时，在独立开发服务器运行 kind 或专用开发集群，本机使用 kubeconfig 运行 Operator 和管理 API，便于断点调试。每个开发环境只运行一个负责该资源范围的调谐版本；避免本机和集群中的不同 Operator 同时改写实例。

本地镜像可以导入 kind；远程集群通过开发镜像仓库获取。应用访问使用端口转发或开发入口。开发凭据只授权开发资源，不复用生产集群管理员凭据。

计划提供以下命令，目前尚未实现：

```text
make dev          # 控制台与 API 本地开发；fixture/真实后端模式明确区分
make test         # 普通测试和 envtest
make cluster-up   # 使用所选开发环境适配器准备集群
make test-e2e     # 部署实例，运行生命周期与协议测试
```

## 14. 开发顺序与验收

1. **引擎 PoC**：先验证 bazel-remote，锁定版本、客户端、运行资源、鉴权、指标、淘汰与恢复行为；完成 REAPI 和 Bazel HTTP 两条访问路径。随后选择 WebDAV 引擎，清理能力不合格时明确阻塞，不能用部署成功替代验证。
2. **Operator 最小闭环**：CRD、模板校验、单实例持久卷、Service、探针、状态、重启恢复、Retain 删除；先通过 kubectl 验证。
3. **控制台闭环**：项目映射、权限、异步 API、创建与连接指引、凭据配置和事件。
4. **统计和策略**：接入各模板指标，展示生效版本，验证容量逼近和清理并发。
5. **交付与运维**：平台安装包、升级兼容、安装前依赖检查、故障定位、保留卷管理。

必须验证：真实客户端读写；未授权和跨实例访问被拒绝；Pod 重启/节点故障下数据行为符合承诺；写入与清理并发；入口大文件与 gRPC；配置失败保留原因；Operator 重启后继续调谐；API 重试不重复创建；删除不会误删 Retain 卷。

规模验证逐步增加实例数，测量每实例闲置开销、启动耗时分布、API server 压力、监控时序量和 PVC 附着限制。第一版不预设“数千实例”或“秒级启动”已被满足。

下一阶段再评估多集群、上游代理模板、对象存储、引擎原生 HA、GitOps 完整体验和第三方模板发布。缓存服务的横向扩容必须逐引擎认证，不能统一把 replicas 调大。

首个可演示里程碑：用户创建 bazel-remote 实例 → 获得连接配置 → Bazel 上传构建结果 → 另一个干净工作目录命中缓存 → 控制台显示实例指标 → 调整容量并验证策略 → 重启验证恢复 → 删除实例并核对 Retain 卷。需要清除客户端本地缓存或使用独立客户端证明远程命中，不能把本地命中误记为服务端成功。

待 PoC 决定的项目包括：bazel-remote 固定版本与镜像 digest、WebDAV 引擎、兼容的 Kubernetes/CSI/CNI/入口组合、默认资源规格、启动时间目标、指标定义和凭据轮换机制。此前均不宣称已认证或满足性能目标。

## 15. 官方参考

- [S1：Kubernetes Operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [S2：Persistent Volumes，访问模式、扩容及回收策略](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [S3：Network Policies 与网络插件要求](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [S4：bazel-remote 功能、配置和部署](https://github.com/buchgr/bazel-remote)
- [S5：bazel-remote Apache-2.0 许可证](https://github.com/buchgr/bazel-remote/blob/master/LICENSE)
- [S6：Buildbarn bb-storage](https://github.com/buildbarn/bb-storage)
- [S7：Kubebuilder envtest](https://book.kubebuilder.io/reference/envtest)
- [S8：kind Quick Start](https://kind.sigs.k8s.io/docs/user/quick-start/)
- [S9：k3d](https://k3d.io/stable/)

当前实施进度见 [实现计划](implementation-plan.md) 和 [Go 模块说明](../../operator/README.md)。未验证的镜像、引擎能力与集群组合在实现计划中设为明确门槛，不代表已经完成认证。
