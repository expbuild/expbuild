# 实例镜像绑定与首次信任迁移

基线 `7c7e461f95ef48dd1baf6b13c8cf96423e5a827f` 存在隐式镜像升级路径：
`templates.Resolve` 按引擎名读取安装级镜像，调谐覆盖已有 StatefulSet pod template。
只改变安装 digest，不改变 CR spec、generation 或 templateRef，也会改写存量工作负载。
WebDAV 0.2 的 statistics 镜像还与 Operator 镜像耦合。六个 fake-client 复现场景已证明
模板发生变化；没有把它等同于真实滚动、服务中断或数据损坏。

本次实现选择 **A：持久镜像绑定**。templateRef 继续声明编译内置的能力契约；
同一模板可绑定不同的管理员批准构建。没有增加用户自选镜像、动态 SDK 或升级操作。

## 信任与行为

- 新建 CR 显式携带 `spec.imageBindingMode: PinnedV1`，没有 CRD 默认值，创建后不可添加、删除或修改。
  API 新建和示例清单携带此标记；更新保持原标记或缺省状态，兼容旧队列中的更新。
  无标记的 CR 属于遗留实例；generation 为 1 不能证明它是新实例。
- Operator 先通过乐观并发写入并重新读取 `status.imageBinding`，确认持久化后才创建运行资源。
  记录格式、CR UID、精确 templateRef 和完整容器 digest 集合；CRD CEL 禁止改写或删除记录，
  包括清空整个 status。旧 CRD 若裁剪此字段，调谐阻断并报告 `ImageBindingPersistenceRequired`。
- 遗留实例只在 StatefulSet 和已有 Pod 的完整镜像集合均严格匹配当前管理员批准值时自动接纳。
  校验 namespace、项目、实例标签、controller kind/name/API version/UID；检查实际 Pod spec，
  拒绝额外 sidecar、init/ephemeral container、其他卷使用者以及旧 StatefulSet UID 的残留 Pod。
  不通过条件仅更新状态/Warning event，不主动停止或删除运行资源。
- 遗留工作负载缺失报告 `LegacyWorkloadMissing`；未绑定的新标记 CR 若已经存在 PVC，报告
  `ImageRecoveryRequired`。均不使用当前默认值猜测历史镜像。
- 已绑定实例的渲染、重启和 StatefulSet 丢失后的恢复使用持久记录，即使安装默认值改变或禁用。
  发现模板或 Pod 镜像漂移时阻断；在 StatefulSet 的乐观写入边界再次检查镜像，拒绝覆盖并发修改。
  Kubernetes 多对象读取不是原子事务：此检查不替代限制直接写入 Pod/StatefulSet 的集群权限。
- WebDAV 0.2 绑定 `cache` 和 `statistics`；其他现有模板绑定 `cache`。
  Helm 的 `images.webdavStats` / Operator 的 `--webdav-stats-image` 是独立、必须经过批准的 digest。
  升级控制器镜像不再隐式更换 statistics。开启 WebDAV 时 chart 要求此值。
- 配置、资源和凭据轮换继续工作并保留镜像绑定。显式暂停只把精确归属的 StatefulSet 缩到 0，
  不重写 pod template，即使旧实例无法迁移或凭据丢失也允许停止。删除路径先于绑定校验执行。

`status.imageBinding` 是信任记录，不能把它当成可随意清空重建的普通观测缓存。
现有 RBAC 仅 Operator 可写 status；API 无权修改 status、PVC metadata 或 ConfigMap。
不新增 RBAC 权限。防护依赖 CRD 和可信控制面，不能抵御集群管理员移除 CEL、扩大权限或篡改备份。
Pod spec 的 digest 核对也不是运行时字节证明；真实验收仍须记录 kubelet imageID 和镜像平台摘要。

## Retain 与恢复

