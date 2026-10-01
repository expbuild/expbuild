# 控制面：身份、授权、管理 API 与撤销契约

日期：2026-09-28。状态：**待实现的 P0 开发设计**，不是现有能力说明。以 [主规划](../strategy/README.md)、[管理能力](../strategy/01-product-and-management.md)、[架构](../strategy/02-architecture-and-extension.md) 和 [路线图](../strategy/06-roadmap-and-validation.md) 为上位约束；数据模型与写入一致性参见本目录其他设计。

## 1. 交付边界和现状差距

P0 保留 TypeScript 管理服务与 React，使用 PostgreSQL；管理服务负责 IAM、项目、策略、审计、异步管理任务，Rust 数据面负责产物传输、缓存索引与额度执行。两个服务使用不同数据库角色；浏览器不能直接访问内部策略接口。P0 不含公开注册、收费、任意 ABAC、CI OIDC 联邦或跨租户共享；企业 OIDC 属 P1，若试点硬性要求则替换其他范围。

当前 [Prisma schema](../../../expbuild-admin/server/prisma/schema.prisma) 只有 `User.role`、`Project.ownerId`、明文 `Project.apiKey`，没有租户、成员、namespace 或凭据作用域。[pipeline 路由](../../../expbuild-admin/server/src/routes/pipeline.ts) 会用客户端 `projectId` 覆盖授权项目集合。本设计必须替换这些边界，不能只在旧模型增加菜单；旧 key 不复用为新凭据。

自托管安装通过本机一次性 bootstrap 命令创建首个用户、tenant 和管理员绑定；完成后关闭 bootstrap。后续用户通过管理员生成的一次性加入链接注册，不发送邮件亦可使用。平台管理员管理安装和后端配置；访问租户产物必须另获租户授权。

## 2. 最小领域模型

所有 ID 为不可变 UUID；名称和 slug 仅用于显示、检索，不构成授权依据、对象键或原生工具路由。浏览器显示的“组织”就是 Tenant。

| 对象 | 必需字段与约束 |
|---|---|
| Tenant | `id,name,status,authz_epoch,revision`；`active/suspended/deleting` |
| User / Session | 全局用户身份；会话保存用户、到期、撤销时间；不在用户全局 `role` 中塞入租户权限 |
| TenantMembership | `tenant_id,user_id,role,status`；租户角色 `admin/member`；每租户至少保留一名 active admin |
| Principal | `tenant_id,id,kind,status,user_id?`；kind 为 `user/service_account`；同一全局 User 在不同 tenant 映射不同 Principal |
| Team / TeamMember | 租户内扁平团队；成员必须是同租户 active membership；不允许嵌套团队 |
| Project | `id,tenant_id,name,description,status,revision`；归属替代单一 owner 字段 |
| ProjectBinding | `tenant_id,project_id,subject_type,subject_id,role`；人或团队绑定 `maintainer/developer/observer` |
| Namespace | `id,tenant_id,project_id,name,protocol_id,trust_domain,status,current_policy_version`；协议 P0 为 `reapi/gradle`，信任域为 `trusted-ci/internal-dev/isolated-pr` |
| ServiceAccount | 租户及项目归属、名称、状态、创建者；无密码、浏览器会话或组织管理权 |
| Credential | `id,tenant_id,principal_id,verifier,pepper_version,expires_at,revoked_at,created_by,rotated_from_id,last_used_at`；关联不可变授权范围 |
| NamespaceGrant | `subject_type=principal/team`、同 tenant 主体/团队 ID、namespace 与动作；展开团队成员后再与凭据范围取交集 |
| PolicyVersion | `tenant_id,version,authz_epoch,document,created_at`；不可变，namespace 指向当前版本；API revision 用于并发控制 |
| Audit / Outbox | 变更前后摘要、操作者、资源、`request_id,policy_version,occurred_at`；与业务变更同事务写入 |

