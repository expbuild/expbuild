# expbuild 竞品与平台能力研究

研究日期：2026-09-28。优先场景：企业自托管，架构预留 SaaS。本报告区分官方已证实能力与面向 expbuild 的推论；不比较未经统一测试的性能，不给市场价格排名。许可内容仅用于产品选型尽调，集成时仍应锁定版本、逐文件核对。

## 1. 建议定位

**expbuild 应成为企业自托管优先的、多构建生态共享的可信缓存与加速控制平台。** 核心不是“支持最多协议”，而是让同一企业中的 Java、JS/TS、C/C++、Rust、Go、Bazel 与容器构建团队，使用一致的项目权限、信任策略、配额、数据生命周期和缓存诊断；后续把远程执行作为可接入能力。

“多协议统一缓存”已经有直接竞品。Depot 官方已列出 GitHub Actions、Bazel、Go、Gradle、Pants、sccache、Nx、Turborepo、Maven、moonrepo 等集成，并提供缓存浏览、使用统计、保留时间和容量配置。因此不得把多协议描述为独创；可竞争的是**企业可自主部署 + 协议中立的治理 + 可以解释的收益 + 可扩展数据面**。[Depot Cache 概览](https://depot.dev/docs/cache/overview)、[产品页](https://depot.dev/products/cache)

推荐产品承诺：保留现有构建工具和 CI；对于已有原生远端缓存的工具，主要通过配置端点、凭证与缓存开关接入，Maven 等扩展路线另给安装步骤。平台管理员统一分配、治理和审计缓存资源；开发者根据已采集证据排查未命中、延迟与策略拒绝。

## 2. 竞品地图：哪些做“引擎”，哪些做“平台”

| 项目/产品 | 官方可证实定位 | 适合 expbuild 借鉴 | 不宜直接复制或假设 |
|---|---|---|---|
| BuildBuddy | Bazel 构建事件、结果、远程缓存、RBE；企业版提供云托管与本地部署、OIDC、HA 等 | 将 invocation、缓存请求、构建趋势与治理连起来；区分 CAS 写与 AC 写权限 | 不把它的 Bazel 语义当成所有协议的唯一领域模型；不能因仓库公开就复制 enterprise 代码 |
| Buildbarn | REAPI 存储与可组合远程执行组件 | 独立存储数据面、存储后端组合、AC 完整性检查、按实例路由执行 | 它是构建基础设施组件族，不等于现成多协议企业门户；要评估运维和配置成本 |
| Buildfarm | REAPI 缓存与远程执行；实例代表资源池；调度器、worker、Redis 组成集群 | 实例/资源池映射、队列与 worker 管理、执行后端候选 | 初期为缓存平台自建完整调度器会显著扩大范围；不能把 instance name 当作自动授权 |
| NativeLink | Rust 单二进制按配置承担 CAS、AC、调度器、worker；可组合 store | 将单机与分布式保留同一模块边界；能力声明和存储装饰器设计 | 当前许可为 FSL，商业集成不能按历史 Apache 印象判断；默认配置的正确性/鉴权要逐项核验 |
| bazel-remote | HTTP/gRPC REAPI 缓存，磁盘 LRU、对象存储代理、压缩和指标 | 小型部署/边缘缓存、快速对照实现与协议兼容测试目标 | 不是完整企业平台；Go library 不承诺 API 稳定，优先进程级集成；CAS 实例路径默认不隔离 |
| Gradle Develocity | 构建分析、缓存、测试加速与企业控制，Edge 把服务移近构建端 | Build Scan 诊断、项目级访问控制、短期凭证、Edge 管理、跨节点清理 | 开放的 Gradle HTTP cache 协议不意味着可仿冒或复用 Develocity 私有能力；第一期不复制完整分析栈 |
| Nx / Nx Cloud | Nx 任务缓存；Nx Cloud 增加分布式执行、任务拆分等，企业方案可自托管 | 安全域分层、可信写入、immutable entry、令牌追踪；依据现行 OpenAPI 接入 | 不采用已弃用的自托管 bucket 包；Nx Cloud 的商业功能不能归为 Nx 开源能力 |
| Turborepo / Vercel Remote Cache | 任务级 HTTP 远程缓存，公开自托管 API，支持 artifact signature | 标准适配、原始客户端兼容、签名透明保留、简单 onboarding | HMAC 验证不替代租户隔离和可信 writer；缓存 hash 不等于可验证的产物内容 digest |
| sccache | 编译器 wrapper，本地/远程缓存及独立分布式编译 | 利用已有 compiler 语义与 WebDAV backend，避免重写编译器集成 | 它是客户端与编译生态组件，不是企业门户；sccache-dist 不等于 REAPI worker |
| Depot | 跨工具托管缓存、构建器及 runners | 多协议统一接入、自动配置、缓存浏览、retention/usage 体验 | 不声称“多协议无人做”；可根据公开边界进一步做项目粒度与信任策略 |

矩阵中的“不是完整平台”是产品范围判断，不表示项目绝对没有任何鉴权或 UI；本研究没有对每个仓库进行全量功能审计。

依据：[BuildBuddy 企业版](https://www.buildbuddy.io/docs/enterprise/)、[Buildbarn 存储](https://github.com/buildbarn/bb-storage)、[Buildfarm 架构](https://buildfarm.github.io/buildfarm/docs/architecture/architecture/)、[NativeLink 架构](https://docs.nativelink.com/explanations/architecture)、[bazel-remote](https://github.com/buchgr/bazel-remote)、[Develocity Edge](https://docs.gradle.com/develocity/edge/2.1/)、[Nx 自托管接口](https://nx.dev/docs/kb/self-hosted-caching)、[Turborepo 远程缓存](https://turborepo.dev/docs/core-concepts/remote-caching)、[sccache](https://github.com/mozilla/sccache)。

## 3. 关键机制：值得借鉴的细节

### 3.1 BuildBuddy：缓存数据需要连接构建上下文

BuildBuddy 的认证模型区分 Admin、Writer、Developer、Reader；Developer 可以写 CAS，却只能读 AC。这个区别非常有价值：开发者可能需要上传内容用于执行和诊断，但并不应自动有权发布可被其他构建直接信任的计算结果。其个人 key 权限随组织角色收缩，移出组织会删除对应 key。[认证与角色](https://www.buildbuddy.io/docs/guide-auth/)

BuildBuddy 的 cache requests 页面按构建分析对象大小、请求与目标；实现说明展示了请求记录异步缓冲再归档的设计，避免每个高速缓存请求同步写业务数据库。其企业 API 还提供独立 Audit log reader key 的审计导出接口。[缓存调试](https://www.buildbuddy.io/blog/bazel-remote-cache-debugging/)、[审计 API](https://www.buildbuddy.io/docs/enterprise-api/)

expbuild 建议：统一 permission action 而非只有 read/write：admin、policy.edit、cache.read、blob.write、result.publish、cache.invalidate、audit.read、usage.read。对于不区分 CAS/AC 的 opaque 协议，把写入结果视为 result.publish；按协议能力裁剪。管理审计采用可靠追加日志；高频访问与诊断事件可异步聚合，二者不应混为一条日志链。

### 3.2 Buildbarn / Buildfarm：标准接口让执行成为可替换后端

Buildbarn 的 bb-storage 可以单独作为缓存，也可以将执行请求转交 scheduler；存储后端可用 gRPC、磁盘结构等组合，示例给出不同 instance 的 AC 与执行路由。Buildfarm 则以 instance 表达资源池，多个 instance 可以在同一端点存在。[Buildbarn README](https://github.com/buildbarn/bb-storage)、[Buildfarm 架构](https://buildfarm.github.io/buildfarm/docs/architecture/architecture/)

expbuild 建议：第一期完整做好缓存、治理和观测；后续由 ExecutionProvider 接入现有 REAPI 引擎，统一 worker pool、租户配额和使用量。不要在同一阶段重写调度、隔离执行、工具链分发、多平台 worker 与缓存存储。该接口只是集成边界，不保证不同引擎可以无状态互换；取消、重试、platform properties、队列与执行结果权限需要专门验收。

### 3.3 NativeLink：小接口可组合，但正确性不能留给“默认配置”

NativeLink 以统一 StoreDriver 接口组成 store graph；文档明确区分路由 wrapper 与转换 wrapper，并讨论 fast/slow 双层写入确认与同键读取合并。这适合启发 expbuild 的 StorageProvider + 压缩/校验/分层模块，但不必复制语言或所有抽象。[Store 模型](https://docs.nativelink.com/explanations/store-model)

同一文档明确指出普通上传的客户端 digest 只是声明；verify wrapper 才校验内容，相关检查默认关闭。对 expbuild 的启示是：**协议承诺的 content digest 必须在写入完成时验证，临时对象验证通过再可见；opaque action/task key 不能被误当成 blob 内容 digest。** 这也是为何一个通用 `PUT key -> bytes` 实现不能自动满足所有缓存协议。

### 3.4 bazel-remote：实例名绝不是天然租户边界

bazel-remote 文档明确说明 CAS HTTP 路径里的 instance name 被忽略；AC 只有启用 `enable_ac_key_instance_mangling` 时才把 instance 混入 lookup key。它还不保证作为 Go module 的内部 API 稳定。[bazel-remote README](https://github.com/buchgr/bazel-remote)

expbuild 建议：先鉴权确定 tenant/project，验证请求的 namespace 权限，再构造内部 scope。外部的 `instance_name`、teamId、URL path、header 都是待校验的输入。复用外部缓存引擎时需验证真实物理/逻辑隔离，不能只给客户端拼一个不同前缀。优先 tenant 内去重，不默认跨 tenant 去重。

### 3.5 Develocity：企业价值来自诊断与运维闭环

Develocity 的任务输入对比能解释 miss，但需要收集任务输入与构建上下文；纯服务端只看到 opaque key 时不可能反推出所有原因。Edge 提供中心注册、节点状态、位置、流量、配置与指定对象跨边缘清理；短期 token 可绑定权限、项目与有效期。[任务输入对比](https://docs.gradle.com/develocity/tutorials/task-inputs-comparison/)、[Edge 手册](https://docs.gradle.com/develocity/edge/2.1/)、[Token API](https://docs.gradle.com/develocity/api-manual/)

expbuild 建议：缓存洞察分三级承诺。一级无需 agent：请求/命中/字节/延迟/后端/配额/清理。二级依靠构建事件与 CI metadata：项目、commit、branch、invocation、target/task、节省执行量估计。三级依靠客户端输入模型：miss diff、非确定性、关键路径收益。没有信息时显示 unknown，不能用 GET 404 伪装“代码变更导致未命中”。

自托管运维也属于产品：初始化向导、配置校验、升级迁移、备份恢复、健康检查、支持包、离线镜像、审计导出、数据清理。Edge 不只是多部署几个 proxy；撤销、隔离、清理和使用量必须覆盖所有副本。

### 3.6 Nx / Turborepo：可信结果比“已经存在的对象不可覆盖”更重要

Nx 在 2026-05-21 弃用其 s3/gcs/azure/shared-fs 自托管包。官方说明的 CREEP 风险是：不受信任 PR 和受保护主分支使用同一缓存键，不受信任工作流先写入污染结果。新自托管 API 要求已存在 key 返回 409，但 first-write-wins 本身不能阻止最先写入者不可信。[Nx 弃用说明](https://nx.dev/docs/reference/deprecated/self-hosted-cache-packages)、[安全分析](https://nx.dev/blog/creep-vulnerability-build-cache-security)

Nx Cloud 描述了 immutable artifact、按任务访问、可见性分层以及 token 来源追踪。Turborepo 可启用 HMAC-SHA256 artifact 签名，校验失败按 cache miss 处理；共享签名密钥的任何 writer 仍然处于同一信任域。[Nx 缓存控制](https://nx.dev/docs/kb/unknown-local-cache)、[Turborepo 远程缓存](https://turborepo.dev/docs/core-concepts/remote-caching)

expbuild 建议默认：受保护 CI 可写 trusted namespace；普通开发者只读 trusted，可写个人/项目开发 namespace；外部 PR 只读公开允许内容，写独立 PR namespace；trusted 不回读 untrusted。身份/分支必须来自验证过的 workload identity 或后台绑定，不信任任意客户端自报 header。promotion 应重建/验证 provenance 后发布新可信记录，不能只改 UI 标签。

### 3.7 sccache：集成现有客户端优于重新造缓存客户端

sccache 支持 C/C++/Rust 等编译器 wrapper 和多个远程存储，WebDAV 后端有 endpoint、key prefix、只读模式及 Basic/Bearer 配置。它自身处理编译器 flags、toolchain 与是否可缓存的语义。[sccache README](https://github.com/mozilla/sccache)、[WebDAV 说明](https://github.com/mozilla/sccache/blob/main/docs/Webdav.md)

expbuild 建议先提供该 backend 所需的兼容语义、配置片段、连通性诊断与统计接收；只有标准入口做不到安全身份交换、边缘代理或更细诊断时，才增加可选 expbuild CLI/agent。不要以“支持 Rust/C++”承诺所有编译和链接步骤都会命中。

### 3.8 Depot：直接竞品与具体差异化空间

后续已完成 [Depot深度调研与架构推断](../research/depot/README.md)，补充公开代码、数据库/存储演进和事故证据。Depot Managed可把数据面部署至客户AWS账户，仍使用其托管控制面；因此不能把“客户云内运行”当作expbuild独有能力，差异化应进一步验证完整自主部署、离线运行和统一扩展治理。[Managed说明](https://depot.dev/docs/managed/overview)

Depot Cache 官方认证页列出 user token、organization token、runner 单 job token，且说明 cache 不支持 project token，因为其 project 模型用于容器构建。GitHub Actions cache 集成页说明按 repository 隔离，但不强制 branch 隔离；不要把这个边界扩展到它所有产品。[缓存认证](https://depot.dev/docs/cache/authentication)、[GitHub Actions 集成](https://depot.dev/docs/cache/integrations/github-actions)

expbuild 可验证的产品假设是：多团队企业愿意为**所有协议一致的项目授权、namespace 信任、预算、审计和私有部署**付费。这个假设需要 3–5 家混合技术栈企业试点验证，不能直接从功能表推导市场需求。

## 4. “管理功能完善”的分层定义

| 管理域 | 首个企业版本必须具备 | 后续扩展 |
|---|---|---|
| 租户与组织 | tenant/org、project、namespace；所有 API 查询强制 scope | 部门/项目组、子组织、独立数据面、专属 bucket/KMS |
| 人与机器身份 | 本地 bootstrap admin、项目 RBAC、服务账号、可过期/撤销 token；OIDC 在 P1 正式版，客户要求时前移 P0 | SAML、SCIM、workload OIDC、细粒度 ABAC |
| 信任策略 | cache read 与 result publish 分离；CI/dev/PR 域；显式共享 | 验证后 promotion、来源证明、隔离区、批量撤回 |
| 配额与治理 | 存储软/硬限、上传大小、并发、速率、保留期、管理员清理 | 团队预算、突发预算、差异化存储策略、成本分摊 |
| 洞察 | 命中率、miss、字节命中率、延迟分位、流量、错误、策略拒绝、top namespaces | invocation 对比、输入 diff、异常检测、优化建议 |
| 运营 | 节点/后端健康、配置变更、审计、告警、导出、备份恢复 | 多站点与跨区域、主动预热、Edge 管理、SLA |
| 扩展管理 | 内置适配模块的版本/能力/健康与兼容范围 | P2 SDK/插件管理；再按需求增加签名插件、市场、灰度/回滚与开发门户 |
| 自动化 | 管理 API、配置即代码、CLI、标准 metrics/trace | Terraform provider、策略模板、事件集成 |

“租户”适用于未来客户边界；企业自托管中可以只有一个 tenant，但业务表、对象键、事件、授权决策从第一天携带 tenant_id。project 为权限与成本归属；namespace 为协议、信任级别、平台/toolchain 或业务共享域，避免让单个字符串同时承担所有职责。

配额必须定义账本口径：逻辑字节/物理字节、压缩前/后、共享对象计费归属、写入预留、失败释放、删除延迟。软限告警与硬限拒绝分离；硬限一般拒绝新增写入，已有可信缓存读取继续服务。产品不应暗示“命中率高 = 一定更快”，还要同时观察下载开销和关键路径。

## 5. 应自行实现、集成、延期的边界

| 能力 | 建议 | 原因与验收重点 |
|---|---|---|
| 统一身份、租户、项目、namespace、策略、审计、usage | 自行实现领域模型，复用成熟 OIDC/RBAC 库 | 这是跨协议产品价值；必须覆盖 blob、索引、日志、导出、管理操作全部路径 |
| Gradle/Turbo/Nx/sccache 等协议适配 | 自行实现薄 adapter，依官方规范与真客户端契约测试 | 保留协议状态码、签名、headers、幂等、opaque key 语义；不强改客户端 |
| Blob 存储 | 复用成熟文件/对象存储 SDK，自行定义原子发布与隔离层 | 不重造 S3，不把数据库当大对象存储；核验校验和、流式上传、中断清理 |
| REAPI cache | 小规模可实现自身 core，或先代理成熟引擎做对照 | capabilities、AC/CAS/ByteStream、压缩和完整性是独立验收清单；不要只说“支持 gRPC” |
| 远程执行 | 后置，先接 Buildbarn / Buildfarm；NativeLink 先做许可与边界尽调 | 自建 scheduler/worker 会把平台升级为不可信代码执行基础设施，范围显著扩大 |
| 编译器集成 | 接 sccache/ccache 等客户端 | 保留上游对编译器与工具链的长期兼容积累 |
| 构建事件和分析 | 分协议接入 BEP/CI/可选 agent，自建统一事件 schema | 统一公共字段，扩展字段保留；opaque 协议无法凭服务端猜输入变化 |
| Registry / 包代理 | 先对接 Harbor、Nexus/Artifactory 等现有系统 | OCI/package 镜像、manifest、索引和删除语义不同，不把第一版扩成仓库管理器 |
| Edge / P2P / CDC | Edge 放在缓存内核稳定以后；P2P/CDC 基于实际瓶颈排期 | 配额、删除、撤销、恢复与网络成本会变复杂；不能提前当免费加速 |
| 计费与支付 | 先做可解释使用量/成本分摊，SaaS 时接计费系统 | 企业自托管先验证容量与收益；避免把订阅系统塞进数据面 |

扩展机制建议分两类：高吞吐 adapter/store 使用内部稳定接口和编译期模块；不可信第三方或策略/事件扩展使用进程外 RPC、限时限额、版本能力协商。禁止插件自行绕过身份与 namespace 检查。第一期用两个内置协议适配器证明边界可用；P2 再发布 SDK 与进程外插件样例，市场和热加载后置。

## 6. 当前许可与商业边界

| 项目 | 本次核验结果 | 对 expbuild 的选型含义 |
|---|---|---|
| BuildBuddy | 根 LICENSE 将普通代码列为 MIT，但 enterprise/ 单独使用 Enterprise License；生产使用需要对应订阅协议 | 可研究机制；代码复用逐路径看许可，不把 RBE、SSO 等企业能力视为 MIT |
| Buildbarn bb-storage | Apache-2.0 | 可作为集成候选；实际依赖/组件仍应逐版本核验 |
| Buildfarm | Apache-2.0 | 可作为 REAPI 执行后端候选 |
| bazel-remote | Apache-2.0 | 可作为独立缓存进程/边缘候选，注意内部库 API 稳定性 |
| sccache | Apache-2.0 | 优先兼容现有客户端 |
| NativeLink 当前 main | FSL-1.1-Apache-2.0；许可明确列出 internal use，排除商业 Competing Use；每个版本发布满两年后获得 Apache-2.0 额外许可 | 企业内部部署与把它包装成商业缓存平台是不同用途；不能默认打包销售或 SaaS 可用，避免将未来业务绑定于未确认授权 |
| Nx 开源仓库 | MIT；不能据此推断 Nx Cloud/Enterprise 商业服务的授权 | 实现公开兼容 API；产品与服务边界分开 |
| Turborepo 开源仓库 | MIT；Vercel 托管服务为另一产品边界 | 可实现公开 cache API，签名与 team 参数按规范处理 |
| Develocity / Depot | 商业产品；官方文档与可下载组件不代表可以重新分发或仿造服务 | 作为产品机制参考或用户已有服务的集成对象，避免依赖未公开接口 |

直接证据：[BuildBuddy 根许可](https://raw.githubusercontent.com/buildbuddy-io/buildbuddy/master/LICENSE)、[BuildBuddy 企业许可](https://raw.githubusercontent.com/buildbuddy-io/buildbuddy/master/enterprise/LICENSE)、[Buildbarn 仓库](https://github.com/buildbarn/bb-storage)、[Buildfarm 许可](https://raw.githubusercontent.com/buildfarm/buildfarm/main/LICENSE)、[bazel-remote 许可](https://raw.githubusercontent.com/buchgr/bazel-remote/master/LICENSE)、[sccache 许可](https://raw.githubusercontent.com/mozilla/sccache/main/LICENSE)、[NativeLink 当前许可](https://raw.githubusercontent.com/TraceMachina/nativelink/main/LICENSE)、[Nx 许可](https://raw.githubusercontent.com/nrwl/nx/master/LICENSE)、[Turborepo 许可](https://raw.githubusercontent.com/vercel/turborepo/main/LICENSE)。

expbuild 自身商业边界建议：开源 core 包含可正常生产自托管所需的基本鉴权、隔离、完整性、备份和可观测性；商业价值优先放在运维支持、企业身份生命周期、跨站点管理、高级分析与合规导出、托管服务。不要把“不会串租户”和“不会使用不可信结果”设成付费特性。是否把 SSO 本身商业化是经营取舍；企业自托管优先时，至少基础 OIDC 宜早提供，否则阻碍内部试用。

## 7. 产品验证与里程碑建议

1. **试点验证**：选择已有 2 种以上构建工具、至少 2 个团队的企业，记录冷构建、热构建、CI 重跑、分支切换与同 commit 多环境数据。核心问题是接入时间、运维负担、可信域与收益，不用合成 GET QPS 代替。
2. **企业缓存平台 v1**：做 2–3 个真实生态闭环，每个都完成接入、权限、quota、可视化、故障降级和运维。协议数量是里程碑附属指标。
3. **扩展与 Edge**：证明新增 adapter 不改核心授权；支持远端对象存储 + 本地热层；Edge 具备撤销和删除传播。先单站点 HA，再多站点。
4. **加速编排**：对接成熟 REAPI execution 引擎，按 worker pool 展示并发、队列等待、执行耗时与成本；不要将每种缓存协议都承诺为可远程执行协议。
5. **SaaS 准备**：商业化前补齐租户迁移、密钥隔离、region residency、租户删除、metering 对账、专属部署与滥用控制；由前述 tenant 模型自然演进。

PoC 验收以端到端指标为主：首次可验证命中所需分钟数；同工作负载的 build wall time / CPU-minutes / transferred bytes；cache read/write P95/P99；每次构建的远程缓存开销；跨租户/跨可信域访问负例；无缓存时构建是否仍可完成；清理与撤销传播延迟。节省时间如果依赖历史估计，UI 明示“估算”和基线来源，不直接累加并行 task 时间当开发者节省时间。

## 8. 研究结论索引（详细依据见上文）

1. **定位“企业自托管的统一治理与可信加速”，不把多协议当独创。** Depot 已覆盖多种主流工具。[官方概览](https://depot.dev/docs/cache/overview)
2. **先缓存平台，后远程执行。** Buildbarn 证明存储可独立运行，执行可经标准协议路由。[官方 README](https://github.com/buildbarn/bb-storage)
3. **tenant/project 与外部 namespace 必须分开。** bazel-remote 的 CAS instance 被忽略是现成反例。[官方 README](https://github.com/buchgr/bazel-remote)
4. **权限至少区分内容写入与结果发布。** BuildBuddy Developer 的 CAS/AC 分权值得借鉴。[角色文档](https://www.buildbuddy.io/docs/guide-auth/)
5. **可信写入和分支信任域是内核要求。** Nx CREEP 说明 immutable/first-write-wins 不足以阻止不可信首写。[官方分析](https://nx.dev/blog/creep-vulnerability-build-cache-security)
6. **缓存洞察要声明信息来源与解释边界。** Develocity 输入对比依赖采集的构建模型，单纯 opaque key 请求无法给相同诊断。[官方教程](https://docs.gradle.com/develocity/tutorials/task-inputs-comparison/)
7. **扩展架构应保持小接口与能力声明。** NativeLink store graph 值得研究，但要把验证、原子发布与隔离设为明确不变量。[Store 模型](https://docs.nativelink.com/explanations/store-model)
8. **Edge 是治理系统的一部分。** Develocity 提供节点注册、健康、统计与跨 Edge 对象清理，expbuild 同样要覆盖删除/撤销传播。[官方手册](https://docs.gradle.com/develocity/edge/2.1/)
9. **已有客户端优先兼容。** sccache 已有 WebDAV、只读与 token，Turbo/Nx 已有公开 cache API，不必先强制自研 agent。[sccache WebDAV](https://github.com/mozilla/sccache/blob/main/docs/Webdav.md)、[Nx 自托管](https://nx.dev/docs/kb/self-hosted-caching)、[Turbo 文档](https://turborepo.dev/docs/core-concepts/remote-caching)
10. **技术选型必须同时审查未来商业用途。** NativeLink 当前 FSL 与 BuildBuddy enterprise 分区许可，不能按“仓库公开”推断可包装售卖。[NativeLink 许可](https://raw.githubusercontent.com/TraceMachina/nativelink/main/LICENSE)、[BuildBuddy 许可](https://raw.githubusercontent.com/buildbuddy-io/buildbuddy/master/LICENSE)
