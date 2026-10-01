# P0 元数据模型、事务与回收协议

日期：2026-09-28。状态：可供实现评审的设计草案，尚未部署。配套 [metadata-schema.sql](metadata-schema.sql) 是空库 DDL 骨架，不是当前 Prisma/SQLite 或 Rust 缓存的迁移脚本。

范围固定为企业自托管优先、REAPI cache-only + Gradle HTTP、PostgreSQL + FS/一个 S3 后端。本轮将长期规划中的去重范围进一步收紧：**P0 物理去重只在同一 namespace 内进行**。后续显式共享需要单独的授权与数据模型演进，不通过修改现有 namespace 的归属实现。

## 1. 可以据此开始编码的决定

1. 所有数据面持久对象包含 `(tenant_id, project_id, namespace_id)`；从可信 RequestContext 获取，客户端的路径只用于解析候选 namespace，不能覆盖已认证 scope。
2. namespace 创建时固定 `protocol_id` 与 `trust_domain`，不可原地切换。相同 trust_domain 标签不授予任何共享权限；REAPI、Gradle 的相同 key 不相等。
3. BlobIdentity 表示已校验字节的 SHA-256 和逻辑大小；BlobGeneration 表示实际持久副本；BlobVisibility 表示当前 namespace 获得访问资格及独立 CAS 保留期。三者不能合并。
4. CacheEntry 当前版本单行，`generation` 递增；覆盖需要条件提交，旧引用在同一事务替换。已发起读取的保护由具体 blob generation 的 retain/lease 独立维持。
5. namespace 存储硬额度按唯一可见 BlobIdentity 的逻辑字节计一次；blob 对象数与 entry 数量分别设上限。上传先保守预留，成功去重释放余额。P0 下载统计与软预算不冒充跨节点下载硬限。
6. 上传 session 绑定主体与**具体 credential ID**。同一主体换 token 不能继承旧 session；重启上传或今后通过明确设计的转移流程处理。
7. 配额、可见性、条目引用、提交结果及关键 outbox 事件在一个 PostgreSQL 事务结算；存储写入在事务前完成，未被事务接纳的对象进入孤儿回收。
8. GC 删除特定 generation 的唯一 locator；进入 `deleting` 后不得复活。新上传使用新 generation/locator，防止旧清理器删除新对象。

`trust_domain` 在 P0 固定为 `trusted-ci / internal-dev / isolated-pr` 之一，由当前 namespace 携带；不另设跨项目信任域共享图。可信 CI 与外部 PR 使用不同 namespace。必须新增一张可共享隔离域表并实现授权引用后，才能扩大去重范围。

## 2. 16 张表的职责与边界

| Schema / 表 | 关键职责 | 谁可写 |
|---|---|---|
| `expbuild_cp.tenant` | tenant 身份、状态、单调 `authz_epoch` | 控制面 |
| `expbuild_cp.project` | 真实 tenant→project 父关系 | 控制面 |
| `expbuild_cp.principal` | tenant 内 user/service_account/system 主体父表 | 控制面 |
| `expbuild_cp.credential` | token ID、主体绑定、失效与撤销事实 | 控制面 |
| `expbuild_cp.policy_version` | 追加式策略版本与 epoch | 控制面 |
| `expbuild_cp.namespace` | project→namespace、固定协议/信任域、当前策略 | 控制面 |
| `expbuild_cache.quota_account` | namespace 额度、已用/预留字节与 blob 数、entry 数 | 额度领域事务；额度配置由控制面调用领域接口 |
| `expbuild_cache.quota_reservation` | 上传预算所有权、过期、幂等结算 | 数据面/回收器 |
| `expbuild_cache.upload_session` | 上传偏移、持久 checkpoint、writer fence 与提交结果 | 数据面/回收器 |
| `expbuild_cache.blob_identity` | namespace 内唯一内容身份 | 数据面 |
| `expbuild_cache.blob_generation` | 不可变持久 locator、健康与 GC 状态 | 数据面/GC |
| `expbuild_cache.blob_visibility` | 授权上传形成的可见性、具体 generation 保留期 | 数据面/GC |
| `expbuild_cache.cache_entry` | 工具 key、当前 generation、协议 payload、写入 provenance | 数据面 |
| `expbuild_cache.entry_reference` | 当前条目的完整必要 blob 引用集合 | 条目提交/失效事务 |
| `expbuild_cache.blob_lease` | 活跃读取对具体 generation 的短租约 | 数据面 |
| `expbuild_cp.audit_outbox` | 关键事实与异步事件投递游标 | 相应领域事务追加；投递器仅改投递列 |

