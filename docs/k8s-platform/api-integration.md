# 管理 API 接入

[OpenAPI 3.1 JSON](openapi.json) 描述当前实现。已登录的客户端也可读取
`GET /v1/openapi.json`。文档入口需要会话；下载好的静态文档不包含任何实例密码或用户数据。

## 会话和请求保护

1. POST `/v1/auth/login`，提供邮箱、密码，并携带与部署 `APP_ORIGIN` 完全一致的
   Origin。保存返回的 `expbuild_session` cookie 和 `csrfToken`。
2. 后续请求带 cookie；写请求还要带 Origin 与 `x-csrf-token`。不要把密码、cookie
   或 CSRF token 放到 URL、日志或项目配置文件中。
3. GET `/v1/auth/me` 检查会话。401 表示需重新登录；修改/重置密码会撤销所有相关会话。
4. 当前没有机器账号/API Token/OIDC 接入，自动化客户端使用现有会话机制时应由
   企业凭据系统托管账号。后续独立凭据能力不应由浏览器 cookie 猜测实现。

## 异步实例操作

- 创建实例前等待项目初始化为 ready；项目初始化失败可由管理员调用项目 retry。
- 实例创建、更新、删除和缓存凭据轮换返回 202 与 operation.id。
- 同一次请求的重试使用相同 `Idempotency-Key` 和相同输入；改变输入必须换新键。
  同一实例同时只接受一个活动操作。
- 更新实例与轮换凭据先读取实例，保存 ETag，并将其传入 `If-Match`。409 时先读取
  新状态，重新判断操作，不应自动覆盖。PATCH 当前要求完整配置对象，不是 JSON Patch。
- 轮询项目 operation 详情直到 succeeded、failed 或 superseded。状态还在 reconciling
  不代表已经失败。失败可能发生在 Kubernetes 已接受配置之后，不承诺自动回退。
- 创建项目暂不支持客户端幂等键。创建响应不确定时先查询项目列表，避免盲目重试。

连接密码仅在首次成功接受创建/轮换请求时返回，并且只向管理员提供。幂等重放不会
重新返回密码。丢失密码响应时等待操作结束，再由管理员轮换。凭据不会出现在操作
查询、审计、统计或接口文档响应中。

## 状态和统计

数据库实例 lifecycle 与引擎 Ready 条件不是同一概念。读取详情时应同时考虑
revision、spec、status 和 observedAt。统计为当前引擎快照；不存在或采集失败时
返回错误，客户端不能显示为零命中/零用量。历史趋势和命中率尚未提供。

列表目前有固定上限：用户/项目/实例最多 200 条，操作/审计最多 100 条；不提供分页参数。
项目成员列表没有固定分页。普通账号只可访问其项目，平台管理员可跨项目访问。
不可访问的项目统一返回 404，避免枚举其他团队资源。

## 维护契约

源文件为 `apps/admin-api/src/openapi.ts`。实例输入 schema 从实际 Zod 校验模型导出；
跨字段限制仍以描述和服务端校验为准。修改路由后运行测试并重新生成静态 JSON：

```sh
npm run --silent openapi --workspace @expbuild/admin-api > docs/k8s-platform/openapi.json
npm test --workspace @expbuild/admin-api
```

测试检查标准规范、现有路由覆盖、路径参数、引用、输入默认值与访问控制。
Kubernetes spec/status 仍按开放对象描述，精确字段以受版本控制的 CacheInstance CRD
为准；因此该文档尚不代表已有自动生成并经过真实集群验收的 SDK。

## 恢复等待就绪超时的实例操作

项目管理员可以调用 `POST /v1/projects/{projectId}/operations/{operationId}/retry`，
携带会话、Origin、CSRF 和新的 `Idempotency-Key`。只接受已失败且已绑定目标
Kubernetes generation 的 create/update/rotate 操作；它继续原操作的就绪检查，
不会重新创建资源、重发配置或重新生成密码，返回 202 和原操作 ID。

同一幂等键再次调用只返回当前操作状态，即使该操作又失败，也不会再次启动。
再次主动重试需要新键。实例存在后续操作、已删除/删除中、未绑定 UID 或目标版本时
返回 409。worker 仍验证原 UID、generation 和操作标识，资源被替换时拒绝继续。
重试重置 20 分钟等待期限，旧错误保存在 `operation.retry` 审计中。

当前不涵盖未绑定资源的创建失败、删除失败或凭据已失效的修复，也不自动回滚配置。
这些情况仍需后续专门恢复流程；管理界面重试入口尚待接入。
