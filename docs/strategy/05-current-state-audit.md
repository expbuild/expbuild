# expbuild 与 expbuild-admin 现状审计

审计日期：2026-09-28。仓库：`/home/ubuntu/work/expbuild/expbuild`。提交：`a0458e723818f943107c96cbc7a0895237bd06ca`，提交时间 2025-12-05。工作区在审计开始时干净。

管理端仓库：`/home/ubuntu/work/expbuild/expbuild-admin`；提交：`853a48c521100b89e287f2e98f2f1931f67be495`。下方先记录数据面 15 项发现，再记录管理端。全文的规划建议以总览和最终路线图的阶段范围为准。

方法：直接读取生产实现、配置、接口和测试；未以 README 的功能声明为实现证据；未编译、未运行测试、未进行性能或漏洞利用测试，因此下述是静态代码审计结论，不代表已通过实际客户端兼容性测试。没有修改产品代码。

总体判断：当前是具备真实 CAS/AC 数据读写和远程 worker 路径的 Rust REAPI 原型，适合保留组件后重构；不是多协议缓存平台，也不能把现有配置项或管理概念视作生产能力。最先要完成的是正确性与信任边界，随后建立协议无关缓存内核、租户/策略上下文、流式存储和控制平面。

## 15 项关键结论

### 1. 已有可复用的 REAPI、CAS、AC、worker 分层，但产品协议范围仍单一

- 已实现：Tokio/tonic gRPC 服务、CAS/AC manager、文件系统 CAS 和 AC、RE 客户端、CLI、Host/Docker executor。
- 证据：[crates/server-bin/src/main.rs:67](/home/ubuntu/work/expbuild/expbuild/crates/server-bin/src/main.rs:67) 注册的服务只有 Capabilities、CAS、AC、ByteStream、Execution 和自定义 WorkerScheduler；[crates/server/src/cas/manager.rs:20](/home/ubuntu/work/expbuild/expbuild/crates/server/src/cas/manager.rs:20) 对普通 CAS 读取做 SHA256/大小校验，`:32` 对普通 CAS 写入校验。
- 缺失：HTTP build cache、Gradle、Bazel HTTP、Turborepo、OCI/BuildKit registry、S3 兼容缓存等服务适配器；当前不能称为“多协议”。
- 规划：保留传输实现、摘要工具、客户端和测试资产，把协议适配器与存储/策略/索引的核心接口分开。

### 2. 基础 CAS API 已实现，REAPI 细节与资源控制不完整

- 已实现：FindMissingBlobs、BatchReadBlobs、BatchUpdateBlobs、GetTree。
- 部分实现：[crates/server/src/grpc/cas_service.rs:49](/home/ubuntu/work/expbuild/expbuild/crates/server/src/grpc/cas_service.rs:49) 批量写逐条串行且没有按声明的 batch 总大小控制；缺失 digest 会令整个 RPC 提前失败。`:140` 的 GetTree 一次收集完整树后发送，忽略 page_size/page_token，没有树大小上限。
- `:175` 的 SplitBlob、`:182` 的 SpliceBlob 明确 Unimplemented；Capabilities 正确声明这两项为 false，因此它们不是必须立即补齐的协议违约。
- 规划：先明确支持的 REAPI 版本和功能子集；错误码、请求大小、压缩、分页/流式、空 blob、坏输入等进入一致性测试门槛。

### 3. Capabilities 宣告与实际实现不一致，会破坏真实客户端兼容性