这是领域分工，不代表数据面数据库账号可修改全部控制面表。最终 migration 需要数据库角色、列/表权限、连接池与查询预算。当前 DDL 不配置生产凭据，不声称已通过 RLS 强制隔离。

控制面完整的 User、Membership、Team、RoleBinding、ServiceAccount 属性、Token verifier/pepper、认证会话、API 幂等记录和清理 job 见 [控制面契约](control-plane.md)，后续迁移补充。这里的 `principal` 是每 tenant 的主体投影；同一个全局 User 加入两个 tenant，分别产生两个主体绑定。凭据 verifier 仅留在控制面，绝不发到数据面。

`backend_id` 由管理员的存储配置注册表解析，普通客户端不得提供后端地址。该配置表尚未纳入这份最小索引 DDL；接入生产迁移时补真实 FK，或通过版本化配置服务验证。当前所有 tenant/project/namespace、主体/token、策略、缓存引用 FK 均指向草案中存在的表。

## 3. 复合键与不可变边界

数据面外键从不只用裸 `blob_id`、`entry_id`、`project_id`。例如：

```text
project                  PK (tenant_id, id)
namespace                PK (tenant_id, project_id, id)
blob_identity            PK (tenant_id, project_id, namespace_id, id)
blob_generation          PK (tenant_id, project_id, namespace_id, blob_id, id)
blob_visibility          UNIQUE (tenant_id, project_id, namespace_id, blob_id, generation_id)
entry_reference          FK → cache_entry(..., id, generation)
                         FK → blob_visibility(..., blob_id, generation_id)
credential               UNIQUE (tenant_id, principal_id, id)
upload_session           FK → credential(tenant_id, principal_id, id)
                         FK → quota_reservation(scope, reservation_id, principal_id, credential_id)
```

因此，伪造一个真实但属于其他 project 的 namespace，或把另一主体的 reservation 接给当前 token，会被 FK 拒绝。应用仍必须在查询条件中带完整 scope；FK 不会限制 `SELECT`，也不等于授权策略。

SQL 的 immutable triggers 阻止 namespace 改 tenant/project/protocol/trust，阻止 BlobIdentity 换摘要/大小，阻止 BlobGeneration 换 locator/version，阻止 session 换主体/token/目标。PolicyVersion 为追加式记录。Entry 的 scope/key 固定，generation/payload/provenance 通过覆盖事务更新。

P0 固定 SHA-256、未压缩逻辑摘要、后端 identity 编码；S3 自身加密不改变协议摘要。未来增加 digest/encoding 时改兼容矩阵和 migration，不先在 capability 中宣告。SQL 中 key ≤512 字节是索引设计的评审起点；协议 payload、引用总数、目录深度与解析预算由应用配置限制，不在 DDL 重复另一套固定 payload 上限。协议 PoC 校准预算后记录进版本化部署配置；数据库 driver/请求解码器还须设置最大传输参数和语句预算，禁止把超大 payload 直接送到 SQL 后再检查。不能截断 key、payload 或引用列表。`invocation_id` 仅关联客户端提供的构建上下文，不参与命中键、授权或完整流水线归因。

## 4. Blob 可见性、引用与读取

### 可见性判定

`FindMissing`、直接 CAS 读取、BatchRead、结果发布分别鉴权，随后查同 namespace 的 BlobVisibility 与 BlobGeneration。物理后端存在对象、甚至 BlobIdentity 已存在，都不能单独形成命中。首次取得可见性必须完整上传并校验字节；P0 不开放“我知道 digest，就把别人的 blob 加进我的 namespace”的接口。

