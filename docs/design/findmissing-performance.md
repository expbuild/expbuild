# FindMissing 性能与回收一致性

日期：2026-09-28。状态：专项设计，未实现、未压测。当前不能声称满足某个企业规模；尚缺峰值 RPC/s、每请求摘要数、活跃 blob 数、热点分布和目标硬件。本文补充 P0 契约，不改变 PostgreSQL 作为元数据权威源的决定。

## 1. 当前实现与结论

[find_missing_blobs](../../crates/server/src/storage/filesystem.rs:164) 对每个 digest 串行调用 [has_blob](../../crates/server/src/storage/filesystem.rs:45)，后者调用同步 `Path::exists()`。`async` 函数包装没有把文件元数据 IO 变成并发或非阻塞；缓存冷、文件数大时可能阻塞 Tokio 执行线程。当前路径还未核对 namespace，不能直接作为多租户方案上线。

新设计把 FindMissing 变为授权 scope 下的批量元数据查询，常规路径不访问 FS/S3，不为每个 digest 发 SQL 或对象 HEAD。该路线值得作为企业首版验证；其容量由实测确定，不能从“有索引”推导固定 QPS。

## 2. 请求路径

1. 每个 RPC 解析 scope 并取得有效授权；不为每个 digest 调控制面。首次凭据验证与已缓存授权分开统计。
2. 验证全部 digest 的算法、长度、hex、size；按 `(algorithm,digest,size)` 去重，处理规范 REAPI 空 blob。不同 size 不能因 hash 相同合并。
3. 用有界数组参数构造输入关系，批量查 `blob_identity → blob_visibility → blob_generation`。只取 ID、generation、state、retain_until；不读 payload、文件或引用闭包。
4. 已有保留期覆盖本次使用窗口的 `live` 行直接判 present；其余可恢复候选走下节批量续期。不存在、已进入 deleting/deleted 的对象判 missing；已隔离的损坏对象按既定 DATA_LOSS 策略处理，不能假命中。
5. 所有分块完成后组合 missing 响应，返回前复核授权期限/撤销状态。FindMissing没有BatchRead/BatchUpdate那样的per-item status；非法输入和后端失败使用整RPC错误。数据库超时、连接失败和续期失败不能整体降级为 missing，返回可重试错误，避免引发全量重传。