`protocol_id/trust_domain` 在 namespace 创建后不能变更。改变协议或信任等级必须建新 namespace、发新授权并重新预热；不通过 PATCH 提升旧内容可信级别。P0 不允许跨 namespace 隐式读回退，需要跨项目共享时先独立设计显式授权引用。

子表统一带 `tenant_id`，并通过 `(tenant_id,parent_id)` 复合外键绑定父级；namespace 再约束所属 project。UUID 全球唯一不能替代 tenant 条件。团队和角色仅用于计算授权，凭据最终展开为具体 namespace 集合，P0 不接受 `*` 或未来项目通配。

与 [元数据模型](metadata-model.md) 对齐：`Principal/Credential` 是数据面引用的最小权威父记录；`User/Membership/Team/Binding/verifier` 是控制面补充表/列，SQL 草案不宣称覆盖完整 IAM schema。namespace 是 P0 的物理隔离和去重单位，不因同属 tenant 或信任等级而合并物理域。

## 3. 权限决策及防止过滤覆盖

管理权限与数据权限分开。`tenant.admin` 可管本租户成员、项目和策略；`project.maintainer` 可管本项目 namespace、服务账号、保留和凭据；二者不自动获得产物读取权。`developer` 可查看获准项目并申请自己的只读凭据，`observer` 只读指标与元数据。实际产物读取要有 namespace `cache.read`；浏览器导出产物另需 `artifact.download`。`cache.invalidate` 是上述两个管理角色在各自范围内的固定权限，观察者和 CI 默认没有。

内部动作保留 `blob.write` 和 `result.publish`；UI 的“读写”组合为 `cache.read+blob.write+result.publish`。REAPI CAS 上传只需 `blob.write`，AC 更新另需 `result.publish`；Gradle PUT 同时需要上传与发布权限。`trusted-ci` 的发布权限只发给明确授予该 namespace 的服务账号；个人凭据只能读。P0 服务账号凭据不能调用 IAM/策略管理 API，CI 上报单独检查 `event.write`。

每次请求依序执行：认证→确认 active 主体/成员→从可信路由解析 tenant→验证成员或凭据的 tenant→装载同 tenant 资源→求角色、grant、token scope 交集→检查动作、信任域、到期与状态→执行。主体、tenant、project、namespace、credential 和 policy_version 写入服务端构造的 `RequestContext`；忽略或拒绝客户端同名身份头。

列表和单条读取共用强制 `TenantScope` 仓储接口，不提供无 scope 的业务 `findUnique(id)`。查询形式必须是：

```text
WHERE tenant_id = authenticated_scope.tenant_id
  AND project_id IN authorized_projects
  AND (validated_client_filters)
```

客户端 `project_id`、搜索、`OR`、导出条件永远进入最后的括号，不能覆盖前两项。空授权集合就是无结果；不存在、其他 tenant、不可见 project 均返回 404，已可见资源的无权操作返回 403。更新和删除把同样 scope 与 `revision` 放进 SQL 条件，不能先查权限后无 scope 写入。关联查询、聚合、审计、异步 worker 同样适用。平台运维 API 使用独立 `/api/v1/platform` 路径和角色，不能用一个 `isAdmin` 绕过所有租户限制。

## 4. 人会话与原生工具凭据

管理浏览器使用服务端会话，cookie 为 `Secure,HttpOnly,SameSite=Lax`，会话密钥只保存校验值；所有变更验证 CSRF token 和 Origin。P0 本地密码登录，禁用公开注册，默认会话 8 小时；角色在每次管理请求重新求值，移除成员时撤销该租户授权，禁用用户时撤销全部会话。生产缺少会话密钥、token pepper 或可信 TLS 终止配置时启动失败；可由受信 ingress 终止 TLS。P1 OIDC 接入同一 User/Membership，不另建权限系统。

构建工具使用格式 `exp_v1_<credential_uuid>_<random_secret>` 的 opaque key，随机部分至少 256 bit。数据库保存 `HMAC-SHA-256(pepper,完整key)` 和 pepper 版本，比较使用恒定时间实现；pepper 由安装密钥管理，与数据库备份分开。常规响应只返回 key ID/前缀和元数据。禁止日志、URL、localStorage、配置下载文件或审计保存 secret。