可服务对象至少满足：可见性存在、generation 健康可读、授权允许。保留根来自尚有效的 entry 引用、`visibility.retain_until` 或活跃 `blob_lease`。过期仅令对象成为回收候选；数据仍完整且未进入不可恢复删除时，可按协议和策略恢复其保留。租户删除、授权撤销或损坏隔离不能借保留期恢复。

FindMissing也提供短期使用窗口：保留期已覆盖响应deadline加grace的live对象可只读确认；其他候选必须在相同GC锁协议下重验、续期/恢复后才返回present，不能把无保护的tombstone当命中。查询与续期均批量执行；这条不增加用量的路径不取namespace配额锁，详见 [专项设计](findmissing-performance.md)。

### 零字节对象

REAPI 的规范 SHA-256 空摘要（大小 0）作为内核虚拟常量处理；授权及 namespace 路由仍必须成功，但不建立 BlobIdentity/Generation/Visibility，不计字节或 blob 数，不申请持久 read lease，也不纳入 entry_reference。协议 payload 保留原始空 digest；OpenBlob 返回虚拟空 handle。引用枚举在识别规范空摘要后排除持久闭包，不把其他大小为 0 的错误摘要当作常量。空写仍遵循资源名、偏移及原生提前完成规则，不能任意免验证。此规则不扩展到 Gradle：若客户端验证表明零长度归档有效，仍按普通 opaque entry 保存其 blob/引用并计入 blob 数和条目数，逻辑字节为零。

### 条目引用闭包

Gradle 每个归档一个必需 blob 引用。REAPI 由适配器校验 ActionResult，并枚举所有必要的 stdout/stderr、输出文件、Tree/Directory 及叶子文件内容，按实际返回表示记录完整必要闭包；相同 blob 在一条 entry 中只记录一次。内联字节是否进入 CAS 由已锁定协议约定决定，不能一边宣告内联成功一边遗漏必需内容。

提交时必须验证引用存在且可见。引用数、目录深度、总解析字节与 CPU 均受上限控制；超过限制明确失败。没有完整闭包的条目不得标记为 `ready`。范围与真实客户端用例由 REAPI 适配器的兼容矩阵决定。

### 结果返回后的保护窗口

`GetActionResult/GetEntry` 在返回结果前：锁住 entry 当前版本及其已索引的 blob generations，复核状态，将对应 `visibility.retain_until` 延长至 `max(现值, now + metadata_fetch_grace)`，然后提交。随后即使 entry 被覆盖，旧 blob 仍被这个独立窗口保护。

这是 O(引用数) 的批量索引工作，不在每次读取时递归解析目录树。P0 引用数上限及 grace 初值由 PoC 校准，先以有界批量更新验证。大量 ActionResult GET 若造成热行争用，可以提前续足窗口并在安全期限内省略重复更新；必须保证被省略的请求仍获得完整承诺窗口。不能用抽样访问时间代替保护。

实际 blob 流开始前，在 generation 行锁下创建 `blob_lease`，期限不超过本次授权租约/请求截止时间。长流定期重新鉴权、续保护租约；租约过期、撤销或续租失败即终止读取。GC 租约保护不授予权限。有限 grace 无法保证客户端任意延迟之后仍可取到内容；超窗后缺失按原生协议处理。

## 5. 上传与 durable_offset

```text
open → receiving → verifying → publishing → committed
  └───────────────→ aborted / expired
```