- [crates/server/src/config/mod.rs:145](/home/ubuntu/work/expbuild/expbuild/crates/server/src/config/mod.rs:145) 默认宣告 ZSTD/DEFLATE；[crates/server/src/grpc/capabilities_service.rs:61](/home/ubuntu/work/expbuild/expbuild/crates/server/src/grpc/capabilities_service.rs:61) 同时宣告 ByteStream 和 BatchUpdate 压缩。
- 但 [crates/server/src/grpc/cas_service.rs:64](/home/ubuntu/work/expbuild/expbuild/crates/server/src/grpc/cas_service.rs:64) 直接对传入原始 data 做 SHA256，未按 compressor 解压；ByteStream `:34` 只识别 blobs 路径，不识别 compressed-blobs。
- Capabilities `:25` 可宣告 SHA1/MD5/SHA384/SHA512，但实际 [crates/server/src/util/digest.rs:5](/home/ubuntu/work/expbuild/expbuild/crates/server/src/util/digest.rs:5) 固定 SHA256。
- `action_cache_update_enabled` / `exec_enabled` 仅影响宣告；服务始终注册，服务实现不读取这些开关。
- 规划：能力由实际实现推导，禁止“配置即可宣告支持”；真实 Bazel/Buck2 等客户端互操作测试优先于继续增加 proto。

### 4. ByteStream 写入既不是真流式持久化，也不支持可靠续传

- [crates/server/src/grpc/bytestream_service.rs:128](/home/ubuntu/work/expbuild/expbuild/crates/server/src/grpc/bytestream_service.rs:128) 整个上传累积到 Vec，直到 finish_write 才校验大小/哈希；忽略 write_offset、后续资源名变化，缺少累计上传硬上限。
- `:23` 定义 write_states，`:185` 查询它，但生产代码从不插入或更新，因此 QueryWriteStatus 无法报告上传进度/完成态。
- `:78` 将负 read_offset 直接转 u64；读取直接调用 blob_store，绕过 CasManager 的校验。下载虽分块，单流 channel 可积压约 100 个 1 MiB chunk。
- 规划：实现 UploadSession、持久化提交点、顺序/偏移验证、流式摘要、临时对象 commit/abort、背压、租户额度和会话清理。

### 5. 没有租户隔离和服务端身份边界；instance_name 只是被客户端发送

- [crates/server/src/config/mod.rs:21](/home/ubuntu/work/expbuild/expbuild/crates/server/src/config/mod.rs:21) 有 instance_name，但服务端实际请求路径不验证/使用它；CAS、AC、执行请求都只提取 digest 或名称。
- [crates/server/src/storage/traits.rs:11](/home/ubuntu/work/expbuild/expbuild/crates/server/src/storage/traits.rs:11) 与 `:42` 接口没有租户、namespace、主体、策略上下文，键仅为 REAPI Digest。
- [crates/server-bin/src/main.rs:77](/home/ubuntu/work/expbuild/expbuild/crates/server-bin/src/main.rs:77) 直接启动全部 gRPC 服务，未配置认证 interceptor、TLS、权限检查或独立 worker 身份边界。客户端 TLS 支持不能等同服务端已有安全能力。
- [crates/worker/src/agent.rs:52](/home/ubuntu/work/expbuild/expbuild/crates/worker/src/agent.rs:52) 还把 CAS 客户端固定为 instance_name 空字符串、tls=false、无 headers。
- 规划：在协议入口做 principal → organization/project/namespace → read/write/admin policy；不同协议的 key 映射必须带 namespace；worker 通道独立认证。是否跨租户做底层去重应独立于可见性和访问控制。

### 6. 输入路径和摘要未在信任边界严格校验