| 入口 | 传输及映射 |
|---|---|
| Gradle HTTP | TLS 上 HTTP Basic，固定 username=`expbuild`，password=完整 key；映射同一 credential/principal |
| REAPI/gRPC | metadata `authorization: Bearer <完整key>`；HTTP/2 代理保留 header，不信任代理自报 tenant |
| 管理浏览器 | 会话 cookie；不能拿它调用缓存入口，构建 key 不能冒充浏览器 session |
| 内部数据面 | 独立节点 mTLS 身份；只可调用明确授权的策略、认证和事件接口 |

原生路由固定如下，路径里的 ID 仍需授权检查：

```text
REAPI instance_name:
tenants/{tenant_id}/projects/{project_id}/namespaces/{namespace_id}

Gradle base URL:
/cache/gradle/v1/{tenant_id}/{project_id}/{namespace_id}/
```

同一 key 可以用于两种凭据传输形式，但只能访问其 grant 中匹配协议的 namespace。空 instance_name、缺失租户路径或未知认证方式不能降级为默认公共缓存。native HTTP/gRPC 返回各协议原生状态，不返回下面管理 API 的 JSON envelope。

## 5. 管理 API v1

以下均为拟定契约。租户根路径 `T=/api/v1/tenants/{tenant_id}`；`P=T/projects/{project_id}`；`N=P/namespaces/{namespace_id}`。创建返回 201，读取/更新 200，无响应删除 204，异步操作 202。每个返回对象含 `id,revision,created_at,updated_at`，时间 UTC RFC3339；字节数用十进制字符串，避免 JavaScript 精度丢失。

| 方法与路径 | 请求关键字段 | 响应关键字段 / 授权 |
|---|---|---|
| `POST /api/v1/sessions`；`DELETE /api/v1/sessions/current`；`GET /api/v1/me` | 登录 email/password；退出 CSRF | cookie；用户、可加入 tenant 摘要，不返回 token 或全部 project 对象 |
| `GET T`；`PATCH T` | name；`If-Match` | tenant；仅 admin 可改 |
| `GET/POST T/memberships`；`PATCH/DELETE T/memberships/{id}` | user_id/role；新用户使用单独 join invitation | 成员元数据；admin；移除保护最后管理员 |
| `POST T/invitations`；`POST /api/v1/invitations/accept` | email/role/expiry；一次性 code 和注册信息 | 邀请 secret 仅首次返回；过期、使用或撤销后不可重放 |
| `GET/POST T/teams`；`PUT/DELETE T/teams/{id}/members/{user_id}` | name；成员身份 | 扁平团队；admin |
| `GET/POST T/projects`；`GET/PATCH P` | name/description | project；创建 admin，修改 maintainer |
| `GET/PUT/DELETE P/bindings/{subject_type}/{subject_id}` | 固定 role | project 绑定；admin/maintainer 不得授予超过自己的管理范围 |
| `GET/POST P/namespaces`；`GET/PATCH N` | name/protocol_id/trust_domain；PATCH 仅名称/状态 | namespace 和客户端路由；maintainer |
| `GET/PUT N/policy` | quota、retention、limits；If-Match | revision、authz_epoch、应用状态；maintainer |
| `GET N/grants`；`GET/PUT/DELETE N/grants/{subject_type}/{subject_id}` | actions；subject_type 为 `principal/team` | 具体 namespace grant；只接受同 tenant 合法主体或扁平团队 |
| `GET/POST P/service-accounts`；`PATCH P/service-accounts/{id}` | name/status | 主体 ID、grant 摘要；maintainer |
| `GET/POST T/credentials`；`GET T/credentials/{id}` | principal_id/name/namespace_scopes/expires_at | 元数据；创建首次另含 secret；权限按主体和项目校验 |
| `POST T/credentials/{id}/revoke`；`POST .../{id}/rotate` | revoke reason；rotate overlap_seconds/expires_at | revoked_at/enforcement 状态；rotation 首次另含新 secret |
| `GET N/entries` | writer_token_id/writer_principal_id/time/cursor | 条目元数据、generation、来源；`metadata.read` |
| `POST N/invalidation-previews`；`POST N/invalidations` | selector；preview_id | 预览 operation；失效 operation；`cache.invalidate` |
| `DELETE N`；`GET T/operations/{id}` | If-Match；无任意资源 URL | operation；namespace 拒绝新访问后异步清引用 |
| `GET T/audit-events`；`GET N/usage`；`GET N/onboarding` | 时间、授权范围、分页 | 审计、真实用量及 freshness、无 secret 原生配置模板 |

