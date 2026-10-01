# expbuild 多协议缓存：协议研究与接入边界

研究日期：2026-09-28。定位前提：企业自托管优先，预留 SaaS。本文只做官方文档、规范、源码与版本说明核实，**未对 expbuild 执行任何协议互通 PoC**。“已核实”仅指来源明确，不能解释为现有实现已经兼容。main/latest/current 文档会变化，发布前必须固定客户端版本、规范 commit 和测试结果。

## 结论

平台适合统一身份、命名空间、存储、配额、生命周期、运维和可观测性；缓存键计算与产物格式仍由各工具负责。不要承诺 Bazel、Gradle、sccache、Nx、Turborepo 之间能互相命中缓存。底层恰好相同字节可去重，是物理存储优化，不是跨工具语义复用。

综合仓库审计与平台建设成本，最终首版只承诺两个生态：**既有 REAPI 缓存能力收敛 + Gradle HTTP**。sccache WebDAV 放 P1.x；若种子客户以 Rust/C++ 为主，用它替换 Gradle，而不是增大首版。Bazel HTTP 为新增协议面，放 P1.x 并单独验收，不能称作现有能力。Turborepo、Nx、ccache 放 P1.x，BuildKit registry 和 Maven 放 P2；远程执行、Nix / GitHub Actions 协议仿真按 P3 需求决策。P0 是受控企业试点，P1 为企业正式版。

最终阶段范围见 [总规划](README.md) 与 [路线图](06-roadmap-and-validation.md)。P0 的意义是两种生态在受控试点中完成管理、安全和运维闭环，不是协议数最多。

## 协议矩阵

