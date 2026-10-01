# 项目资源配额

平台管理员在项目页面点击“查看项目配额”，可配置实例数、存储 GiB、CPU 毫核和内存 MiB 上限。项目成员可查看，普通项目管理员不能提高自己的配额。留空表示不限，0 表示不允许占用。已有项目默认不限；API 使用独立配额 revision 和 If-Match 防止覆盖其他管理员的修改，调整写入审计记录。

`GET /v1/projects/{projectId}/quota` 返回 limits、reserved、unknownReservations 和 revision，以及 synchronization 同步状态。`PUT` 接受四个同名字段：instances、storageGiB、cpuMillis、memoryMiB，整数或 null。界面按需读取，操作完成后可刷新预留数。这里展示配置预留，不是采样得到的实际 CPU/内存用量，也不是存储物理占用。

## 计费与释放边界

- 新建实例和更新配置在与操作入队相同的 PostgreSQL 事务中预留额度；项目行锁串行化并发受理。配额不足返回 409，整个事务回滚；幂等重放不重复预留。
- 更新暂时取旧值与目标值的较大值。成功且确认当前配置生效后才结算 CPU、内存降低量；存储不缩小。暂停仍保留全部额度，避免恢复时无法兑现配置。
- 创建、更新失败可能已经产生资源，继续占用预留。删除请求受理不释放额度；worker 确认删除完成后，Delete 释放全部，Retain 释放实例数、CPU 和内存但继续占用存储。保留卷清理完成后释放存储。
- 不能将上限设为低于当前预留。失败操作和保留卷可能阻止新建，需先恢复或完成清理。
- 升级时按历史操作中配置的最大值回填，包含失败操作，以免低估部分成功的扩容。无法回填的非删除记录计入 unknownReservations，此时禁止启用限制；不能把未知数当零。已有成功更新可以结算可识别资源，异常遗留记录仍需资源对账。

## Kubernetes 硬限制

后台持续将四类上限映射到项目 namespace 的 `expbuild-resources` ResourceQuota：实例数对应 `count/cacheinstances.cache.expbuild.io`，存储对应 `requests.storage`，CPU/内存同时约束 requests 和 limits。Kubernetes 对资源超额的准入限制见[官方 ResourceQuota 文档](https://kubernetes.io/docs/concepts/policy/resource-quotas/)。这仍是配置额度，不是磁盘实际写入量；收紧上限不驱逐已有工作负载。

资源归属、UID/resourceVersion、无 scope 限定和单调版本均被检查，外部同名对象或不兼容 scope 不会被接管。数量按 Kubernetes 等价值比较，`1000m` 与 `1` 不引起重复更新。全部上限取消时，只删除确认属于本项目的配额，并在之后确认不存在。

后台在项目行锁内同步，副本间用 SKIP LOCKED 分工。成功后约 30 秒复查，未完成或失败约 2 秒重试；单次 Kubernetes 请求有超时。实例创建、修改和轮换在执行前重新核对当前配额；未就绪则保持异步操作等待。删除、保留卷清理不被此门槛阻断。持续故障仍受操作总截止时间约束，修复后可按原机制重试。

接口与界面区分配额保存和集群同步。只有 ResourceQuota 的 spec 与 status.hard 匹配且所有计数项已初始化，才报告当前 revision 为 Applied；失败撤回已观测版本并返回安全错误码。Applied 是最近一次观察，checkedAt 提供时间，不代表之后永远没有外部变更。项目行锁跨越有超时的 Kubernetes 请求，同一项目提交可能等待；大规模场景的性能仍待压测。

直接创建 Pod 也必须提供受到配额约束的资源 requests/limits；附加 sidecar、RuntimeClass overhead 和项目内其他工作负载都会影响真实集群用量。数据库预留只记录平台实例，不自动把这些外部消耗转为平台预留；真实 Kubernetes 准入仍会拒绝超额，但操作可能等待或失败，后续需要资源对账。平台管理员以外的项目成员应保持只通过管理 API 操作。

## 验证边界

独立 PostgreSQL 数据库测试覆盖并发受理、幂等、版本冲突、四个维度、保留卷、历史回填、多副本同步、错误恢复和删除绕过同步门槛。实际 Kubernetes SDK 通过本地 HTTP 服务验证请求序列、数量归一化、归属拒绝与带版本删除；这些不是实际配额准入测试。

隔离 Helm/API 场景已加入真实 ResourceQuota 同步，分别以 server dry-run 尝试直接创建超额 CR、PVC、CPU Pod、内存 Pod，要求 Kubernetes 返回 exceeded quota。结果待 CI。硬配额生产规模、集群管理员外部修改、额外工作负载与资源对账仍待进一步验证。

新增 CRD 的配额计数可能先只有内置资源 used，暂缺 CR 的 count 项。平台继续保持 Pending，不把缺失值当零；固定 Kubernetes 1.32 的测试为首次计数初始化预留七分钟，覆盖[该版本默认五分钟的配额重同步周期](https://github.com/kubernetes/kubernetes/blob/v1.32.0/pkg/controller/resourcequota/config/v1alpha1/defaults.go)。每次 Kubernetes 请求仍有独立超时，资源操作仍受整体截止时间约束。
