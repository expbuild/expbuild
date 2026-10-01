# Depot 公开代码架构证据

研究日期：2026-09-28。本文只对下列不可变提交中的代码负责；公开客户端、BYOC 代理与当前托管生产环境不是同一个可见范围。**代码中存在一条路径，不等于所有 Depot 产品都使用它。**

## 1. 代码基线

| 官方仓库 | 本次检查提交 | 提交时间（仓库记录） | 研究用途 |
|---|---|---|---|
| [depot/cli](https://github.com/depot/cli/tree/788a3d5373bc5f4bc19f40f8d6148899b763706c) | `788a3d5373bc5f4bc19f40f8d6148899b763706c` | 2026-09-23 | 构建控制协议、BuildKit 连接、缓存协议、旧 Go 缓存客户端 |
| [depot/cloud-agent](https://github.com/depot/cloud-agent/tree/727d4b99a6678d48e190d08724715adf013aa731) | `727d4b99a6678d48e190d08724715adf013aa731` | 2026-05-24 | 云资源协调、持久卷、Ceph 管理路径 |
| [depot/machine-agent](https://github.com/depot/machine-agent/tree/f6183c52bb8992d408ad0b246fa87f24a597ed60) | `f6183c52bb8992d408ad0b246fa87f24a597ed60` | 2026-09-25 | 机器身份注册、BuildKit 配置、挂载和清理 |
| [depot/setup-action](https://github.com/depot/setup-action/tree/91bc8495a33ebfc504ffc89e5674379ccf23c29c) | `91bc8495a33ebfc504ffc89e5674379ccf23c29c` | 2026-08-20 | GitHub Actions OIDC 交换与 CLI 安装 |

检查方式：浅克隆官方公开仓库，静态阅读源文件和 protobuf；未持有 Depot 账户凭据，未调用其收费构建服务，未进行运行时抓包或压测。

## 2. 已被代码直接支持的事实

### 2.1 构建控制通道与执行通道分离

CLI 默认把管理和构建控制 RPC 发往 `https://api.depot.dev`，通过 Connect 生成客户端调用。`CreateBuild` 返回 `build_id`、`build_token`、构建 URL、Registry 配置等；随后按 amd64 / arm64 请求 `GetBuildKitConnection`。连接可能处于 pending 状态并给出重试等待时间，或返回 endpoint、server name、客户端证书、CA 与 identity/gzip 压缩选择。[客户端入口](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/api/rpc.go#L22)，[构建协议](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/proto/depot/cli/v1/build.proto#L81)，[连接协议](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/proto/depot/cli/v1/build.proto#L149)。

拿到连接信息后，CLI 使用 BuildKit 客户端建立 TLS 连接，配置返回的 CA、服务名与客户端证书；另有直接 TLS 连接实现。构建健康消息每约 5 秒向控制 API 上报，服务端可返回取消时间。因此可以确定：构建控制 API 不需要承载所有 BuildKit 构建流量，CLI 拥有连接执行 endpoint 的独立路径；endpoint 后面是否存在四层代理不能由客户端判断。[连接、健康循环与 BuildKit Client](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/machine/machine.go#L45)，[TLS 连接](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/connection/machine.go#L18)。

### 2.2 缓存存在独立服务协议，具备批量存在性查询和 bundle 元数据

CLI 默认缓存 endpoint 是 `https://cache.depot.dev`，允许 `DEPOT_CACHE_HOST` 覆盖。公开 protobuf 中的 `CacheService` 包含：

| 方法 / 字段 | 可确认含义 | 不能据此推出 |
|---|---|---|
| `CreateEntry(entry_type, key, scope?)` | 按条目类型和键建立上传；返回 entry ID 和上传分片 URL | 所有协议共享同一数据库表或全局去重域 |
| `FetchMorePresignedURLs(entry_id, next_part, count)` | 支持后续按批取得更多上传分片 URL | 分片大小、实际上传并发和各协议是否使用该路径 |
| `FinalizeEntry(size_bytes, upload_part_etags, children, segments)` | 上传与条目最终发布分两阶段；支持子条目与分段信息 | 发布事务、引用一致性和垃圾回收算法 |
| `CheckEntries(entry_type, repeated keys)` | **批量询问键是否存在**，结果逐键返回 `found` | 内部使用 SQL、KV、Bloom Filter、S3 HEAD 或具体延迟 |
| `GetBundle(entry_type, subkey)` | 通过子键取得 bundle URL、bundle key、总大小、segments | 服务端缓存布局、预取策略和 bundle 目标尺寸 |
| `Segment(subkey, offset, size)` | 对单个 bundle 内子条目建立位置索引 | 必然跨租户打包或服务端全局压实 |
| `GetDownloadURLByPrefix(key_prefixes, scope)` | 前缀回退和可选隔离 scope；注释以 GHA restore keys 为例 | 任意客户端拥有跨 scope 访问权限 |

上述全部来自 [cache.proto](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/proto/depot/cache/v1/cache.proto#L7)。其中 `fail_if_upload_in_progress` 注释表明通用接口可选择禁止并发上传，否则允许并发、采用 last-write-wins；**不能把这个通用接口注释推广为所有 CAS/Action Cache 协议的覆盖规则**。[CreateEntry 定义](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/proto/depot/cache/v1/cache.proto#L19)。

CLI 的 `UploadCacheEntry` 确实执行 `CreateEntry → PUT 到预签名 URL → 读取 ETag → FinalizeEntry`。代码注释明确称其为 S3 URL；`AlreadyExists` 时跳过上传。这给出了“元数据 API + 对象存储直传”的实际客户端证据，不只是架构图猜测。该 helper 使用第一条分片 URL、内存中的完整 `[]byte`，不能据此假定所有 Depot 客户端都流式或都单分片上传。[实现](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/api/cache.go#L16)。

### 2.3 公开 CLI 的 Go 缓存实现仍是 v1，不能用它替代 v2 证据

本次提交的 `depot gocache` 实现 Go 的 stdin/stdout JSON 外部缓存协议，每个请求用 goroutine 处理。GET 先查本地磁盘，未命中再调用 `/gocache/v1/{actionID}`；PUT 先落本地缓存，再后台发起远程 PUT。请求携带 Bearer token，指定组织时另有 `X-Depot-Org`。网络故障和部分服务端错误降级为 cache miss；关闭时等待后台上传，10 秒后取消。该实现不是一个“全部读取都同步访问远程”的客户端。[协议循环](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/cmd/gocache/gocache.go#L134)，[读取实现](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/cmd/gocache/gocache.go#L342)，[写入实现](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/cmd/gocache/gocache.go#L457)。

2025-05-30 官方文章描述的 Gocache v2 则把小 PUT 聚合成 bundle，并在 GET 时下载相关 bundle 与分段索引、预取相邻条目。文章明确解释这是为了减少小对象访问 S3 的请求开销。这个产品机制有官方文章支持，公开 `GetBundle`/`Segment` 协议也与之相符，**但本次没有找到能够审阅整个 v2 实现的公开客户端仓库**。不能把 v1 的逐对象路径当成 Depot 当前所有 Go workload 的实现，也不能声称已从开源代码验证 v2 的阈值、并发和压缩参数。[官方 v2 说明](https://depot.dev/blog/now-available-gocache-v2-faster-improved-golang-build-performance)。

### 2.4 鉴权有多个生命周期：用户/项目凭据、构建凭据、机器凭据

CLI 提供 Bearer header 及可选 `x-depot-org`；项目授权可以从显式 token、环境、本地配置、CI OIDC provider、JIT/cache token 等路径解析，而组织授权的代码路径并不完全相同。不能把“CLI 支持 OIDC”理解为每个命令都自动完成同一种 token exchange。[RPC header](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/api/rpc.go#L79)，[授权解析](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/pkg/helpers/token.go#L13)。

`setup-action` 开启 `oidc` 时，会请求 audience=`https://depot.dev` 的 GitHub ID token，POST 到 `https://github.depot.dev/auth/oidc/github-actions`，随后把交换结果作为 `DEPOT_TOKEN` 放到工作流环境并标记 secret；开源 fork PR 还有独立的 public OIDC fallback。它证明了有短期凭据交换的集成入口，不能证明后端的完整信任策略、token TTL 或撤销机制。[Action 源码](https://github.com/depot/setup-action/blob/91bc8495a33ebfc504ffc89e5674379ccf23c29c/src/index.ts#L30)。

BuildService 返回独立 `build_token`；机器注册则依赖 AWS 实例 identity document + signature 或 Fly OIDC，获得任务流和机器 token。这些身份区分支持分层权限与调度控制，而非所有请求共用一把组织长期 key。[构建 token](https://github.com/depot/cli/blob/788a3d5373bc5f4bc19f40f8d6148899b763706c/proto/depot/cli/v1/build.proto#L81)，[机器注册](https://github.com/depot/machine-agent/blob/f6183c52bb8992d408ad0b246fa87f24a597ed60/src/index.ts#L36)。

### 2.5 BYOC 代理是期望状态协调器，而非一次性启动脚本

`cloud-agent` 读取云资源当前状态，向 Depot API 请求 desired state，再协调创建/变更机器与卷。AWS 和 Fly 有不同 provider。AWS 实现含 EC2 RunInstances、start/stop/terminate 与 EBS gp3 volume create/attach/detach 等操作；卷容量、IOPS、throughput 是控制面下发参数。Connect 通道配置 HTTP/2、连接 token、keepalive，另有更新代理版本的循环。[协调循环](https://github.com/depot/cloud-agent/blob/727d4b99a6678d48e190d08724715adf013aa731/src/handlers/state.ts#L31)，[AWS 实现](https://github.com/depot/cloud-agent/blob/727d4b99a6678d48e190d08724715adf013aa731/src/utils/aws.ts#L55)，[HTTP/2 通道](https://github.com/depot/cloud-agent/blob/727d4b99a6678d48e190d08724715adf013aa731/src/utils/grpc.ts#L12)。

volume reconciliation 是单独的 server stream，公开实现设置并发上限 25，并跟踪正在执行与近期完成的 action；控制面连接锁未取得时按错误码退避。这些是“持续协调 + 幂等资源操作”的实现线索，不能由此推断平台全局只有一个 scheduler。[卷协调器](https://github.com/depot/cloud-agent/blob/727d4b99a6678d48e190d08724715adf013aa731/src/handlers/volumes.ts#L46)。

### 2.6 BuildKit 持久缓存具有真实块存储路径；Ceph 不是猜测，但适用范围有限

cloud-agent 中存在完整 Ceph RBD 管理调用：namespace、image、snapshot、clone、client credential、按 namespace 的 auth caps、sparsify。创建 RBD 指定 stripe-unit 64K / stripe-count 4，clone 使用 clone format 2。这证明 Depot 公开代理支持块设备快照/克隆与租户卷授权路径；它不证明所有托管区域、所有产品、当前 Depot Metal 的生产块存储都采用相同实现。[卷生命周期](https://github.com/depot/cloud-agent/blob/727d4b99a6678d48e190d08724715adf013aa731/src/handlers/volumes.ts#L117)，[Ceph 低层调用](https://github.com/depot/cloud-agent/blob/727d4b99a6678d48e190d08724715adf013aa731/src/utils/ceph.ts#L35)。

machine-agent 接收 mount 配置，必要时 `rbd map`，然后格式化/挂载 ext4、XFS 或 Btrfs，作为 BuildKit root。非 Ceph 路径会把 executor 工作目录 bind mount 到 `/mnt/executor`，体现持久缓存与临时执行目录可分开布置。关闭流程停止 BuildKit、sync、可选 fstrim、卸载/解除映射，最后通知 API 已退出。[挂载实现](https://github.com/depot/machine-agent/blob/f6183c52bb8992d408ad0b246fa87f24a597ed60/src/utils/mounts.ts#L9)，[executor 目录](https://github.com/depot/machine-agent/blob/f6183c52bb8992d408ad0b246fa87f24a597ed60/src/utils/mounts.ts#L169)，[关闭流程](https://github.com/depot/machine-agent/blob/f6183c52bb8992d408ad0b246fa87f24a597ed60/src/tasks/buildkit.ts#L296)。

### 2.7 机器代理暴露了 BuildKit 的专门优化面

当前代码生成的 BuildKit 配置包括 TCP 443 + Unix socket、TLS CA、OCI worker、stargz snapshotter、缓存大小与保留天数策略；支持 additional config 覆盖。任务还可切换 private BuildKit binary、parallel gzip、resolver concurrency、SQLite metadata/cache backend、OTLP tracing 和 profiler 等选项。[BuildKit 任务实现](https://github.com/depot/machine-agent/blob/f6183c52bb8992d408ad0b246fa87f24a597ed60/src/tasks/buildkit.ts#L16)。

这里的 SQLite 选项属于 **BuildKit 机器内元数据/缓存实现**。它不能作为 Depot 平台控制数据库或多协议缓存索引使用 SQLite 的证据。配置中的默认并行数和 chunk size 也不应被当作全平台性能参数。

## 3. 合理架构推断及置信度

| 推断 | 置信度 | 依据与边界 |
|---|---|---|
| Depot 有逻辑分离的控制面与多种数据通道 | 高 | BuildService 分配执行连接；CLI 连 BuildKit；CacheService 分配对象 URL。未证明物理部署一定是微服务集群 |
| 缓存元数据 API 管理键→对象/分段定位，较大 payload 可直接走对象存储 | 高 | Create/Finalize/GetDownloadURL/GetBundle，以及实际 presigned PUT helper。未证明所有协议都绕过缓存服务传输 |
| 工具语义通过 entry type/scope 和适配器映射到底层存储能力 | 中高 | 泛型 cache.proto 与 Gocache 专有入口共存。未看到服务端适配器 registry 和所有 namespace 规则 |
| bundle 是降低小对象请求放大的重要设计，而不只是提升压缩率 | 高 | 分段协议 + 官方 v2 对请求开销的解释；压缩格式和目标大小未知 |
| 构建计算资源可回收，而持久缓存卷单独维持生命周期 | 高（公开代理路径） | 机器/卷分开协调，BuildKit root 挂盘、退出卸盘、快照克隆支持；生产策略和保留边界未知 |
| 多区域/多 cloud provider 的差异可能被资源协调层封装 | 中 | AWS/Fly provider、endpoint 下发、独立卷路径。没有证据证明全球单一统一调度器或特定一致性协议 |
| 管理层与性能关键组件采用不同语言/存储并存 | 中 | Go CLI、TypeScript agents、BuildKit 独立程序；**客户端语言不能证明闭源服务端语言** |

## 4. 对 FindMissing 性能判断的限制

`CheckEntries(repeated keys)` 是批量查询协议的直接证据，**不是 Depot `FindMissingBlobs` 服务端实现的证据**。本次公开代码不能回答：

1. REAPI 是否内部调用这套 CacheService，还是走独立的 CAS 索引。
2. 一次请求使用几次数据库访问、是否按租户分片、是否有 Bloom Filter / in-memory index。
3. 存在性判定是否同时建立保护窗口，如何与 GC 协调。
4. 缓存一致性、索引重建、误判处理，以及 P95/P99 和 digest/s 的实测值。

可以学的是 API 形状和成本控制方向：批量存在性查询、元数据与 payload 分离、小对象聚合、局部磁盘缓存/预取。**不能把 Depot 的产品加速倍数转换为 expbuild 的 FindMissing 延迟承诺。**

## 5. 对 expbuild 的可借鉴项

- 将“缓存平台”拆为共享管理能力与工具适配语义：保留类型/作用域、前缀恢复、关联对象、bundle 索引等扩展空间，但不要把所有工具键当成内容摘要。
- 优先验证 `CheckMany`/FindMissing 批量路径；把存在性索引和 blob payload 的吞吐分别测量，不以 RPC/s 替代 digest/s。
- 为小对象高频工具预留客户端本地缓存与 bundle 接口。首次版本可以不用 bundle，内核应避免强制“一条语义条目只能映射一个独立对象”的不可逆假设。
- 保持上传会话与发布的明确边界。未来引入 presigned multipart 时，必须先解决校验、发布、孤儿清理和凭据权限边界；Depot 的 proto 没有公开这些正确性细节。
- 企业自托管可借鉴 desired-state agent，但“BYOC 且控制面仍由厂商运营”与“完全离线自托管”属于不同产品承诺。
- 构建执行与持久缓存要分别规划容量、恢复和隔离。Ceph/RBD 是一种已见实现，不构成 expbuild P0 必須引入 Ceph 的理由。

## 6. 仍然未知，不能写成事实

缓存服务语言、具体表结构、索引类型、热点 shard 分配、缓存 GC 算法、CAS 物理去重范围、全局路由实现、bundle 目标大小/压缩/淘汰、服务端 FindMissing SQL、客户端证书寿命、token 撤销传播、全部产品的物理网络路径，以及公开代理与 Depot Metal 新架构之间的实际部署比例。本笔记中的代码既不能证明这些实现，也不能否定其他官方材料已经披露的部分。