1. 规范化 resource，并按 `(scope,client_upload_uuid,expected_digest,expected_size)` 唯一查找/建立 CAS session；同 UUID 上传不同 blob 合法。内部 session ID 与客户端 UUID 不等同，QueryWriteStatus 在重启后使用相同复合映射。已存在 session 必须验证 owner/token，不向冲突的其他主体泄露其状态。校验协议输入与当前 AuthorizationLease，确认 tenant epoch、namespace 状态、操作权限与对象上限。
2. 锁 quota_account，原子建立 reservation 与 session。REAPI 按预期逻辑大小预留；Gradle 若 Content-Length 可用则按长度预留，否则先预留有限窗口，在接受更多字节前扩展。每个非空上传先预留 1 个 blob 额度；最终去重成功则释放这 1 个预留。规范零字节对象走虚拟路径，不建立上传 session 或 reservation。
3. `durable_offset` 只表示可在服务端崩溃后恢复的连续字节数。P0 所有后端先落本地持久 staging，依确定的 fsync 策略 checkpoint；`staging_node_id` 固定绑定节点，恢复请求必须回到该节点，不能拿其他节点的同名路径继续写。节点/卷永久丢失时旧 session 失效、释放预留并要求新上传，不承诺跨节点续传。S3 持久发布需要时由 `backend_cursor` 保存内部 multipart upload ID/part 清单，不保存密钥；直接以 S3 multipart part 边界续传留到后续单独认证。
4. 每次续传、QueryWriteStatus、写入及 commit 重新校验当前主体/token，并以 `writer_fence`、owner、lease 作条件更新。接管会递增 fence。**数据库 fence 不能阻止过期进程继续向同一个暂存文件写字节**，所以每次接管使用含新 fence 的新 staging locator，复制/恢复已确认前缀后继续。旧 attempt 只能污染自己的暂存路径。
5. 摘要可从 durable prefix 重算后继续流式计算；P0 不依赖某库内部 hasher 序列化格式。宣告长度与最终字节数必须一致；未知长度由完成时事实确定。上传对象校验通过后发布唯一不可变持久 locator。
6. 提交事务确认 session 未过期、fence 仍有效、token 当前有效，选择本 namespace 健康 live generation 或接纳新的 generation，建立可见性、结算额度、记录 committed 结果。Opaque entry 在同一领域提交中发布条目；REAPI CAS 与 AC 发布分别鉴权。
7. 成功重试返回已记录结果，不能重复计量。若凭据已撤销，不因历史成功而绕过当前授权暴露 session 状态。终态 session 保留有限幂等窗口后清理；恢复中不承诺无限期 QueryWriteStatus 历史。

同摘要并发上传可都完成字节校验，但只有一个 generation 成为当前 live 副本。后续提交在锁住 BlobIdentity 后复用赢家，将自身冗余暂存/持久对象放入孤儿清理；不得因物理去重省略首个授权上传证明。对象完成但数据库事务失败会留下可回收孤儿，不产生可见半条目。

暂停/崩溃与上传存储细节见 [缓存内核方案](cache-core.md)。session TTL、writer lease、幂等窗口与后端 orphan grace 是不同参数：暂存对象清理窗口必须覆盖仍可能恢复的 session，不能只按对象创建时间删除。

## 6. 额度口径与事务

| 口径 | P0 定义 |
|---|---|
| 逻辑已用字节 | namespace 当前 BlobVisibility 对应的 BlobIdentity.logical_size 之和 |
| 逻辑预留字节 | namespace 中 active reservation 的 reserved_bytes 之和 |
| blob 已用/预留数 | namespace 当前非虚拟 BlobVisibility 数 / active reservation 的 reserved_blobs 之和 |
| entry 数 | 尚保留在索引中的 ready entry 数；失效/删除事务释放 |
| 物理存储 | 后端实际 generation、临时对象、版本与待清理字节，单独观测，不拿逻辑硬限冒充磁盘保护 |
| 下载 | 实际发出的线传/逻辑字节分别统计；P0 为软预算 |

同 blob 被同 namespace 的多个条目引用，逻辑字节只计一次；另一个 namespace 即使上传相同字节仍单独计量并物理隔离。Standalone CAS 也计费，不能靠不发布 AC 绕过额度。

准入示意（使用 numeric 中间值避免 bigint 相加溢出）：

```sql
UPDATE expbuild_cache.quota_account
SET logical_bytes_reserved = logical_bytes_reserved + :delta,
    blobs_reserved = blobs_reserved + :object_delta,
    revision = revision + 1
WHERE tenant_id = :tenant AND project_id = :project AND namespace_id = :namespace
  AND :delta >= 0 AND :object_delta BETWEEN 0 AND 1
  AND blobs_used::numeric + blobs_reserved::numeric + :object_delta <= blob_limit::numeric
  AND logical_bytes_used::numeric + logical_bytes_reserved::numeric + :delta
      <= logical_byte_limit::numeric
RETURNING revision;
```

