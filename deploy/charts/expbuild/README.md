# expbuild Helm Chart

本 Chart 安装管理 API、静态管理界面、Operator、控制台 HTTPS 入口和迁移任务。
企业 PostgreSQL、存储驱动、Ingress Controller、TLS 证书和 Secret 由部署方管理。
缓存实例目前只提供集群内访问；这里的 Ingress 是管理控制台入口，不是缓存域名入口。

## 安装前准备

1. Kubernetes 1.32+，可用的动态 StorageClass，以及支持 NetworkPolicy 的 CNI。
2. 构建并上传三个平台镜像，参见仓库 `images/README.md`。
3. 验证 bazel-remote 镜像和客户端兼容性，取得 SHA256 digest。仓库中的
   `ci-values.yaml` 全部为不可部署的示例镜像，只用于测试模板。
4. 准备 PostgreSQL 数据库和已有的控制面 namespace。建议一个集群运行一个
   expbuild 控制面；当前 Operator 会观察所有受管理项目，不能靠 release 名隔离两套控制面。
5. 给控制面 namespace 添加 `cache.expbuild.io/control-plane=true` 标签。
   控制面访问规则允许该来源，Operator 协议探测依赖它。构建客户端使用下述独立授权规则。
6. 在控制面 namespace 创建以下已有 Secret；通过企业凭据系统提供真实值，
   不要把 Secret 内容写进 Helm values 或 Git：

| 配置 | Secret 数据键 | 用途 |
|---|---|---|
| `secrets.database` | `DATABASE_URL` | API 与 worker 的数据库连接 |
| `secrets.migrationDatabase`（可选） | `DATABASE_URL` | 有 DDL 权限的迁移账号；未指定时使用 database |
| `secrets.operationEncryption` | `OPERATION_ENCRYPTION_KEY` | 32 随机字节的 64 位十六进制表示 |
| `secrets.bootstrap`（可选） | `ADMIN_EMAIL`, `ADMIN_PASSWORD` | 首次初始化管理员，密码至少 12 字符 |
| `ingress.tlsSecret` | `tls.crt`, `tls.key` | 控制台 TLS，类型 kubernetes.io/tls |

数据库迁移和管理员初始化都需要连到同一数据库。备份数据库时必须安全保管操作
加密密钥；有待处理操作时替换密钥会使凭据交接无法解密。

## 配置与安装

复制 `values.yaml` 到部署系统中，设置实际镜像、StorageClass、Secret 名称、
`appOrigin` 和 `ingress.host`。Origin 必须是 `https://` 加域名，且不能有尾随路径。
为私有镜像配置 `imagePullSecrets`。已有 bootstrap Secret 时，可在首次安装设置
`bootstrap.enabled=true`。初始化不会覆盖已有账号，重复账号会让任务报错。

```sh
helm lint deploy/charts/expbuild -f /secure/path/production-values.yaml --strict
helm template expbuild deploy/charts/expbuild \
  --namespace expbuild-system -f /secure/path/production-values.yaml --include-crds
helm upgrade --install expbuild deploy/charts/expbuild \
  --namespace expbuild-system -f /secure/path/production-values.yaml --wait --timeout 10m
```

namespace 与 Secret 必须先存在。安装需要授权集群级 CRD/RBAC。
Chart 将 API 与 Operator 分配到不同 ServiceAccount；Web、迁移和 bootstrap
任务不挂载 Kubernetes token。API 可创建项目 namespace、认证 Secret、
NetworkPolicy 和 CacheInstance；为保留卷清理，API 还可读取/删除 PVC 和列出 Pod，以核对卷引用。Operator 管理实例资源、读取 Secret。

集群角色的授权覆盖整个集群；项目归属标签和 UID 校验由应用层执行，
不是 Kubernetes RBAC 的 namespace 限制。Operator 不能修改 Secret 或删除 PV，
API 不能删除 PV、更新实例 status、创建 StatefulSet 或授予 RBAC 权限；选主权限仅在控制面
namespace 生效。管理页面的 ServiceAccount 没有资源授权且不挂载 token。
测试会在临时 API Server 中验证独立清单与 Helm 清单的允许和拒绝边界，
不会安装到部署方的实际集群。
资源归属还由应用校验，但集群管理员应将控制面视为可信基础设施。

Ingress 把 `/v1` 路由到 API，其他请求路由到 Web，从而保留同源 Cookie 与 CSRF。
关闭 ingress 时，需自行提供同源反向代理；直接只转发 Web 服务无法调用 API。
需要密码防爆破时，应在企业入口补充共享限流，API 当前仅有进程级登录限流。

## 升级与回退

- `pre-install,pre-upgrade` 迁移 Job 在新工作负载启动前运行。失败会中止 Helm
  操作。Migration 使用事务、锁和 checksum，不在每个 API Pod 启动时自动执行。
- Helm 不会自动升级 `crds/` 内已有 CRD。升级前审查新 schema，备份现有 CR，
  再由有权限的管理员应用新 CRD；`make generate` 同步两份 CRD，CI 检查一致性。