- [crates/server/src/storage/filesystem.rs:23](/home/ubuntu/work/expbuild/expbuild/crates/server/src/storage/filesystem.rs:23)、[crates/server/src/storage/filesystem_action_cache.rs:23](/home/ubuntu/work/expbuild/expbuild/crates/server/src/storage/filesystem_action_cache.rs:23) 直接拿外部 hash 做路径和字符串字节切片；没有限制长度、hex 字符、非负大小，存在路径逃逸/Unicode 切片 panic 的结构性风险。
- AC Update 不会像 CAS 数据写入那样证明 hash 等于内容摘要，因此不能依靠普通 CAS 的 verify_digest 覆盖这个边界。
- [crates/client/src/client/main_client.rs:552](/home/ubuntu/work/expbuild/expbuild/crates/client/src/client/main_client.rs:552) 和 `:568` 将远端 Directory 节点名直接 join 并写磁盘；worker 使用这段代码，在容器启动前就 materialize 到宿主目录。
- [crates/worker/src/agent.rs:424](/home/ubuntu/work/expbuild/expbuild/crates/worker/src/agent.rs:424)、[crates/worker/src/executor/host.rs:134](/home/ubuntu/work/expbuild/expbuild/crates/worker/src/executor/host.rs:134) 同样直接拼接 output_path/working_directory。
- 规划：ValidatedDigest、ValidatedRelativePath 成为核心类型；拒绝绝对路径、..、非法节点名、符号链接逃逸；目录 materialization 必须有根目录约束和树大小/深度预算。本审计没有实施漏洞利用。

### 7. AC 是简单可变映射，尚无引用完整性、写入信任和缓存正确性策略

- [crates/server/src/grpc/action_cache_service.rs:34](/home/ubuntu/work/expbuild/expbuild/crates/server/src/grpc/action_cache_service.rs:34) 直接返回存储的 ActionResult；`:67` 直接接受调用者的结果。manager 本身不拥有 CAS，因此不能验证引用 blob 是否存在。
- 未处理 inline_stdout/inline_stderr/inline_output_files 请求，未验证产物引用存活，也未区分可信 CI 写入与开发者只读权限。
- [crates/server/src/execution/manager.rs:164](/home/ubuntu/work/expbuild/expbuild/crates/server/src/execution/manager.rs:164) 完成时无条件写 AC；没有读取 Action.do_not_cache，也没有区分退出码失败的缓存策略。
- 规划：把 mutable action/key index 与 immutable blob 分离；写入权限、引用/可见性检查、结果可复现策略、租约/保留引用和陈旧 AC 清理必须联合设计，避免 GC 后出现“命中但产物缺失”。

### 8. 只有 filesystem 后端完成，持久化并发安全和扩容能力仍不足

- [crates/server/src/storage/mod.rs:20](/home/ubuntu/work/expbuild/expbuild/crates/server/src/storage/mod.rs:20)、`:23`、`:36`、`:39` 对 Redis、Tiered、Redis AC、Memory AC 均直接 bail，虽然配置可反序列化这些选项。
- [crates/server/src/storage/filesystem.rs:84](/home/ubuntu/work/expbuild/expbuild/crates/server/src/storage/filesystem.rs:84) CAS 临时文件名固定；AC `filesystem_action_cache.rs:69` 亦相同，并发写同 digest/动作会争用临时文件。
- BlobStore 有流读/写接口，但普通接口依然 Vec；流写只验长度不验哈希；主 ByteStream 写入没有使用流写。普通写未 fsync，存储损坏与缺失错误主要用字符串处理。
- 规划：filesystem 作为开发和节点 L1，生产增加 S3 兼容对象存储；元数据/索引与 blobs 分离，commit 条件、幂等写、唯一临时对象、损坏探测、校验与恢复需先定义。不要把 Redis 大对象缓存视作唯一扩容路径。

### 9. 生命周期、运营管理和服务可观测性没有形成闭环

- [crates/server/src/config/mod.rs:153](/home/ubuntu/work/expbuild/expbuild/crates/server/src/config/mod.rs:153) 定义 GcConfig，但服务启动与管理器代码没有使用 config.gc；没有 GC 扫描/标记/清扫、容量水位、TTL 执行、租户配额。
- AC touch 会更新时间，CAS touch 接口存在，但没有生命周期控制器；worker [crates/worker/src/agent.rs:514](/home/ubuntu/work/expbuild/expbuild/crates/worker/src/agent.rs:514) 的工作目录清理被注释。
- [crates/server-bin/src/main.rs:93](/home/ubuntu/work/expbuild/expbuild/crates/server-bin/src/main.rs:93) 是 tracing 日志初始化；未发现服务端 Prometheus/OTel 指标导出、健康/readiness 服务、审计事件、管理 API、租户 CRUD、配置版本或数据库 migrations。
- 规划：指标至少包括协议/租户命中率、字节命中、p95/p99 延迟、传输字节、写入拒绝、GC 回收与安全跳过、后端错误和节省的构建时间；admin 需要真实控制 API 和审计记录，不能仅从日志拼页面。

