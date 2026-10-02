# expbuild 缓存类型扩展调研与规划

整理日期：2026-10-02。依据：2026-10-01 的官方文档与项目资料调研。状态：候选扩展规划，尚未进行新增引擎的运行、兼容性或性能验证。本文记录建议范围和推进顺序，具体引擎与版本在原型验证后确定。

建议优先扩展 Docker/OCI 镜像拉取缓存、BuildKit 构建缓存、通用制品与 CI 缓存，再接入各语言的软件包缓存。沿用 Kubernetes 管理独立实例的架构，复用已有引擎，统一生命周期、凭据、配置与可观测入口。

现有模板覆盖 REAPI/Bazel HTTP、Gradle HTTP 和 Apache WebDAV；实际交付与验证边界见[实施状态](progress.md)。本规划不表示新增类型已经接入，也不改变 WebDAV 暂时保持现状的约定；自研方向另见[WebDAV 缓存服务方案](webdav-cache-plan.md)。

## 扩展原则

- 按用途和客户端定义服务模板。同一协议可以承载不同用途，不能因为都使用 HTTP 就宣称互通。
- 平台管理实例，引擎处理协议和数据。缓存请求直接访问引擎，管理 API 和 Operator 不进入逐条缓存读写链路。
- 默认继续采用小型独立实例。引擎内部管理条目与索引，不引入跨引擎统一 CacheCatalog。
- 每个精确模板版本声明已验证的存储、清理、指标及客户端能力。缺少的能力显示不支持，不虚构默认实现。
- 候选引擎支持对象存储，不代表 expbuild 当前已支持对象存储实例；相关资源模型、凭据和配额需单独实现。

本文表格中的接入判断与优先级是规划建议；链接支持的是上游能力，不能替代 expbuild 的实际验收。

## 缓存类型与候选实现