使用 `unnest(bytea[],bigint[]) WITH ORDINALITY` 或等价参数化输入表连接；先验证数组等长且元素非空。每个 SQL 分块的 500、1,000、2,000 个 digest 是初始压测变量，不是客户端协议上限；控制 RPC 内并发分块数和连接池等待，禁止每个 digest 启一个任务。[PostgreSQL 数组函数](https://www.postgresql.org/docs/18/functions-array.html)

RPC 另设摘要数量、实际编码消息字节数与处理 deadline 上限，并用原生客户端验证超限行为。**Capabilities 的 `max_batch_total_size_bytes` 针对 BatchRead/BatchUpdate 的对象总字节，不应拿待查询对象的 size 总和限制 FindMissing。** 一个很大对象的存在性查询本身很小。[仓库内规范](../../crates/proto/proto/build/bazel/remote/execution/v2/remote_execution.proto:2230)

## 3. GC 保护与低写入开销

REAPI 要求近期查询的对象应留出后续使用时间，并建议 FindMissing 必要时延长保留。此前契约只细化了 GetEntry 的读取保护，本节补齐 FindMissing；单纯 SELECT 后立即允许 GC 删除不构成可靠接入。[REAPI 规范](https://github.com/bazelbuild/remote-apis/blob/main/build/bazel/remote/execution/v2/remote_execution.proto)、[冻结的仓库规范](../../crates/proto/proto/build/bazel/remote/execution/v2/remote_execution.proto:340)

- 定义 `use_grace` 与更长的 `refill_horizon`，数值按真实构建间隔校准，可先试验 10 分钟与 30 分钟。它们是存储保留参数，不是授权期限。
- 只读快路径必须证明 `live` generation 的 `retain_until` 覆盖**本次响应最晚完成时间 + use_grace**。时间基准与 GC 一致，使用服务端有上限的 deadline 并处理时钟偏差；不能只比较查询开始时刻，否则慢请求缩短承诺窗口。
- 保留不足或处于 tombstoned 的候选，按元数据契约的稳定顺序锁 identity、generation、visibility，重新检查当前状态/可见性，再条件恢复并延长到覆盖上述窗口及 refill_horizon。事务成功后才报 present；GC 已赢得 deleting 状态则报 missing。
- 续期只增加 retain_until，不更改引用归属、不重复计量、不申请 namespace 配额锁；没有网络 IO 或对象 hash 在事务内。P0 此路径不使用所有请求共用的 namespace 粗锁。
- 已有保护充足的重复查询不更新访问时间、不新增每 digest 的持久 lease/outbox；同一批的保护更新合并执行。续期涉及真实写入，因此必须测 WAL、锁等待、vacuum 和续期集中到期时的尾延迟。
- GC 必须遵守已提交保留期，不能为了回收磁盘绕过它。授权撤销、明确的管理删除、损坏隔离仍可使后续请求失败；保留期不是绕过权限的保证。

多分块 RPC 部分续期后整体失败，可以留下额外保留；不可为了回滚响应而缩短已经承诺的期限。临近 deadline 时无法完成保护就失败重试，不能返回未经确认的 present。

## 4. 索引与缓存取舍

现有 DDL 已提供三段查询键：identity 的 `(tenant,project,namespace,algorithm,digest,size)` 唯一索引、visibility 的 scoped blob 主键、generation 的 scoped blob+generation 主键。全 scope 等值约束适合当前复合索引前缀；这是可查询性判断，不是性能认证。[DDL](metadata-schema.sql:110)、[PostgreSQL 复合索引](https://www.postgresql.org/docs/18/indexes-multicolumn.html)

先运行代表性批次的 `EXPLAIN (ANALYZE, BUFFERS)`，观察计划、heap fetches、共享块命中/物理读及查询耗时；续期另测 WAL 和锁。必要时对 identity 的唯一索引评估 `INCLUDE(id)`，而不是未经测试给三张表重复加宽索引。覆盖索引仍受 MVCC visibility map 影响，频繁更新的保留期表不能保证 index-only scan。[PostgreSQL 覆盖索引](https://www.postgresql.org/docs/18/indexes-index-only-scans.html)

P0 从权威数据库查询起步，不引入额外存在性缓存。后续若加缓存：

- 正缓存必须绑定完整 namespace、digest+size、具体 generation 和保护截止时间；短 TTL 本身不能阻止 GC 竞态。授权每请求仍检查；删除/隔离需要可靠失效机制。
- Bloom 命中只能说明“可能存在”，必须精确确认；假阳性不能让客户端跳过必需上传。负结果若来自滞后或重建不完整的过滤器，也不能当作权威 absence。先定义发布、删除和恢复的一致性协议，再讨论过滤器节省多少查询。
- 读副本、本地 KV 或异步物化表不得裸读滞后状态来确认 present；只有足够新且仍有有效保留证明时才能进入快路径。

## 5. 容量表达与验收

首要负载单位是 `digest checks/s = RPC/s × 每RPC摘要数`；还需报告去重前后数量、命中率和每秒实际续期行数。例：200 RPC/s × 1,000 digest = 20万 digest checks/s；这是负载换算，不是已经达到的吞吐。

初始试验矩阵（待真实项目替换）：

| 维度 | 样本 |
|---|---|
| namespace 活跃 blob 数 | 100万、1,000万；1亿作为规模边界探索 |
| 每 RPC 摘要数 | 100、1,000、10,000；另测重复 digest 与消息上限 |
| RPC 负载 | 开放式到达率从低到高递增，记录首个 SLO 失守点；固定并发仅作补充 |
| 命中与局部性 | 0%、50%、99% 命中；重复热点和均匀随机 |
| 数据状态 | 预热、冷缓存、保留充足、集中临近过期 |
| 并行操作 | 上传发布、GC、撤销、恢复、热点租户与小租户竞争 |

可先采用**工程候选目标**：同机房 RTT≤1ms、复用 TLS、授权已预热、每 RPC 1,000 个摘要，在选定试点峰值负载下端到端 P95≤20ms、P99≤50ms。这不是沿用此前 1KiB entry 查询的测试结果，也不是已达到的承诺。目标要附 CPU/RAM/NVMe、DB参数、总行数、命中比例和续期比例；客户端首次认证和冷启动单独报告。

测 RPC 总耗时、授权、连接池排队、SQL、续期、序列化、CPU/IO、WAL、锁等待、数据库大小和真实构建的 FindMissing 累计等待。超载错误、超时和被拒绝请求纳入结果，不能只统计成功请求并掩盖排队；沿用路线图至少5次可复现运行及完整环境记录。

FindMissing 专项属于 EXP-003/007/012 的试点发布门槛：批量 SQL/权限隔离正确、GC 竞争不产生过时 present、目标负载下延迟达标。若未达标，依次分析批次/计划/索引常驻率与续期写放大，再评估经一致性设计的专用查询索引或分片；不以新增 Redis 或 RocksDB 的名称代替性能证据。