### 10. scheduler 是内存原型，租约不能提供故障恢复

- [crates/server/src/execution/scheduler.rs:14](/home/ubuntu/work/expbuild/expbuild/crates/server/src/execution/scheduler.rs:14) 队列、worker、lease、结果均为进程内集合；重启丢失状态，不能多副本一致调度。
- `:349` lease 过期仅删除，日志明确写 “would requeue in production”；没有重新入队或生成失败结果；heartbeat 只刷新 worker，不续 task lease。
- `:89` 是 FIFO，priority 字段不用于排队；没有按项目公平调度、幂等去重、持久化恢复。worker max_concurrent_executions 未在服务端租赁路径实施。
- 规划：若先做缓存平台，Execution 作为独立实验模块保留；生产远程执行需要持久化状态机、租约续期/fencing、attempt id、重试/超时/取消、公平队列和 worker 身份完整设计。

### 11. execution 语义存在会浪费构建与挂起请求的错误

- [crates/server/src/execution/manager.rs:110](/home/ubuntu/work/expbuild/expbuild/crates/server/src/execution/manager.rs:110) 命中 AC 后将 operation 标 done，但 `:188` 返回后仍无条件构建 task 并 `:204` submit；命中后还会重复执行。
- `:83` ExecuteResponse.cached_result 永远 false。
- `:198` platform 固定 None、timeout 固定 3600 秒、priority 固定 0，未从 Action/ExecuteRequest 提取真实约束。
- `:217` worker Failed 仅记录错误并退出监视循环，不把 operation 置完成错误；lease 丢失同样无法完成。`grpc/execution_service.rs:54` 每秒轮询，发送失败未退出；operations 没有回收。
- 规划：先把 Operation 转为明确终态的持久化状态机；每条成功/失败/取消/失联路径都必须有限时终止。命中结果不得入执行队列。

### 12. worker 隔离有接口和 Docker 基础，但不能支撑不受信任多租户执行

- 已实现 [crates/worker/src/executor/mod.rs:19](/home/ubuntu/work/expbuild/expbuild/crates/worker/src/executor/mod.rs:19) TaskExecutor；Docker `executor/docker.rs:172` 配置 CPU、memory、pids、readonly rootfs、network_mode、non-privileged，有实际代码，不只是设计文档。
- Host [crates/worker/src/executor/host.rs:148](/home/ubuntu/work/expbuild/expbuild/crates/worker/src/executor/host.rs:148) 用宿主 Command，未 env_clear；所谓 whitelist `:77` 在过滤为空时反而复制所有请求环境变量；超时用 timeout(cmd.output())，没有 kill_on_drop/进程组回收。
- Docker `:135` 合并 NetworkPolicy，但实际 `:177` 只用全局 network_mode；working_directory `:170` 固定 /workspace。disk limit 未实现（capabilities 正确声明 false）。
- Docker `:187` auto_remove=true，但 `:386` 之后在等待退出后再读取日志和产物，存在容器自动删除导致日志/产物丢失的竞态风险，未做动态验证。
- 规划：默认禁止公有/不可信 Host executor；先明确租户信任模型，后选择容器/微 VM 与资源和网络策略；需要真实 Docker 异常路径测试。

### 13. 输出与目录树协议存在具体兼容性缺口