必须和 reservation 插入/扩展在同一事务；首次预留的 object_delta=1，已有 reservation 仅扩字节时 object_delta=0；`delta` 先在应用转换为有界非负整数。limit 下调到已用量以下是合法管理操作，因此 DDL 不写 `used <= limit` 的 CHECK。此后拒绝新增长，允许原有读取与回收，不立即删现有数据。

提交时按全局顺序锁 quota_account、session 和 reservation：新 visibility 产生 `charged_bytes = logical_size, charged_blobs = 1`，已存在可见 blob 的去重提交产生零新增；将 reserved_bytes/reserved_blobs 从账户扣除、新增 charge 加入 used，reservation 置 settled，session 置 committed。即使 entry 发布冲突，也按协议决定保留已上传 CAS 或整个 opaque 操作事务回滚；不能一半结算一半可见。

过期/abort 只可将 active reservation 条件转换一次，并释放余额；它与 commit 争用同一账户/session 锁。实体字节与 blob 数直到 visibility 删除才释放逻辑额度，entry 过期但 CAS grace 仍有效时继续计量。进入删除后的物理尾部另列 pending-reclaim，防止控制台把“逻辑已释放”显示为磁盘空间已腾出。

entry 新增/失效与 `entries_used` 在发布/删除事务维护。blob 数硬限限制大量极小 CAS 对象造成的索引膨胀。entry 内协议 metadata 与暂存空间不按 blob 逻辑额度逐字节计费，必须通过 entry 数/payload 上限、活跃上传数、暂存容量和物理水位独立保护。namespace 硬额度不能替代整个后端磁盘保护。

`quota_account` 汇总与 reservations/visibility/entries 的一致性无法由本 DDL 证明。P0 提供暂停写入后的全量重算工具及在线差异检查；在线校准若不使用一致快照和增量边界，不能直接覆盖活动账户数字。

## 7. 锁顺序与发布原子性

使用 PostgreSQL 行锁 + 唯一约束 + 显式条件更新，初始隔离级别 READ COMMITTED。所有写路径遵循同一锁顺序：

```text
quota_account（需要计量时）
 → upload_session / quota_reservation（需要时；固定先 session 后 reservation）
 → cache_entry（按 id 排序，需要时）
 → blob_identity（按 id 排序）
 → blob_generation（按 blob_id + generation_id 排序）
 → blob_visibility（按 blob_id 排序）
 → 插入/移除引用与 lease、追加 outbox
```

只读授权缓存命中无需锁 quota；分块偏移持久化只锁 session，不能在已锁 session 后回头申请 quota 扩展，扩展事务必须重新按上述顺序开始。多 namespace 操作 P0 不提供；将来要按完整 scope 排序。所有锁等待有界，死锁/serialization failure 有有限重试，不能持数据库锁执行整个网络上传。

entry 发布事务：锁当前 entry（无行时依赖唯一 key 冲突后重读），校验 expected generation；锁待引用身份/generation，恢复允许恢复的 tombstone，检查 visibility、完整性与当前权限；删旧 references，更新 generation/payload/provenance，插新 references，维护条目数和 outbox，然后提交。删除旧 references 与更新 entry 必须在同一事务，否则 FK 拒绝或读取不一致。

CacheEntry 的 `generation` 是同一行内单调版本；清理后重建同 key 使用新的 entry ID，条件 token 应编码 `(entry_id,generation)`，不能只用整数防止 ABA。某协议原生 PUT 不带条件版本时，由适配器选择规范允许的覆盖策略；不能以内部 CAS 约束改变原生协议行为。

GC 持 generation 锁后只用 MVCC 查询 roots/leases，不再反向获取 entry 锁。发布/读保护在同一 generation 锁上排队：若 GC 已切到 deleting，等待者必须失败、等待新副本或重新上传；不能在锁外查“无引用”后执行删除。已提交旧引用被清理前，GC 保守跳过候选。