| 类型 | 内容与用途 | 候选实现或接入方式 | 建议顺序 |
|---|---|---|---|
| Docker/OCI 镜像拉取缓存 | 缓存上游镜像清单、配置和镜像层，减少重复下载 | [Distribution](https://distribution.github.io/distribution/recipes/mirror/)、[zot](https://zotregistry.dev/v2.1.21/articles/mirroring/)、Harbor | 第一阶段 |
| BuildKit 构建缓存 | 复用 Dockerfile 构建步骤和多阶段构建结果 | 可写 OCI Registry，使用 [cache-to 与 cache-from](https://docs.docker.com/build/cache/backends/registry/) | 第一阶段 |
| 通用制品与 CI 缓存 | 按 key 保存文件、目录归档和中间结果 | HTTP/WebDAV、S3；优先验证 [GitLab Runner 分布式缓存](https://docs.gitlab.com/ci/caching/) | 第一阶段，先确定数据保留语义 |
| npm 包缓存 | 包元数据与 tarball，面向 npm、pnpm、Yarn | [Verdaccio](https://www.verdaccio.org/docs/caching/) | 第二阶段 |
| Maven 依赖缓存 | JAR、POM、插件和仓库元数据 | [Reposilite](https://reposilite.com/)、Nexus Repository | 第二阶段，验证代理缓存行为 |
| Python 包缓存 | wheel、源码包和 PyPI 索引 | [devpi](https://github.com/devpi/devpi) | 第二阶段 |
| Go Modules 缓存 | 模块版本的 .mod、.info、.zip | [Athens](https://docs.gomods.io/configuration/storage/) | 第二阶段 |
| C/C++ 与 Rust 编译缓存 | 编译产物和查询所需元数据 | [sccache](https://github.com/mozilla/sccache)、[ccache](https://ccache.dev/manual/latest.html) 的远程存储接口 | 第三阶段，优先复用已有后端 |
| Monorepo 任务缓存 | 构建、测试等任务的输出和日志 | [Turborepo](https://turborepo.dev/docs/core-concepts/remote-caching)、[Nx 自托管缓存 API](https://nx.dev/docs/kb/self-hosted-caching) | 第三阶段 |
| HTTP 下载缓存 | SDK、工具链、安装包和源码压缩包 | [NGINX 缓存代理](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)，按指定上游接入 | 第三阶段或按实际需求提前 |
| 其他软件包生态 | NuGet、Cargo、Composer、APT、RPM、Alpine 等 | [Nexus 格式适配](https://help.sonatype.com/en/formats.html)、Pulp 对应插件或专用服务 | 按客户需求分别验证 |
| Nix 二进制缓存 | 已构建的 Nix store 内容 | [Attic](https://docs.attic.rs/) | 专项扩展，进一步评估成熟度 |
| 模型与数据集缓存 | 模型文件、数据集及其下载内容 | 先研究上游专用接口、认证、重定向与存储协议 | 专项扩展，尚未锁定引擎 |

这些类型不必各自对应一套新引擎。例如 OCI 引擎可以承载镜像、BuildKit 缓存和 OCI 制品，但产品入口、权限、清理策略和验收应分别定义。Maven 依赖缓存加速依赖下载，已有 Gradle HTTP 缓存复用任务结果，两者互补。

## Docker 与 OCI 服务

### 镜像拉取与 BuildKit 构建缓存

建议先定义两个独立用途的模板：

| 用途 | 数据如何进入服务 | 主要配置 |
|---|---|---|
| 镜像拉取缓存 | 客户端请求未缓存的镜像时，服务从上游获取 | 上游地址及凭据、允许的仓库范围、重验证和保留策略 |
| BuildKit 构建缓存 | 构建客户端主动上传缓存，后续构建读取 | 读写凭据、缓存仓库或引用、分支隔离、保留与回收策略 |

BuildKit 的 Registry 后端可以将缓存与最终镜像分开保存，支持 `mode=max` 导出多阶段构建缓存。接入时仍需验证客户端版本、构建驱动和媒体类型组合。[Docker Registry 缓存文档](https://docs.docker.com/build/cache/backends/registry/)

建议首版使用独立实例，后续再评估同一引擎内的仓库隔离。不能把只支持拉取代理的实例同时当作可写缓存仓库；例如 Harbor 的代理缓存项目明确不支持 push。[Harbor 代理缓存](https://goharbor.io/docs/main/administration/configure-proxy-cache/)

### 引擎比较

| 候选 | 官方资料中的能力 | 对 expbuild 的建议判断 | 待验证重点 |
|---|---|---|---|
| Distribution | 单上游拉取缓存、过期清理；官方建议拉取缓存采用 filesystem 存储 | 作为最小实现和兼容性基线 | Docker/containerd/BuildKit 接入、凭据、清理、指标口径 |
| zot | 按需同步、本地及对象存储、保留策略、在线 GC、Prometheus 指标 | 作为覆盖更多 OCI 用途的重点候选 | 原始 digest、多架构镜像、上游认证、清理期间读取、资源开销 |
| Harbor | 多种上游的代理缓存项目、配额、保留策略和仓库管理 | 优先考虑企业已有 Harbor 的集成场景 | 独立部署成本、外部服务归属、管理权限与配额映射 |

依据：[Distribution 拉取缓存](https://distribution.github.io/distribution/recipes/mirror/)、[zot 镜像同步](https://zotregistry.dev/v2.1.21/articles/mirroring/)、[zot 存储](https://zotregistry.dev/v2.1.21/articles/storage/)、[zot 保留策略](https://zotregistry.dev/v2.1.21/articles/retention/)、[zot 指标](https://zotregistry.dev/v2.1.21/articles/monitoring/)、[Harbor 代理缓存](https://goharbor.io/docs/main/administration/configure-proxy-cache/)。

Distribution 与 zot 先做对比原型，尚不固定最终选型。Harbor 外部实例接入只是候选方向，不表示现有 Operator 已能管理外部仓库。

### 协议与清理边界

Docker daemon 的 `registry-mirrors` 机制面向 Docker Hub，不能据此宣称透明代理所有 Registry。其他上游需要对应的客户端配置或镜像引用改写；平台应生成与客户端匹配的接入说明。Distribution 的镜像地址还要求位于域名根路径，可复用平台独立实例域名的方向。[Distribution 文档](https://distribution.github.io/distribution/recipes/mirror/)

镜像按 digest 拉取时必须保持内容身份。zot 对混合 Docker/OCI 镜像的兼容与 digest 保留有专门配置；原型应覆盖按 digest 固定引用、多架构清单及相关签名或引用信息，不只验证按 tag 拉取。[zot 同步与兼容配置](https://zotregistry.dev/v2.1.21/articles/mirroring/)

镜像清理要分成三步理解：保留策略选择可删除的引用，GC 回收不再被引用的数据，容量控制决定空间不足时如何处理。原生支持 GC 不等于支持容量上限下的 LRU 淘汰，不能在界面上混成一个开关。[zot 存储与 GC](https://zotregistry.dev/v2.1.21/articles/storage/)

上游凭据的授权范围必须与实例访问范围一致。代理持有的上游私有仓库权限，不能通过一个权限更宽的共享缓存入口泄露给其他项目。[Harbor 代理凭据边界](https://goharbor.io/docs/main/administration/configure-proxy-cache/)

## 制品与 CI 缓存

### 数据用途与保留规则

artifacts 是文件用途的统称，不是一种通用缓存协议。第一阶段先明确以下边界，再确定对外模板：

| 数据用途 | 示例 | 建议的管理规则 |
|---|---|---|
| 可重建缓存 | 依赖目录、编译目录、临时结果归档 | 按 key 读写，允许到期和容量淘汰；丢失时客户端能重新生成 |
| 流水线产物 | 下一个阶段必须读取的中间包、测试报告 | 关联构建或任务，校验完整性，并设置明确保留期 |
| 发布制品 | 正式版本安装包、交付包 | 版本与不可变性、保留保护、下载权限；不能沿用普通缓存自动淘汰语义 |

GitLab 将 cache 与 artifacts 作为不同机制：前者用于复用缓存，后者用于保存和传递任务产物。expbuild 的服务设计应保留这种差异。[GitLab 缓存与制品说明](https://docs.gitlab.com/ci/caching/)

首轮建议验证可重建缓存；流水线产物和发布制品作为独立能力候选，尚未决定完整制品仓库的产品范围，不在缓存模板内默认承诺永久保存。

### 接入路线

普通文件和 CI 归档可采用 HTTP/WebDAV 或 S3。GitLab Runner 已支持分布式缓存和对象存储生命周期清理，适合作为首个真实客户端。S3 只提供存储接口，key 规则、回退匹配、归档格式和命中语义仍由客户端或适配服务负责；不能因为后端兼容 S3 就宣称兼容所有 CI。[GitLab 分布式缓存](https://docs.gitlab.com/ci/caching/)

OCI 制品可复用 Registry，通过 ORAS 上传、下载普通文件。应单独声明客户端、制品格式与保留策略；可上传文件并不表示已经具备发布审批、完整版本治理等制品仓库功能。[ORAS 快速开始](https://oras.land/docs/quickstart/)

GitHub Actions 需要单独适配。连接 GitHub.com 的自托管 Runner 默认仍使用 GitHub 的缓存存储；提供 S3 接口不等于可直接替换官方 `actions/cache`。后续应明确是提供专用 Action/CLI，还是实现并验证对应服务协议。[GitHub 缓存说明](https://docs.github.com/en/actions/concepts/workflows-and-actions/dependency-caching)

## 软件包与任务缓存

### 专用软件包服务

优先评估 Verdaccio、devpi、Athens 和 Reposilite，各自验证包管理器真实请求、索引刷新、私有上游、离线读取、故障恢复与清理行为。资源开销、启动时间及每实例成本应实测，不仅依据项目对轻量化的描述判断。

软件包服务需要分别描述元数据过期、内容淘汰和物理空间回收。Verdaccio 的 `maxage` 控制上游元数据有效时间，不能直接展示为包文件保留时间；第三方存储插件的清理与指标也需另行认证。[Verdaccio 缓存策略](https://www.verdaccio.org/docs/caching/)

需要大量包格式时，可评估 Nexus 或 Pulp 作为另一类部署选项。调研时 Nexus Community Edition 文档列出 40,000 个组件、每天 100,000 次请求的使用限制；选型时应重新核对目标版本与许可。Pulp 提供按需下载和空间回收，具体支持范围取决于插件，不能将回收 API 等同于已实现自动 LRU。[Nexus 使用限制](https://help.sonatype.com/en/usage-center.html)、[Pulp 按需下载](https://pulpproject.org/pulpcore/docs/user/learn/on-demand-downloading/)、[Pulp 空间回收](https://pulpproject.org/pulpcore/docs/user/guides/reclaim-disk-space/)

### 编译与 Monorepo 任务

sccache 支持 S3、WebDAV 等远程后端；ccache 也提供远程存储机制。接入可以先复用已有服务，增加客户端配置、独立命名空间与兼容性验收。两者的 key、数据格式和统计不同，不能假设条目互通。ccache 的远程存储与 helper 机制还需按具体客户端版本认证。[sccache](https://github.com/mozilla/sccache)、[ccache 手册](https://ccache.dev/manual/latest.html)

Turborepo 提供公开远程缓存协议和社区实现，Nx 提供自托管服务 OpenAPI。可评估独立协议适配器复用文件或对象存储，但鉴权、任务内容和兼容版本分别管理。[Turborepo 协议](https://turborepo.dev/docs/core-concepts/remote-caching)、[社区服务实现](https://github.com/ducktors/turborepo-remote-cache)、[Nx API](https://nx.dev/docs/kb/self-hosted-caching)

### 专项扩展

Nix 可研究 Attic，其文档描述了 S3 后端、去重及 GC，同时仍标注早期原型状态，应进一步核对维护与发布情况。[Attic](https://docs.attic.rs/)

模型和数据集缓存需要专门研究。Hugging Face 下载涉及 Hub API、重定向及独立存储服务，不能只代理一个域名就认定兼容。大规模镜像或文件分发还可以研究 Dragonfly 的 P2P 加速，但这是分发层扩展，不应替代每种缓存服务自身的数据与权限语义。[Hugging Face 下载链路](https://github.com/huggingface/hub-docs/blob/main/docs/hub/datasets-downloading.md)、[Dragonfly](https://d7y.io/docs/)

## 平台模板能力扩展

现有模板通过编译内注册表接入，当前声明不足以表达全部候选服务。建议随着首批原型逐步增加以下能力，避免在原型前建立过大的统一模型。

| 能力维度 | 模板需要说明的内容 |
|---|---|
| 用途与协议 | 镜像代理、构建缓存、文件归档、发布制品；对应协议与操作 |
| 数据来源 | 客户端写入、上游回源，或经过验证的混合方式 |
| 上游配置 | 地址白名单、仓库范围、凭据引用、重验证、断网行为 |
| 存储 | PVC、对象存储、可选本地加速层，各自的容量和清理边界 |
| 清理策略 | 容量淘汰、到期、版本保留、GC、保留保护是否支持及何时生效 |
| 可观测 | 指标来源、命中单位、上游流量、回收结果、数据质量状态 |
| 客户端 | 已认证版本、接入配置、鉴权、读写权限和真实验收结果 |

对象存储实例需要独立设计凭据、bucket 或前缀归属、配额及删除策略，不能把 PVC 容量与对象存储容量视为同一个字段。引擎应执行条目清理，Operator 负责声明配置、触发受支持的维护动作和观测结果。

界面按用途组织服务目录，提供中英文名称、配置说明和客户端示例，沿用平台面向全球用户的方向。不支持的策略不显示为可选项，也不能接受后静默忽略。

## 可观测与统计语义

延续[可观测规划](observability-plan.md)的身份隔离、指标低基数和缺失数据规则。新增类型至少评估请求、服务错误、延迟、流量、容量和清理结果；只有真实可测的指标才进入模板能力声明。

| 统计 | 含义与限制 |
|---|---|
| 请求命中 | 有效缓存查询是否直接获得已有数据；认证失败、服务错误和首次回源成功分别统计 |
| 字节命中 | 请求的数据字节中由缓存提供的比例；区分请求次数与字节数 |
| 上游流量 | 实际回源请求及传输量；未观测到上游行为时不估造精确节省值 |
| 构建任务命中 | BuildKit、编译器或任务客户端跳过了多少工作，需要客户端数据 |
| 存储占用 | 逻辑条目、实际物理占用、临时上传和待回收空间分别展示 |
| 清理结果 | 引用删除、数据回收、释放字节、失败及积压分别展示 |

成功响应不等于缓存命中：代理首次回源成功也会返回成功状态。有 `/metrics` 不等于已有准确缓存命中率，应检查计数器定义并做冷、热请求对照。各模板分别统计 metadata、manifest、blob、任务结果等操作，不将不同语义的命中率直接平均。

## 建议实施顺序与验收

| 阶段 | 工作范围 | 进入下一阶段前的产出 |
|---|---|---|
| 第一阶段 | Distribution 与 zot 对比；镜像拉取、BuildKit、通用制品/CI 缓存原型 | 明确引擎和版本、制品保留边界、存储方式、客户端兼容与指标缺口 |
| 第二阶段 | Verdaccio、devpi、Athens；Maven 候选验证 | 软件包模板、上游认证和隔离、元数据刷新、可执行清理与客户端示例 |
| 第三阶段 | sccache/ccache、Turborepo/Nx、HTTP 下载代理及其他包生态 | 客户端与模板认证矩阵、可复用的存储适配、独立统计 |
| 专项扩展 | Nix、模型与数据集、P2P 分发、外部 Harbor 等 | 根据实际用户需求形成独立方案，避免作为首批交付前提 |

顺序是建议，不是日历或交付承诺。HTTP 上游代理仍需验证 Cache-Control、重验证、认证响应隔离和淘汰；现有 WebDAV 不因本次规划继续扩展 Apache 模板。

新增模板的最低验收范围：

- 真实客户端冷请求、热请求、缺失数据和错误行为；OCI 额外验证 digest、多架构镜像及 BuildKit 缓存恢复。
- 上游私有认证、实例读写权限、凭据轮换及项目间隔离；缓存归属不能扩大原有授权。
- 并发读写、重复回源、上传中断、重启恢复、磁盘或存储预算耗尽、清理与读取并发。
- 将清理规则与最终释放空间对照，明确保留数据不会被普通缓存策略删除。
- 生命周期与管理链路：创建、配置、暂停恢复、删除、存储保留，以及 Helm/API/Operator 的一致行为。
- 核对指标中的命中、未命中、错误与回源；测量启动、吞吐、延迟、内存和恢复耗时后再定义规格。

每个原型最终应交付固定版本或镜像摘要、原生配置与能力矩阵、真实客户端用例、指标映射、清理与恢复结果，以及已知限制。通过后再进入模板、CRD、管理 API 和界面的正式实现；本文不启动这些开发工作。