- [crates/worker/src/agent.rs:553](/home/ubuntu/work/expbuild/expbuild/crates/worker/src/agent.rs:553) 遇空 contents 直接 continue，零字节输出文件会丢失。
- `:581` 只收集旧 output_directories 字段，现代 output_paths 中的目录不会被同样收集；Host 只返回 is_file 产物。
- `:587` upload_directory_tree_from_path 实际返回 Directory 摘要（`crates/client/src/client/main_client.rs:507`），却在 `agent.rs:595` 同时填入 tree_digest 与 root_directory_digest；REAPI 的 Tree 对象与 Directory 对象不是同一编码。
- `crates/client/src/client/main_client.rs:529` 下载目录树不处理 symlinks；`crates/client/src/action/directory.rs:107` 构造时 symlinks 为空。执行元数据的开始/结束时间都在执行结束后生成（agent.rs:463）。
- 规划：真实第三方客户端应测零字节文件、嵌套输出目录、可执行位、符号链接、working directory、Tree 和 Directory 语义、错误产物与计时。

### 14. 扩展边界值得保留，但目前接口把核心绑在 REAPI 类型上

- [crates/server/src/storage/traits.rs:2](/home/ubuntu/work/expbuild/expbuild/crates/server/src/storage/traits.rs:2) 直接依赖 REAPI Digest/ActionResult；BlobStore 和 ActionCacheStore 分离是好起点，但不是平台级 Key/Blob/Manifest/Policy 模型。
- `TaskExecutor` 提供执行后端扩展；存储工厂是封闭 enum match；没有协议注册、扩展能力协商、插件版本/权限/隔离、扩展配置模式或 hooks。
- 规划：近期采用编译期 Rust trait 与独立 adapter crate，稳定内部 API 后再提供进程外 gRPC 插件；不建议一开始用动态加载 Rust ABI 承诺开放生态。BlobStore 应支持流式 put/get、range、stat、commit/abort，另设 namespace-aware CacheIndex/ManifestStore；REAPI ActionResult 可保留为协议专用 payload。

### 15. 有真实集成测试骨架，但覆盖无法证明生产正确性

- [tests/Cargo.toml:10](/home/ubuntu/work/expbuild/expbuild/tests/Cargo.toml:10)、`:15` 真实注册 2 个集成测试 target；harness 会启动本地 gRPC server 和 Host worker，不是全部 mock。
- 共 4 个 CAS 集成案例和 3 个 execution 案例；覆盖基本小/大 blob、目录与 echo/文件输出/退出 42。
- [tests/integration/test_cas_operations.rs:116](/home/ubuntu/work/expbuild/expbuild/tests/integration/test_cas_operations.rs:116) 名为 test_find_missing_blobs，实际 `:138` 与 `:141` 仅调用 download_blob，从未调用 FindMissingBlobs RPC。
- 未发现真实 Bazel/Gradle 等客户端互操作、ByteStream resume、跨 namespace 隔离、GC 引用一致性、并发同键、损坏数据、租约丢失、重启恢复、Docker 执行、认证或 quota 的覆盖。worker tests 主要是 Host echo/health/capabilities 和枚举默认值。
- 规划：建立协议 conformance suite + 原生客户端 smoke tests + 数据完整性/安全负面用例 + 断网/重启/后端故障测试；本审计未运行现有测试，不能称它们已通过。

## 对重新规划的直接建议

1. 第一阶段明确“可信、可运营的多协议缓存”为主线；远程执行另设里程碑，避免把安全隔离与调度系统的复杂度挤入缓存 MVP。
2. 最小平台内核：RequestContext(principal/tenant/namespace/protocol)、ValidatedDigest、不可变 BlobStore、可变 CacheIndex、对象引用/保留策略、UploadSession、Quota/Policy、Metrics/Audit。
3. 第一批只选择 2–3 个实测价值高的协议：REAPI cache（先修正确性）、Bazel HTTP/Gradle（需各自 key 与鉴权约定）、Turborepo 可作为第二批；OCI/BuildKit 应以独立 registry adapter/集成方式处理，不能仅映射 blob 即宣告支持。
4. 管理平面负责组织/项目、凭据与 RBAC、配额保留策略、命中与容量分析、协议实例、后端配置、审计与运营任务；数据平面高频读写不要被管理数据库同步写路径拖住。
5. 保留客户端传输、proto、trait 分层、file backend、Docker 基础和集成 harness；重构 tenant-aware 核心、协议能力宣告、流写、生命周期和调度状态机，不应在现有字段上继续堆开关。