namespace policy P0 字段：`storage_hard_bytes,object_hard_count,entry_hard_count,max_object_bytes,max_concurrent_uploads,request_rate_limit,download_soft_bytes,entry_ttl_seconds,unreferenced_blob_ttl_seconds,min_retention_seconds`。其中 `object_hard_count` 限制可见 blob 数，`entry_hard_count` 单独限制缓存条目数；分别映射额度账户的 `blob_limit` 和 `entry_limit`。数据面按协议生效；最短保留约束清理顺序，不是保证在空间不足时继续接受写入。硬额度执行参见缓存内核，降低额度至当前用量加预留以下只阻断新的正增量准入并告警，已预留上传可无增量结算，不自动删数据；下载预算必须标注 soft。

凭据创建示例，开发时由 OpenAPI 锁定 schema 和枚举：

```json
{
  "principal_id": "<service-account-uuid>",
  "name": "main-ci",
  "expires_at": "2026-12-01T00:00:00Z",
  "namespace_scopes": [
    {"namespace_id": "<uuid>", "actions": ["cache.read", "blob.write", "result.publish"]}
  ]
}
```

secret 字段仅首次成功创建/轮换返回；其余响应一律无此字段。令牌必须有到期时间，P0 默认 30 天、安装上限 90 天；这是待试点确认的运维默认值。普通开发者只能为自己签发已获准 namespace 的只读凭据；maintainer 只能替本项目服务账号签发，不可替别的人签发。

## 6. 分页、并发、幂等与后台任务

列表统一 `limit=50`、最大 200；游标为服务端签名 opaque 值，绑定 tenant、过滤摘要和 `(created_at,id)` 排序位置。每页重新授权，游标不能保存已被撤销的权限；默认不计算全表 total。指标响应含 `observed_at,window,sample_count,status`，`no_samples/stale/unavailable` 不能转换成 0。

PATCH/PUT/删除要求 `If-Match`，缺失 428、revision 不符 412。创建和异步变更支持 `Idempotency-Key`；记录按 `(tenant,actor,method,path,key)` 唯一，同请求体摘要重试返回原资源/operation，异体重试 409；记录保留至少 24 小时。幂等记录和业务提交在同一事务，且检查当前调用者仍有权限。

角色/grant/凭据签发等敏感变更在事务内锁定 tenant 的授权版本，重验操作者，再写结果与新 epoch；不能用事务外已过期的管理员检查签发权限。删除最后管理员的检查使用同一 tenant 行锁，避免两个并发删除都看到“还有另一位”。

**secret 一次展示例外必须显式处理。** 凭据创建的幂等记录不保存 secret，重复请求只返回已创建的 credential 元数据及 `secret_available:false`，不会重新生成同一凭据或明文重放。若第一次响应丢失，客户端根据返回 ID 撤销该 credential，再用新幂等键新建；UI 显示“密钥无法恢复，撤销并重建”。轮换响应丢失同样撤销新 key 再创建，不提前删除旧 key。轮换默认旧 key 仍有效至明确 overlap 截止点（默认 1 小时、上限 24 小时），API 返回两者 ID 和各自到期时间；确认新 key 可用后可立即撤销旧 key。加入邀请沿用 secret 丢失后撤销重建策略。