Retain 删除会在停止实例 Pod 后保存 ownerless、immutable ConfigMap，包含完整绑定、
namespace/project/instance、原 CR UID 和 PVC UID；PVC annotation 同时固定该记录的名称及 UID。
这使记录独立于原 CR 的垃圾回收。恢复必须同时通过原有卷转移授权和镜像记录校验。
记录缺失、被同名替换、身份不符或模板未知时，不用当前默认镜像恢复。

未绑定或模板已漂移的实例仍能完成显式 Retain 删除，但不产生可信恢复记录；
后续自动领回会被拒绝，需要管理员先验证数据与历史镜像。不可把未知状态“修复”为当前默认值。
Delete 语义继续遵循原有显式卷删除策略。已保留镜像记录不自动垃圾回收：确认对应 PVC
及备份恢复需求已消失后，由管理员清理；API 不能删除这些信任记录。

## 验证

```sh
cd operator
HELM_BIN=/path/to/helm go test ./... -count=1
make check build
go test -race ./...
```

回归覆盖六种引擎/历史版本/sidecar 场景的旧实例保持 A、新实例采用 B；
绑定冲突、旧 CRD 裁剪、重启、删除重建、运行 Pod 漂移及身份、严格遗留接纳、
凭据和资源修改、暂停/删除、Retain 恢复和篡改拒绝。
原来断言隐式升级的测试已反转为安全行为断言。

CRD 测试调用 Kubernetes v0.32.1 的完整 CRD admission 校验（包括静态 CEL 成本），
JSON schema 对象校验以及真实 CEL 求值；fake client 不会执行 admission。
envtest 另行覆盖实际 `/status` 不可变性、创建标记和部署 RBAC。
本机全 Go、race、vet/fmt/build、Helm 3.17.3 lint/渲染，以及 API/Web build 和回归通过。
API 的三项监控后端测试及 Go 的六项外部环境测试明确跳过；未把离线 admission 当成真实 API server。

## 发布与恢复验收顺序

1. 在隔离环境备份数据库、密钥、CR 全对象（包括 status）、PVC metadata 和恢复记录。
   冻结实例创建/修改并停止旧 Operator 调谐；保持原引擎 digest，单独确定 WebDAV stats 的批准 digest。
   若遗留实例仍使用 mutable tag，不能从“当前 tag 指向”反推历史镜像，必须另行人工验证。
2. 先由有权限的管理员应用新 CRD，再更新 Operator/API/Chart。Helm 不会自动升级 `crds/` 中的对象。
   没有创建标记的旧队列创建操作会安全阻断，需在切换前排空或按管理员流程重提。
   逐个核验 `ImagesBound=True`、持久记录与实际 StatefulSet/Pod；迁移失败不得更改默认值蒙混通过。
3. 在一次性 kind 上用两个真实批准 digest A/B：写 fixture 数据 → 接纳 A → 默认值改 B →
   旧实例仍 A、新实例 B → 凭据轮换 → 删除 workload 重建 → Retain 删除和领回 → 数据与原生客户端校验。
   记录 imageID、revision、Pod UID、服务就绪时间及数据哈希。现有 lifecycle 脚本从 kind 中已加载的
   Operator 镜像建立本地 digest 引用作为 stats，不发布镜像。
4. 回退必须继续运行理解并遵守绑定的 Operator。旧版 Operator 会忽略此记录，因此不能直接
   `helm rollback` 到基线版本；先停止调谐并审查恢复方案。没有提供绕过不可变绑定的通用升级流程。

真实本机 API server 的最小缺项是官方 controller-runtime `setup-envtest`
`v0.0.0-20250517180713-32e5e9e948a5` 及其 Kubernetes **1.32.0 darwin/arm64** 资产
（kube-apiserver、etcd、kubectl），需要任务目录下载/执行和本机临时端口权限。
一次性 kind 生命周期另需固定 **kubectl v1.32.2 darwin/arm64**；kind v0.27.0、Helm v3.17.3
及已有本地镜像可复用。未在未授权时补装这些工具。仓库 CI 已提供上述 Linux 测试路径。
生产 CSI、备份恢复、批准 A/B 镜像及真实试点仍是后续条件，本次不声称生产升级认证完成。