## expbuild-admin 的真实完成度

### A1. 前后端基础已存在，但没有真正的组织级多租户模型

React 页面、Express API、JWT 登录、项目 CRUD、流水线上报和 Prisma 数据库不是纯静态 mock，值得保留。当前模型是 User 拥有多个 Project，而不是组织、成员、团队、项目与服务账号。Project 上直接保存一个明文 apiKey；没有独立 token 生命周期、scope 或多个 CI 身份。见 [schema.prisma](/home/ubuntu/work/expbuild/expbuild-admin/server/prisma/schema.prisma:13) 和 [项目创建](/home/ubuntu/work/expbuild/expbuild-admin/server/src/routes/projects.ts:34)。

设计文档说生产使用 PostgreSQL，但实际 schema 的 provider 是 sqlite；没有证据表明生产 PostgreSQL 迁移已完成。需要新数据模型与迁移方案，不能把 README 的目标架构当已经运行的能力。

### A2. 项目过滤存在覆盖授权范围的路径

流水线列表先把 where.projectId 限制为当前用户项目集合，但传入 projectId 后直接覆盖这一条件，没有验证指定项目仍属于授权集合。因此能造成跨项目列表暴露的结构性风险；这是静态代码发现，未进行动态利用。见 [pipeline.ts](/home/ubuntu/work/expbuild/expbuild-admin/server/src/routes/pipeline.ts:16) 与 [覆盖条件](/home/ubuntu/work/expbuild/expbuild-admin/server/src/routes/pipeline.ts:24)。

新的查询层应强制 scope 与用户过滤取交集，详情、列表、搜索、导出全部一致；不能依赖每个路由开发者记住手动加 ownerId。

### A3. CacheMetric 没有项目归属，统计不能按租户可靠隔离

上报接口会验证 apiKey 对应的 Project，但写入 CacheMetric 时不保存 projectId；GET /cache 只按时间查询，dashboard 也聚合全库最近指标。这意味着即使登录保护存在，不同用户仍可能看到同一组缓存统计。见 [模型](/home/ubuntu/work/expbuild/expbuild-admin/server/prisma/schema.prisma:67)、[指标写入](/home/ubuntu/work/expbuild/expbuild-admin/server/src/routes/metrics.ts:54)、[全局聚合](/home/ubuntu/work/expbuild/expbuild-admin/server/src/routes/metrics.ts:108)。

savingsSeconds 由上报者直接提供，无法证实它是 CPU 节省、墙钟差还是手工估计；不能拿现有 dashboard 作为实际加速效果的证据。需要事件来源、定义、基线、聚合与可信度字段。

### A4. Agent 心跳没有认证，节点列表也没有租户范围

POST /heartbeat 未使用 authenticate，也没有 API key 验证；按 hostname upsert 可修改已有节点状态。GET 虽要求登录，但查询所有 BuildAgent。模型没有 tenant/project/pool 外键。见 [节点列表](/home/ubuntu/work/expbuild/expbuild-admin/server/src/routes/agents.ts:9)、[心跳](/home/ubuntu/work/expbuild/expbuild-admin/server/src/routes/agents.ts:35)。

应改为经过注册的机器身份与实例 ID，hostname 只作显示字段；节点归属、心跳权限、失联状态和排空命令进入同一管理闭环。现有 Rust worker 没有与这套 API 自动联动的实现证据。

### A5. UI 有真实 API，但仍混入演示值和错误掩盖