| 生态 / 优先级 | 接入性质与最小范围 | 认证 / 签名 / 压缩 | 关键限制、生命周期与待验证项 | 一手来源 |
|---|---|---|---|---|
| Bazel HTTP，P1.x 新增 | 原生客户端协议；`GET/PUT /ac/{hash}` 与 `/cas/{hash}`；AC 为 ActionResult，CAS 为内容 | HTTPS；Bazel 支持 HTTP Basic；服务端必须区分请求认证与产物可信性 | AC 键不是 AC payload 摘要。不能把所有 `/ac` 内容当普通 blob 校验，也不能让 ccache 借用端点破坏 Bazel ActionResult 校验。CAS 摘要/长度、AC 引用完整性、并发覆盖和清理竞态必须 PoC | [Bazel remote caching](https://bazel.build/versions/8.2.0/remote/caching) |
| Bazel REAPI 缓存，P0 收敛 / P1 完善 | 原生 gRPC；Capabilities、ActionCache、CAS 的 FindMissing/BatchRead/BatchUpdate/GetTree、ByteStream Read/Write/QueryWriteStatus 等按支持范围实现；不等于远程执行 | TLS 与 gRPC 认证；压缩能力协商，identity 必须可用；zstd 由能力位及客户端支持决定 | 协议版本、digest function、batch limit 必须真实声明；压缩 blob 的摘要/尺寸针对解压后的字节；ByteStream offset/resume 和提前完成特殊语义；AC 命中需确保输出仍可取。新 chunking RPC 不应不经验证就宣称支持 | [REAPI proto](https://github.com/bazelbuild/remote-apis/blob/main/build/bazel/remote/execution/v2/remote_execution.proto)、[REAPI 概览](https://github.com/bazelbuild/remote-apis/blob/main/README.md) |
| Gradle HTTP，P0 | 内置原生 HTTP；按 opaque key `GET/PUT` 单份 task-output entry，无需自定义 Gradle 插件 | HTTP Basic + HTTPS；归档原样保存。协议没有等同 Turbo HMAC 的标准签名约定 | GET 命中用 200、未命中 404；PUT 2xx，过大可 413；PUT 重定向用 307/308。客户端默认 remote push 关闭。测试网络故障、Expect-Continue、私有 CA；opaque entry 可按条目清理 | [Gradle build cache](https://docs.gradle.org/current/userguide/build_cache.html)、[HttpBuildCache API](https://docs.gradle.org/current/javadoc/org/gradle/caching/http/HttpBuildCache.html) |
| sccache WebDAV，P1.x / P0 替换候选 | 使用客户端既有远端存储后端，expbuild 暴露相应 HTTP/WebDAV 兼容入口；**不是 sccache 专属统一构建协议** | 官方配置支持 Basic 或 Bearer、key prefix、只读模式；HTTPS；客户端产物封装保持 opaque | 官方文档明确可对接 ccache/Bazel/Gradle 风格服务，但这仅是存储传输兼容。必须固定 sccache release，确认编译了 webdav feature、路径布局、所需 methods、读写冲突及压缩归档。不能混入 Bazel AC 语义空间 | [sccache WebDAV](https://github.com/mozilla/sccache/blob/main/docs/Webdav.md)、[sccache README](https://github.com/mozilla/sccache) |
| sccache S3，P1 可选集成 | 客户端既有 S3 存储后端；使用企业自有 S3 或 expbuild 管理的 bucket/prefix/credential 是一种接入路线 | AWS 凭证、SigV4 兼容与 endpoint/TLS；可只读、prefix 隔离 | **expbuild 能把数据存在 S3，不代表它自身兼容 S3 服务端 API**。若客户端直连 bucket，expbuild 无法天然获得完整逐请求授权、命中统计和立即撤销能力；若自建 S3 网关，需单独范围与验收，不为一个客户端重造完整 S3 | [sccache S3](https://github.com/mozilla/sccache/blob/main/docs/S3.md) |
| Turborepo Remote Cache，P1.x | 原生自托管 HTTP API；artifact 上传/下载、HEAD、状态、查询、事件等以固定 OpenAPI 及 CLI 调用为准 | Bearer；支持客户端 HMAC-SHA256 签名，需配置 `TURBO_REMOTE_CACHE_SIGNATURE_KEY`；保存/返回签名 metadata 并维持字节一致 | teamId/slug 只能是请求参数，必须绑定认证主体后授权；GET/PUT 两个路由并非完整兼容承诺。服务端任意重打包会影响客户端验签。签名密钥持有者可签任意产物，仍需可信写入域 | [Turbo remote caching](https://turborepo.dev/docs/core-concepts/remote-caching)、[环境变量](https://turborepo.dev/docs/reference/system-environment-variables)、[官方 API 文档](https://turborepo.dev/docs/openapi) |
| Nx custom remote cache，P1.x | 官方 OpenAPI 自托管路线；`GET/PUT /v1/cache/{hash}`，二进制 tar；设置 `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` | Bearer，`NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`；该开放规范不应被描述为自动具备 Nx Cloud 的端到端加密或来源验证 | PUT 200，401/403，已存在不可覆写 409；GET 200/403/404；上传 Content-Length。格式可能随 Nx 版本改变，需跨版本实测。不沿用已弃用 custom task runner 接口；不把“首次写入成功”当可信构建证明 | [Nx 自托管规范](https://nx.dev/docs/kb/self-hosted-caching)、[官方变更说明](https://nx.dev/blog/custom-runners-and-self-hosted-caching) |
| ccache HTTP(S)，P1.x | 远端存储接入；旧内置 HTTP 后端或官方 storage helper，GET/PUT/DELETE 与 layout | 旧内置 HTTP 不支持 HTTPS；官方 Go/C++ helper 支持 HTTPS；Go helper 有 Bearer/custom headers；产物压缩 opaque | 4.14 已弃用内置 HTTP/Redis，helper 自 4.13 引入。`layout=bazel` 只复用 `/ac/` 路径，ccache 内容不是 Bazel ActionResult；建议独立路由/命名空间。服务器负责远端清理，manifest/result 层的缓存语义归 ccache | [ccache manual](https://ccache.dev/manual/latest.html)、[storage helpers](https://ccache.dev/storage-helpers.html)、[Go helper](https://github.com/ccache/ccache-storage-http-go)、[release notes](https://ccache.dev/releasenotes.html) |
| BuildKit registry/OCI cache，P2 | 原生 BuildKit cache exporter/importer 使用 OCI Distribution/Registry 服务；应优先集成成熟 registry，不从普通 KV route 硬拼 | Docker registry 的认证流程；gzip/estargz/zstd 等由 exporter 选择；digest 完整性不等于产物来源认证 | 需要 blob upload session、manifest/tag、media type、跨仓库授权、Range/HEAD 等完整路径。GC 要理解 manifest→blob 引用与正在上传数据；mode=max/min、OCI image index vs image manifest、跨平台都需 PoC。不是 BuildKit 远程执行服务 | [Docker registry cache](https://docs.docker.com/build/cache/backends/registry/)、[OCI Distribution](https://github.com/opencontainers/distribution-spec/blob/main/spec.md) |
| Maven Build Cache Extension，P2 | Apache 官方扩展，用户需启用扩展；通过 Maven Resolver 对 HTTP GET/PUT/HEAD 存储接入；不是 Maven 依赖仓库代理 | 凭证/代理从 Maven settings 的 server id 配置；文件树保持原格式 | 源码、插件输入、reconciliation 配置决定正确性。不是加一个 URL 就让任意 Maven 项目安全缓存。WebDAV 在 Maven 3.9.1/4 alpha5 后默认行为变化，需按固定 Resolver transport 验证；清理须覆盖同一 build info 关联多文件 | [Maven 入门](https://maven.apache.org/extensions/maven-build-cache-extension/)、[远端配置](https://maven.apache.org/extensions/maven-build-cache-extension/remote-cache.html) |
| Nix binary cache，P3 需求驱动 | 原生 Nix substituter HTTP；`.narinfo`、NAR、cache info 与引用关系；上传工作流另外验证 | trusted-public-keys 与签名；NAR 可 xz/zstd/gzip 等；认证和 NAR 来源签名是两层 | 不可用普通 TTL 独立删除 NAR/metadata；需闭包引用、发布顺序、签名轮换、store path 与内容寻址区别。读协议支持不等于所有 `nix copy` 上传场景均兼容 | [narinfo](https://nix.dev/manual/nix/2.35/protocols/binary-cache/narinfo.html)、[HTTP binary cache store](https://nix.dev/manual/nix/2.35/store/types/http-binary-cache-store.html) |
| GitHub Actions cache，P3 | 两条产品路线：① expbuild 自有 Action/CLI；②兼容 GitHub cache 服务协议。后者不是普通 GET/PUT，也不是“使用 GitHub Actions 跑 CI” | 官方客户端依赖 runner runtime token 与注入 endpoint；v2 协调 RPC 使用 Bearer，上传另用 signed URL | v2 Twirp + blob upload；官方 SDK 上传走 Azure BlockBlob，不能直接给 S3 presigned PUT 就假设兼容。GHES 与 github.com 版本路径不同；分支 scope、restore-key/version、提交和并发写语义需分别实现。不能承诺 stock actions/cache 只改 URL 即无缝替换 | [actions/cache](https://github.com/actions/cache)、[Twirp client](https://github.com/actions/toolkit/blob/main/packages/cache/src/internal/shared/cacheTwirpClient.ts)、[上传源码](https://github.com/actions/toolkit/blob/main/packages/cache/src/internal/uploadUtils.ts)、[配置源码](https://github.com/actions/toolkit/blob/main/packages/cache/src/internal/config.ts) |

## 补充生态：复用协议与客户端扩展路线

- **Pants / Buck2**：优先作为 REAPI 的额外客户端兼容档案，而不是再造一个平台协议。Pants 官方明确提供 REAPI remote caching；Buck2 可连接 REAPI 服务，但缓存策略、延迟物化、平台属性和保留期假设仍需独立测试。Bazel 通过不等于两者自动通过。列入 P1.x/P2 客户需求候选，不阻断首版。[Pants 稳定文档](https://www.pantsbuild.org/stable/docs/using-pants/remote-caching-and-execution/remote-caching)、[Buck2 RE](https://buck2.build/docs/users/remote_execution/)、[延迟物化](https://buck2.build/docs/users/advanced/deferred_materialization/)。
- **Go GOCACHEPROG**：Go 1.24 将外部缓存进程机制从实验开关移出，通过子进程 JSON 协议接管构建/测试缓存。因此接入需要一个本地 helper 桥接到 expbuild，不能直接把变量设为 HTTP URL。列为后续需求候选（默认 P3，可由明确客户需求替换其他项）；验证工具链版本、helper 发布、进程协议、结果文件 materialization、并发与退出行为。它不同于 GOPROXY 的模块依赖下载代理，后者属于另一个产品面。[Go 1.24 GOCACHEPROG](https://go.dev/doc/go1.24#GOCACHEPROG)、[官方协议类型](https://go.dev/src/cmd/go/internal/cacheprog/cacheprog.go)。

## 对统一内核的直接要求（设计推论）

1. **分离逻辑缓存键与内容摘要。** 逻辑键建议由 tenant / namespace / protocol / entry-kind / client-key 构成；内容字节另行计算 storage digest。digest algorithm 与编码格式显式记录。不能假设路径里的 hash 就是上传 body 的 hash。
2. **至少三种条目模型。** opaque 单体归档（Gradle、Turbo、Nx、sccache 等）；索引→内容图（Bazel AC/CAS、Maven build info）；manifest/tag/闭包图（OCI、Nix）。公共存储能力复用，引用提取、提交原子性、清理根和协议错误映射由适配器负责。
3. **写入分阶段。** 临时上传→完整性验证→内容可见→索引提交；取消、超时、崩溃留下的数据可回收。不能先返回 AC/manifest 命中，再发现依赖 blob 尚未持久化。对要求不可变的协议提供原子 create-if-absent；对更新型索引提供并发控制，不能全平台一刀切 last-write-wins。
4. **GC 需要引用和读保护。** 索引/manifest 过期后再延迟清理无引用 blob；活跃上传、近期读取和构建所需对象有保护期。Bazel 成功返回 AC 后，应在下载窗口内保护其输出。单体条目可 TTL/LRU，但与引用图条目共用“删文件最老者”不安全。GC dry-run、预计释放、删除审计和隔离区作为管理功能。
5. **认证、字节完整性、来源可信分开。** Token 说明谁能调用，digest 说明字节是否匹配，签名说明某个密钥授权的字节；三者都不能自动证明“由目标源码和工具链构建”。服务端至少区分 trusted CI、developer、PR/untrusted 的写入域；允许消费可信上游，但不能让 PR 首次写入抢占生产 key。可信产物提升需携带构建身份与策略。
6. **租户归属从服务端身份导出。** instance_name、teamId、URL path、S3 prefix 只用于定位候选资源，不能靠任意客户端声明授予访问权。跨租户物理去重默认关闭；未来开启需处理存在性侧信道、加密边界和配额记账。
7. **压缩不能破坏协议。** 传输压缩、客户端归档压缩、服务端内部压缩是不同层。最初按 opaque 字节流保存已压缩/已签名内容；Bazel 根据 REAPI 压缩语义处理明文 digest，OCI 保持 manifest 和 layer 的指定表示。避免全局 HTTP gzip middleware 修改签名/长度/Range 行为。
8. **插件协议要暴露能力而非只暴露 get/put。** 建议接口包含 authorize-context、lookup/read/write、begin/commit/abort upload、extract-references、validate、error mapping、capability declaration、retention roots、telemetry。核心负责限流/配额/存储事务，适配器不能任意访问别的租户。P0 先做编译期模块，P1/P2 再发展隔离进程插件，避免首版为热插拔 ABI 付出过高成本。
9. **通用指标要避免假精确。** HTTP 200、blob GET、HEAD success、AC hit 都不等于“节省一次完整构建”。平台统一报告 request/entry/byte 层命中、带宽、容量、延迟；节省构建时长需要客户端构建事件和对照基线。Turbo duration 之类客户端字段须标明来源，不能与实测 CPU seconds 混合。

## 容易误判的边界

- Bazel REAPI 缓存兼容不代表支持 Execute、worker、scheduler、sandbox、toolchain；远程执行单独规划。
- sccache 分布式编译同样是另一套 scheduler/build server，不属于支持 WebDAV/S3 存储后的自动能力。[sccache distributed quickstart](https://github.com/mozilla/sccache/blob/main/docs/DistributedQuickstart.md)
- Gradle task-output cache 不等于 configuration cache，不等于 Maven/Gradle dependency proxy。缓存服务也不能修复漏报输入、非确定性任务等客户端构建定义问题。[Gradle build cache](https://docs.gradle.org/current/userguide/build_cache.html)
- BuildKit registry cache 是可用首选路径；Docker 当前文档把 S3/azblob backend 标注为 unreleased，而 BuildKit 主仓库将其标为 experimental。两者不是矛盾的稳定性保证：Docker/Buildx 发行渠道、driver 与 standalone BuildKit 必须分别固定版本测试，不能笼统宣称 Docker 的 S3 cache 已全面可用。[Docker backends](https://docs.docker.com/build/cache/backends/)、[BuildKit README](https://github.com/moby/buildkit)
- GitHub Actions 平台里使用 expbuild 的 Gradle/Turbo/Bazel cache 是普通 CI 集成；兼容 GitHub Actions cache 服务是另一项高维护协议工作。BuildKit 的 gha exporter 有显式 `url_v2/token` 参数，也不能推出 stock actions/cache 的替换配置相同。[Docker gha backend](https://docs.docker.com/build/cache/backends/gha/)
- 不应把 Nx 当前自托管服务器归为必须购买 Powerpack：官方 2025-03 公告已宣布开放规范免费路线，2025-12 更新说明 Powerpack 不再作为独立产品，现有自托管规范可用；Nx Cloud/Enterprise 的功能授权仍分别判断。[Nx 官方公告](https://nx.dev/blog/custom-runners-and-self-hosted-caching)、[Powerpack 更新](https://nx.dev/blog/introducing-nx-powerpack)

## 版本与兼容性登记

所有行当前状态都是“协议路线已核实 / expbuild 互通待 PoC”。不能把网页的 current/latest 直接写进产品兼容承诺。

| 生态 | 本次看到的版本信息 | 发布前冻结与验证方式 |
|---|---|---|
| Bazel | 使用 8.2.0 版本化 HTTP 文档；REAPI main 含较新可选 chunking 能力 | 固定至少两代正式 Bazel 客户端、remote-apis commit、宣告的 REAPI min/max 版本；逐项 capabilities 和边界测试 |
| Gradle | current 文档页面显示 9.8.0；API 搜索页面还可见 9.7.1，说明抓取/页面版本可能不一致 | 用可下载正式 wrapper 的精确版本与分发 SHA；选择种子客户主流版本 + 最新确认稳定版本；JDK/OS 组合登记 |
| sccache | main 官方 WebDAV/S3 文档明确路线，但本次未锁 release tag | 固定 tag/commit、编译 features、编译器与 Rust 版本；核对该 tag 是否具有配置项，不从 main 推断所有历史版本 |
| ccache | 官方说明 4.14.1 发布于 2026-09-27，4.14 于 2026-08-23；helper 4.13+ | 优先 4.13/4.14 helper；有存量客户再验证 4.12 旧 HTTP；helper 单独固定发布版本及 TLS/Bearer/layout 测试 |
| Turborepo | 已核实 remote-cache 与 HMAC 文档；部分 API 页面抓取失败，搜索可见版本化 2.8.7 文档 | 冻结目标 CLI tag 的 API 调用及正式 OpenAPI；核验事件/查询/状态路由、headers、签名和 team 参数，不以搜索摘要作为完整实现依据 |
| Nx | 自托管页标为 v23，更新时间 2026-09-25；OpenAPI info.version 1.0.0 | 确认正式 npm release/tag 日期，再跑目标旧版和新版；CLI 版本与缓存 archive 格式版本分开登记 |
| BuildKit | 官方文档指出 image-manifest 从 BuildKit 0.21 起默认启用 | 固定 BuildKit、Buildx、Docker Engine、driver、registry 实现和 feature 开关；测试 min/max、index/manifest、gzip/zstd |
| Maven | 官方入门示例 extension 1.3.0，要求 Maven 3.9.0+，包含 Maven 4 | 固定 Maven/extension/Resolver/JDK 和插件版本；HTTP 与 WebDAV transport 分组；真实项目 clean build 输出一致性验证 |
| Nix | 本次采用 2.35 系列 reference manual 页面 | 固定正式 Nix release 和签名/压缩设置；验证不同 OS、CPU、store-dir 及闭包引用；读和发布分别标兼容等级 |
| GitHub Actions | 官方 README 有 v5 Node24/runner≥2.327.1 信息，并已有 v6 段落；这不应被当作最新发布标签证明 | 冻结 action SHA、toolkit SHA、runner 版本、github.com/GHES 环境与缓存 service version；协议录制+回归套件随上游版本更新 |

统一兼容档案至少包含：`client_version`、`client_binary_digest`、`spec_commit`、`server_version`、OS/CPU/runtime、关键 flag、认证方式、压缩方式、fixture、测试时间、结果链接、已知限制。产品 UI 应显示“已认证/实验性/待验证/已弃用”，而不是一个无范围的支持勾选。

## P0/P1 协议 PoC 验收建议

以下是实施验收项，尚未执行：

1. 真实客户端冷构建写入，另一台干净机器热构建读取，输出与无缓存构建一致；覆盖源文件、编译器/JDK、环境参数、依赖变更造成合理 miss。
2. read-only credential 写入确实失败；租户/项目/协议同 key 不可越权读；不可信 PR 不能污染可信域；撤销凭证后客户端的有效行为符合约定。
3. 小文件、零长度 blob、大文件、并发重复写、断流重试、重复 commit、磁盘满、对象存储故障、数据库失败和 GC 并发；返回协议期待的错误而非统一 JSON 500。
4. Bazel 专门覆盖 directory/tree、stdout/stderr、missing CAS、ByteStream offset/resume、batch mixed results、uncompressed 与 zstd digest、AC 引用下载窗口。
5. Gradle 覆盖 404、413、Expect-Continue 与重定向；sccache 覆盖 webdav features、实际 HTTP method/path、Basic/Bearer、不同工具链 key 与压缩内容；不能只用 curl 测成功。
6. P1 Turbo 覆盖签名开启/关闭/签名错误、headers、team scope 与事件；Nx 覆盖并发首次写和 409、真实 archive 格式；ccache 覆盖 helper 与旧版 HTTP 两路。
7. 性能先建立客户 workload 基线：entry hit rate、byte hit rate、P50/P95/P99 lookup、上传/下载吞吐、冷→热构建墙钟时间、CPU/磁盘/内存/带宽成本；不预设统一“10倍加速”目标。

## 商业与许可边界

这部分是产品工程边界，不是法律意见。实现公开接口、分发开源客户端、嵌入第三方服务器和转售某厂商托管服务是不同决策；每个依赖都以锁定版本的 LICENSE/NOTICE、商标和商业条款登记。

- Nx 自托管开放规范与 Nx Cloud/Enterprise 不是同一产品授权；不要复制闭源 SDK/控制面并据开放 API 推断可分发。现有官方 API 路线足够覆盖 expbuild 的基础远端缓存。
- Gradle 原生 HTTP client 可对接自有实现；采用 Gradle 提供的 cache-node 镜像或 Develocity 集成时另外检查其产品条款，不能把 Gradle 开源客户端许可视为全部服务端产品许可。[Gradle 官方说明](https://docs.gradle.org/current/userguide/build_cache.html)
- Turborepo / Nx 仓库有各自的开源许可文件，但其托管服务另有条款。优先实现公开协议并使用独立 expbuild 品牌。[Turbo LICENSE](https://github.com/vercel/turborepo/blob/main/LICENSE)、[Nx LICENSE](https://github.com/nrwl/nx/blob/master/LICENSE)
- ccache 整体采用 GPL-3.0-or-later；如果 expbuild 安装包捆绑或修改客户端/helper，需要逐项目、逐版本审查分发义务，不能只因为通过 HTTP 互通就把服务器和客户端一律看作同许可。[ccache license](https://ccache.dev/license.html)
- GitHub actions/cache 客户端开放并不构成 GitHub 对第三方完整服务端协议长期稳定性的保证；expbuild 自有 Action/CLI 的维护责任更清晰。若后续决定透明兼容，必须接受上游升级回归成本，不从公开 SDK 推导官方认证。