namespace 的 quota_account 会串行化涉及额度的短提交事务，**不会串行化网络传输与所有读取**。P0 先测锁等待/尾延迟，再考虑额度分片或预算租约；不为理论吞吐牺牲硬限和原子性。SQL trigger 没有封装上述路径，后续实现必须统一通过领域 repository/service 方法。

## 8. GC generation 状态机与故障恢复

```text
live ──无保护根──→ tombstoned ──grace后原子复核──→ deleting ──后端确认──→ deleted
  ↑                    │
  └──合法新引用/读取恢复┘
live / tombstoned ──校验损坏──→ quarantined ──隔离引用后──→ deleting
```

1. 先失效/清理到期 entry 并移除 references，尊重 pin 和读取保护。过期 session 释放预留，暂存清理单独进行。活跃上传尚未成为 live generation 的暂存对象由 session 保护。
2. 对无 roots/visibility retain/活跃 lease 的 live generation，锁住身份与 generation，设 tombstone、epoch、delete_not_before。epoch 用于扫描可观测性，**不作为并发安全的唯一依据**。
3. 等待宽限期后重新取得同一锁。恢复/新引用事务只允许 live 或在授权且对象完整时条件恢复 tombstone，并同时写保护。GC 若看到保护即停止该候选。
4. 确认可删除时，锁 quota_account、身份/generation/visibility，移除不再受保护的 visibility、释放逻辑额度，将状态原子变为 deleting，分配/递增 `gc_fence`、gc_owner 与 gc_lease_until。references 的 FK 会阻止仍被条目使用的 visibility 删除。此步骤后任何新引用禁止使用这个 generation。
5. 事务外删除固定 `(backend_id, storage_key, backend_version)`。删除超时意味着结果未知，不能先标 deleted；重试同一个定位符。重新认领任务递增 fence；完成更新必须 `WHERE state='deleting' AND gc_fence=:claimed AND gc_owner=:owner`。
6. 旧 worker 即使在租约失效后继续调用后端，也只能删除这个不可再引用的旧 generation。**fence 保护数据库结算，永不复用 locator 才保护后端对象**。新的同 digest 上传建立不同 locator，不受旧删除影响。
7. 后端确认不存在后置 deleted，记录事件；metadata 保留到引用它的 session/lease 幂等窗口结束。分层清理 tombstone metadata，不能让删除 row 后旧 locator 被复用。

`quarantined` 不可读、不接受新引用。损坏识别需要先令受影响 entry 失效，并保护正在中止的流；隔离流程仍按同一锁/额度规则释放 visibility，不能将 quarantined 当成普通 cache miss 而静默继续发字节。

后端不可达时积累 deleting 重试并告警；逻辑额度释放与物理水位分别展示，低磁盘水位仍可拒绝新上传。GC 启动前若没有确定的恢复状态、策略版本或索引一致性证明，保持关闭。恢复旧索引时先禁写/禁 GC，reconcile 与权限版本对齐后逐步开放。

## 9. PolicyVersion、审计与 outbox

控制面权限变化在一个事务中递增 `tenant.authz_epoch`、追加 PolicyVersion、更新受影响 namespace 当前版本并写 outbox。Token introspection 返回短期签名 AuthorizationLease；数据面使用它的 policy_version/epoch，不读 verifier。`UploadSession.policy_version_at_start` 仅为事实，不能作为 commit 的永久授权；commit 另记当前版本。

outbox 与产生关键事实的事务同提交。event ID 幂等，producer sequence 只表达生产者顺序，不等于整个租户全局事件时间；消费者按 `(tenant_id,event_id)` 或已约定 producer sequence 去重。投递至少一次，租约过期可重投；审计内容不可变，投递状态可以更新。publisher 顺序不能用消息到达顺序替代策略版本/epoch 比较。

本表承载管理审计与关键缓存状态/结算事件，不为每个 GET 写持久审计。高流量读计量、运行指标与构建事件有独立聚合路径；P0 不声称这一张 outbox 已解决未来 SaaS 计费。事件 payload 禁止 token 明文、签名租约全文、任意构建环境内容。