错误体固定 `error:{code,message,request_id,details?}`；400 无效输入、401 无效认证、403 动作禁止、404 不可见、409 冲突、412 版本冲突、429 速率限制并带 Retry-After、503 依赖不可用。details 只含安全字段错误，不能包含 SQL、token、外部项目名称或存储密钥。

`Operation` 字段为 `id,tenant_id,kind,status,requested_by,progress,result,error,cancel_requested_at`；状态 `queued/running/succeeded/failed/cancelled`。任务持久化并带租约，支持崩溃重试，worker 使用提交时固定的 tenant scope；每批 destructive 写入前重新验证资源状态和授权，权限撤销则暂停/失败，不借 worker 身份扩大范围。取消仅在批次边界停止，已完成失效不能假装回滚。

namespace 删除先标记 deleting、提升授权版本，再异步失效结果与清理引用；API 显示撤销传播窗口，不能承诺请求受理时所有节点已停止。P0 项目删除要求全部 namespace 完成删除；不实现跨 tenant 的万能批量删除入口。

## 7. 策略分发、断连和长流撤销

P0 采用“版本化快照 + 短期授权 lease”，不把数据库 pepper/verifier 发给数据面。节点证书和允许的 tenant 在部署时预配，自动 enrollment 后置；节点用 mTLS 请求内部接口：

| 内部接口 | 内容与约束 |
|---|---|
| `POST /internal/v1/auth/introspect` | 原始 key 经 TLS 一次提交；控制面校验数据库与当前权限，返回签名 AuthorizationLease；请求日志强制屏蔽 credential |
| `POST /internal/v1/auth/renew` | mTLS 节点提交尚未到期的原签名 lease、active_stream_id 和当前流 namespace/actions；控制面重查当前主体、credential、成员/grant、epoch，再返回不超过当前权限与原 lease 范围交集的新签名 lease；不需要原始 key |
| `GET /internal/v1/policies?after={sequence}` | 带 tenant epoch、签名、issued_at/expires_at 的增量或完整快照；有效期至多 300 秒；乱序、缺口、重启触发全量；通过 HTTPS 每 15 秒轮询，通知只作加速 |
| `POST /internal/v1/policy-acks` | node_id/tenant_id/epoch/applied_at，用于显示传播状态，不能由浏览器上报 |

lease 包含 `lease_id,issuer,audience=node_id,principal_id,credential_id,tenant_id,namespace_scopes,authz_epoch,issued_at,expires_at`，有效期不超过 300 秒且不晚于 key 到期。节点仅以 `HMAC(node_local_key,完整key)` 作为内存缓存索引，绝不缓存明文；验证签名、audience、时钟和 tenant 路由。缓存命中同时要求快照有效且 epoch 相符；初次使用或缓存缺失时控制面断连则拒绝，已有许可只延续到最早的 lease/快照/key 到期。

`renew` 只供节点续接仍活跃的请求，不是通用 token 换发接口。节点通常在原 lease 到期前 30 秒发起，必须在旧授权失效前收到并校验新 lease；控制面校验原签名、node-bound audience、原到期时间及 active scope，再以数据库当前状态重新授权。新 lease 增加 `active_stream_id`，只能用于该流和同一请求的最终 commit，不写回通用认证缓存，不得用来建立新请求或拓宽动作；每次续租仍最多 300 秒，key 撤销/过期、用户退组、namespace 禁用即拒绝。已过期 lease 不能续租；节点重启、流已结束或重新建立 RPC 均须由客户端重新提交 key 走 introspect。签名 lease 是受限敏感凭据，不写日志或磁盘。此机制不从 HMAC 索引还原 key，也不因为持续读取而离线延长授权。