dataService 为 agent 生成 10.0.x.x 假 IP，CPU/内存固定 0，把距离上次心跳的时间当 uptime；pipeline buildNumber、initiator、Jenkins URL 也由前端填占位值。metrics/pipelines 请求失败直接返回 MOCK 数据。见 [agent 映射](/home/ubuntu/work/expbuild/expbuild-admin/services/dataService.ts:36)、[指标回退](/home/ubuntu/work/expbuild/expbuild-admin/services/dataService.ts:56)、[流水线映射](/home/ubuntu/work/expbuild/expbuild-admin/services/dataService.ts:75)。

可复用页面、图表、布局和类型组织，但数据模型及失败状态要重做。生产不能把“未知资源利用”显示为“0%”，也不能把服务故障显示成健康演示数据。

### A6. 配额只是构建上报次数检查，无法约束缓存资源

pipeline report 先读取 usedBuilds 与 monthlyQuotaBuilds，再创建记录，再递增；不是同事务的原子额度预留，重试也没有幂等键。schema 中虽名为 monthly，但当前路由没有月度账期和重置模型。见 [quota 检查](/home/ubuntu/work/expbuild/expbuild-admin/server/src/routes/pipeline.ts:112) 和 [分离递增](/home/ubuntu/work/expbuild/expbuild-admin/server/src/routes/pipeline.ts:136)。

这最多是原型层的上报次数限制，不是存储/带宽/对象数/并发/执行资源配额。需要由数据面强制执行的资源准入和可对账账本，不能仅增加管理端 quota 字段。

### A7. 认证与平台运维尚未达到企业闭环

JWT_SECRET 未配置时使用固定开发默认值，生产应拒绝这种配置。当前没有独立角色授权中间件、团队成员模型、token scope/rotation/revocation、SSO、审计与配置版本的完整实现证据。见 [认证工具](/home/ubuntu/work/expbuild/expbuild-admin/server/src/utils/auth.ts:5) 和 [认证中间件](/home/ubuntu/work/expbuild/expbuild-admin/server/src/middleware/auth.ts:16)。

管理页面有“登录”和“SaaS”并不意味着具有企业 IAM 或 SaaS 隔离能力。控制面与数据面的认证、策略和事件目前应按待建立的新契约规划。

## 复用与重构决策

| 资产 | 建议 | 理由 |
|---|---|---|
| Rust/Tokio/tonic、proto、客户端 IO | 选择性复用 | 技术方向匹配，但接口语义和能力宣告要校准 |
| 文件存储与现有 traits | 改造 | 保留基本 IO，增加 scope、流式提交、完整性和后端能力 |
| REAPI 服务 | 按真实规范与测试逐项修复 | 不能把现有服务注册当兼容认证 |
| 内存 scheduler/worker | 暂作实验，独立后续重构/集成 | 持久状态、失败恢复、隔离与结果格式缺口大 |
| React 页面/布局/图表 | 复用视觉与组件基础 | 产品信息架构、真实数据、错误状态需调整 |
| Express/Prisma 框架 | 可保留 | 无必要为语言统一立即重写；领域模型与授权层需重新建立 |
| 当前数据库模型和 API key 设计 | 重构并迁移 | 没有组织/namespace/服务账号/可靠用量与隔离字段 |
| 既有文档与测试 | 保留作历史依据，更新声明并扩充有效案例 | 避免历史目标被误读为现有能力 |

本轮不改变产品代码，也不表示上述问题已经修复。下一步实施应把正确性和权限问题放在增加协议之前。

另有发布元数据需要整理：expbuild 根 LICENSE 实际为 MIT，而 README 描述 MIT/Apache 双许可并链接当前缺失的 LICENSE-MIT/LICENSE-APACHE；本次未在 expbuild-admin 的已跟踪项目文件中找到独立 LICENSE。商业化前应由维护者确认意图、权利来源和分发许可，不能直接沿用 README 的双许可表述。此处只记录文件不一致，不推断未授权代码的使用许可。[当前 LICENSE](/home/ubuntu/work/expbuild/expbuild/LICENSE:1)。