- 数据库回退不是 Helm rollback 的一部分。升级前备份 PostgreSQL、密钥及
  Kubernetes 资源，确认旧镜像兼容新数据库。当前没有自动降级 SQL。
- 镜像认证、真实集群滚动升级及故障恢复仍是交付验收项，不能以模板通过代替。

## 卸载与保留数据

先通过管理 API 删除实例，并等待操作完成，再卸载控制面。Retain 实例保留其 PVC；
Delete 实例由运行中的 Operator 执行受控删除。卸载不会删除项目 namespace、实例
CR、PVC、外部 Secret、数据库或 CRD。直接卸载会留下运行中的缓存及无法执行的
finalizer；可用原有密钥、数据库和正确配置重装控制面后继续处理。

## 验证边界

Chart lint、渲染和隔离 API Server 的资源校验在本地/CI 中执行。镜像启动及 Helm/API/WebDAV 的 PVC 生命周期已通过隔离 kind 集群验证；TLS、生产 CSI 和跨版本升级仍待验收。容器 CI 构建并运行检查，不发布镜像。详细记录见 [实施状态](../../../docs/k8s-platform/progress.md)。

## 集群内构建客户端访问

项目初始化会创建 `expbuild-isolation` 和 `expbuild-client-access` 两份 NetworkPolicy。
前者隔离项目 namespace 入站并放行控制面；后者仅允许授权客户端访问项目内标记为
expbuild 管理的缓存 Pod，端口为 TCP 8080（HTTP/WebDAV）、9092（REAPI）。

集群管理员在运行构建任务的 namespace 上设置标签（用实际项目 UUID 替换 `<project-id>`）：

```sh
kubectl label namespace build-runners 'cache.expbuild.io/access-<project-id>=true'
```

构建 Pod 的标签还必须包含：

```yaml
metadata:
  labels:
    cache.expbuild.io/client: "true"
```

如果是 Deployment/Job，应把标签放在 `spec.template.metadata.labels`。
namespace 授权和 Pod 标签必须同时满足。每个项目使用独立的 namespace 标签键，
同一个构建 namespace 可以被管理员授予多个项目访问权。网络授权不替代实例凭据；
客户端仍需提供该实例的用户名和密码。普通用户不应具有更改 namespace 授权标签的权限。

撤销某个 namespace 的项目网络授权：

```sh
kubectl label namespace build-runners 'cache.expbuild.io/access-<project-id>-'
```

撤销何时影响已有连接取决于 CNI；需要立即撤销凭据时还应轮换实例密码。
策略不授予客户端出站权限，客户端所在 namespace 如限制 egress，仍需允许目标缓存端口
以及 DNS 解析。可选 Gateway 模式已支持 TLS 与实例独立域名；部署方准备 DNS、证书和共享入口，详见 [Gateway 配置](../../../docs/k8s-platform/gateway.md)。

升级前创建的项目会在下一次创建实例时补齐客户端策略；只有既有实例且不新建时，
需要部署方补装对应策略（可从新项目已生成策略核对字段，不要直接复制项目身份）。
初始化检查不会覆盖同名的异属或已修改客户端策略，会报告冲突。策略不是持续对账的，
其他额外 NetworkPolicy 也可能扩大允许范围，必须结合集群策略管理。

已验证 SDK 实际请求格式、重复初始化和冲突拒绝。真实客户端连通性、跨项目拒绝和
撤销效果仍需在启用了 NetworkPolicy 的 CNI 上验收。

## 保留卷清理

Retain 删除完成后，在实例详情中查看实际保留卷；管理员输入卷名确认清理。API 将删除请求放入异步队列并记录审计，核对项目、原实例 UID、PVC UID、ownerReferences、CR 是否存在以及所有 Pod 的卷引用。删除使用 PVC UID 与 resourceVersion 前置条件，避免清理同名替换卷。仅在确认 PVC 不存在后完成操作。

这是删除 PVC 声明，不是直接删除 PV 或保证底层数据擦除；实际回收由 StorageClass/PV 策略决定。不要绕过流程手动挂载待清理卷。拥有集群写权限的外部控制器可能并发改动资源，PVC protection 仍可能使清理保持等待直到引用解除。失败后排除原因、重新查询并再次确认。

可在实例详情用原 PVC 重新创建同模板实例；平台先绑定新 CR UID，再让 Operator 转移已验证 PVC 的归属标签。升级已有安装以使用此能力时，必须先按“升级与回退”步骤更新 CacheInstance CRD，新字段不会由 Helm 自动升级。操作、故障恢复和 CSI 限制见[保留卷领回](../../../docs/k8s-platform/retained-volume-reclaim.md)。

## 实例独立域名

可选 `gateway.enabled` 将实例路由接入部署方已有的 Gateway API HTTPS 监听器。必须提供完整 gateway 配置、DNS、证书和带授权标签的数据面 Pod；默认关闭。Operator 拥有实例 HTTPRoute/GRPCRoute/入口 NetworkPolicy 的管理权限及 Gateway 只读权限，不可修改 Gateway 或证书。清理权限不随功能关闭而移除，避免已有实例无法撤销路由。详见 [入口配置与未完成认证](../../../docs/k8s-platform/gateway.md)。