影响授权的角色/成员/团队/grant/key 变更、namespace 禁用与 tenant `authz_epoch++`、审计和 outbox 同事务提交。节点收到更高 epoch 后立刻停止旧 lease 对应的数据访问；新请求重新 introspect，活跃且原租约尚未到期的流可以在线 renew，只有获得当前 epoch 的授权才恢复，否则中断。P0 为简化可失效整个 tenant 的 lease，未来按主体细分。快照包含 namespace 的 protocol、trust、状态、current_policy_version 和资源限制；节点构造上下文并记录该策略版本。快照刷新和持续读取均不得延长旧 lease。节点只加载配置允许的 tenant，节点身份不赋予访问产物的主体权限。

正常连通从控制面提交到撤销目标 ≤60 秒，断连已有授权最长 ≤300 秒；这些是需验收的设计目标。每 5 秒检查活跃上传/下载的 epoch 和租约到期，时钟容差计入窗口内，不附加延长 300 秒。长流未能在到期前完成在线 renew 即中断；续传、新 RPC、上传 commit 都再鉴权，GC read lease 不代替授权 lease。管理 API 返回 `revoked_at,target_online_deadline,hard_lease_deadline,acknowledged_nodes,total_nodes`，避免将数据库已撤销误报为全网已生效。P0 不用对象存储直传 URL，确保可终止活跃流。

## 8. 写入来源和泄露处置

每次发布 entry generation 保存 `writer_principal_id,writer_token_id,policy_version,trust_domain,created_at,invocation_id?`；credential 撤销后保留非秘密 tombstone 供追溯，不级联删掉来源。用户提供的 commit、invocation、分支仅是关联证据，不替代验证过的发布主体；未验证信息在 UI 明确标识。CAS 上传另记上传主体/credential 与可见性授权，不能把 blob 的最初上传人当成所有引用结果的发布人。

撤销 key 只停止今后访问，不自动证明其历史产物不可信，也不自动删除历史结果。处置流程：按 `writer_token_id` 检索→生成预览→显式执行失效→可信 CI 重新预热。预览任务固化获授权范围内的 `(namespace_id,key,generation)` 候选，保存计数、逻辑字节和 selector 摘要，默认 15 分钟过期。执行只失效仍匹配该 generation 的条目；预览后的新版本不被误删。先撤销泄露 key 再预览，可在传播窗口结束后再次扫描遗漏写入。

失效移除结果可见性/根引用，物理 blob 交给引用安全 GC；不能因为一条结果来源可疑就直接删仍被可信结果引用的 CAS。记录操作人、理由、候选数、成功/跳过/失败数和关联 credential ID。P0 提供 API/CLI 和最小状态页，P1 再完善复杂处置界面。

## 9. P0 验收与未决项

- 同 tenant 不同 project、不同 tenant、伪造路由/过滤/游标/关联 ID 全部无法越权；特别覆盖旧 pipeline 过滤覆盖案例。
- 个人 key 无法发布 trusted-ci；CAS 上传权不能更新 AC；项目 maintainer 无法签发其他项目或其他人的 key。
- 创建成功但响应丢失、幂等键冲突、轮换丢响应、撤销后重试、用户退组与团队解绑均有确定状态；响应和日志不出现历史 secret。
- 控制面断连、乱序/丢失快照、节点重启、持续超过 5 分钟的大文件流、续传和 commit 均满足撤销边界；过期 lease/错误节点/错误 active_stream_id 无法 renew，续租不能扩 scope 或创建新请求；离线不匿名放行。
- 按 token 预览后并发覆盖条目，执行不能失效新 generation；异步任务重试不越权、不重复释放额度；审计与变更不会一成一败。

具体补充决策为 UUID 路由、首见 key introspection、租户 epoch、secret 丢响应恢复、显式 namespace grant。相对主架构“默认同租户/同信任域去重”，本阶段收紧为 **namespace 内去重**；这是需要同步更新主规划的取舍，避免 P0 先承担跨 namespace 授权引用和物理共享复杂度。须在 M0 验证 introspection 吞吐/断连体验、15 秒轮询与 60 秒撤销目标、默认 key 期限及团队管理是否满足试点。namespace 改信任域、跨 namespace 共享和管理自动化机器凭据不在 P0 默认能力内。
