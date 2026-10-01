# 保留卷领回

项目管理员在实例删除且 PVC 按 `Retain` 留下后，可在实例详情选择“使用保留卷恢复实例”。表单沿用原模板版本，要求输入新的运行资源、缓存预算和删除策略；卷本身、命名空间与存储类不切换。`GET /v1/projects/{projectId}/instances/{instanceId}/retained-volume` 返回 PVC UID、请求容量和已分配容量。提交 `POST /v1/projects/{projectId}/instances/{instanceId}/retained-volume/reclaim` 时，以该 PVC UID 作为 `If-Match`，另附新的 `Idempotency-Key` 和完整实例配置。新密码只在首次受理响应中返回。

管理 API 核对项目权限、旧实例绑定、模板版本、PVC 的项目/实例/旧 CR UID 标签、存储类、Bound 状态及容量下界，在项目事务中重新检查绑定并预留实例数、CPU、内存和存储。校验失败不排队，也不释放已有存储预留。worker 用同一实例 ID 创建新 CR 和独立凭据。CR 的 `storage.reclaim` 固定旧 CR UID 与 PVC UID，Kubernetes admission 拒绝后续修改。创建响应丢失时 worker 只认领具有相同操作 ID、请求哈希和完整配置的现存 CR。

Operator 最初只报告 `VolumeReclaimPending`，不会移动 PVC 归属或创建工作负载。worker 把新 CR UID 持久化到绑定后，才给该 CR 写 `reclaim-bound-uid` 标记。Operator 随后重新核对 PVC UID、原归属、项目/实例标签、存储类、访问模式、请求与已分配容量、删除状态、ownerReference 和所有 Pod 引用，以 resourceVersion 乐观锁转移 PVC 的实例 UID 标签。重试识别同一新 UID，拒绝同名替换卷和不匹配的转移。新实例就绪后，旧凭据被清理，绑定恢复 active；再次选择 Retain 删除时，新 CR UID 成为下一次保留卷的归属。

失败操作保留资源预留。已有新 CR 的失败可经操作重试入口继续检查，不重建 CR 或重发已清除的密码；若 CR 不存在且 PVC 仍归属原 UID，可在核对卷后发起新的领回请求。若外部删除了已转移的 CR，资源对账会报告异常，需人工处理。平台不承诺任意 CSI 下的跨节点 fencing、底层 PV 数据擦除或不同引擎间迁移。真实 kind 的读写保留验收已写入隔离集群脚本，结果以相应 CI 为准。