DDL 的 FK 确保记录引用某个真实 policy version，但不证明它当前有效，也不强制 policy version 对应当前 epoch。版本单调、签名验证、撤销传播、最长离线租约和活动流到期终止，由授权服务与数据面实现并测试。

## 10. DDL 能证明什么、实现还必须证明什么

| 不变量 | DDL 提供 | 必须额外实现/测试 |
|---|---|---|
| scope 不串 tenant/project/namespace | 复合 FK、PK、不可变触发器 | 每条查询带 scope；认证/授权；数据库权限/RLS选型 |
| namespace 不换协议或信任域 | immutable trigger | 新建替代 namespace 的管理流程 |
| token 与上传主体一致 | credential/reservation 复合 FK | 续传/commit重新鉴权、撤销/到期与epoch |
| 同内容身份唯一 | 摘要/大小唯一键 | 流式实际计算摘要、大小核验、可信上传来源 |
| 引用存在且指向精确 generation | entry/version/visibility FK | 完整闭包、健康状态、原子发布及读保护 |
| 同时最多一份可发布副本 | live/tombstoned partial unique index | 后端耐久性、赢家选择、孤儿清理 |
| 字节/条目额度不超额 | 非负与简单行内 CHECK | reserve/settle/release账户事务、幂等、对账 |
| offset 真正耐久 | 非负/不超预期大小 CHECK | FS/S3 checkpoint语义、fence与staging隔离 |
| GC 不误删新上传 | locator唯一与不可变字段 | 状态转换、相同锁顺序、永不复用路径、后端版本行为 |
| 审计不丢且可去重 | envelope唯一与不可变触发器 | 业务同事务写入、投递重试、下游去重/保留 |

不能用引用计数或单独的 CHECK 跨表计算代替上述事务。PostgreSQL 官方文档明确了跨行/跨表约束应使用适当外键/唯一约束等机制，锁的获取与死锁处理仍需应用设计。[PostgreSQL 18 约束](https://www.postgresql.org/docs/18/ddl-constraints.html)、[显式锁](https://www.postgresql.org/docs/18/explicit-locking.html)、[触发器](https://www.postgresql.org/docs/18/sql-createtrigger.html)。

## 11. 最小验证清单与当前验证状态

开发首个索引 PR 使用临时 PostgreSQL 实例执行 DDL/迁移并覆盖以下集成案例：

- A project 的 namespace 无法拼到 B project 的上传、引用、事件里；另一主体 token 不能引用当前 reservation。
- 50 个同 digest 并发提交只产生一个当前 visibility、一份逻辑 charge；失败事务不会泄漏永久 reservation。
- 未知长度上传扩预留失败后立即停止接收新字节；断电恢复只报告 durable_offset，不报告内存中的长度。
- worker A 过期、B 接管上传后，A 的续写/commit 无法覆盖 B 的 staging 或元数据；同主体更换 token 无法接管。
- entry 读后覆盖、CAS 随后读取仍受已承诺 grace 保护；GC 等待新引用/租约时不误删；超时旧 GC 不伤新 generation。
- entry generation 1→2 的引用替换要么整体成功、要么整体保留1；删除再建同 key 的 `(entry_id,generation)` 不发生 ABA。
- 降低额度至已用以下保留读且拒绝净增长；逻辑释放不虚报物理空间回收完成。
- outbox 投递失败不回滚已经耐久成功的业务事实，重投不重复结算；策略撤销覆盖已开的流和 commit。
- 恢复旧索引期间保持 GC/写入关闭，缺失对象导致确定 miss/失效，不能假命中或删除未对齐的新对象。

本轮已用临时下载到 `/tmp` 的 `pglast 8.4` 解析配套 SQL，**47 条 PostgreSQL 语句通过语法解析**，并通过 AST 静态检查确认 16 张表的 34 个 FK 均指向存在的唯一键且列类型相容。PL/pgSQL 单独解析的 JSON 包装输出异常，未将它计入通过项。没有运行 PostgreSQL 服务，没有验证 PL/pgSQL 的服务器端编译、实际 FK 创建、并发事务、故障恢复或性能。生产 migration、完整 IAM 表、数据库角色权限和上述集成验证仍是开发交付项。
