# 测试层次与复现

各层验证范围不同，最新实际结果见 [实施状态](progress.md)。测试通过不代表全部产品能力已完成。

| 层次 | 验证范围 | 不覆盖 |
| --- | --- | --- |
| Go 单元测试、fake client | 配置渲染、归属检查、调谐状态机、失败分支 | 真实 API、调度和容器运行 |
| envtest | 独立 API Server/etcd、CRD、RBAC、generation/status、资源调谐 | kubelet、PVC 供应和网络 |
| API/PostgreSQL | 真实数据库事务、授权、幂等、worker 恢复；模拟 Kubernetes | 实际集群权限和工作负载 |
| React 组件测试 | 权限界面、表单、确认、错误、一次性凭据 | 真实浏览器完整交互 |
| 原生引擎与容器检查 | 实际协议、认证、镜像入口、非 root/只读根文件系统 | 完整 Kubernetes 生命周期 |
| 隔离 kind Operator 测试 | StatefulSet/PVC、重建、暂停恢复、凭据、选主、Retain/Delete | 管理 API、Helm、生产 CSI |
| 隔离 kind Helm/API 测试 | Chart 安装/迁移/bootstrap/升级/卸载，公开 API 到真实实例的链路 | TLS 入口、网络隔离、REAPI 客户端、浏览器 |

## 隔离集群测试

对应工作流 `.github/workflows/cluster.yml`，每项测试创建唯一命名的 kind 集群，并始终显式使用临时 kubeconfig/context。正常完成或异常退出时仅删除该测试集群。不会读取默认 kubeconfig，也不会发布镜像。

本机复现需要 Docker、Python 3、kind v0.27.0、kubectl v1.32.2；Helm 测试还需要 Helm v3.17.3。脚本固定 kind 节点镜像摘要，WebDAV 使用固定摘要的 Apache 镜像及 Operator 渲染的实际配置。

从仓库根目录执行：

```sh
docker build -f images/operator/Dockerfile -t expbuild/operator:test .
python3 tools/cluster_lifecycle.py
```

完整控制面测试还需要本地构建另外两个镜像：

```sh
docker build -f images/admin-api/Dockerfile -t expbuild/admin-api:test .
docker build -f images/admin-web/Dockerfile -t expbuild/admin-web:test .
python3 tools/helm_lifecycle.py
```

Helm 测试在临时集群中启动独立 PostgreSQL，不使用外部数据库。使用真实 Chart 的迁移和管理员初始化 Job，通过登录/会话/CSRF 调用项目与实例 API，等待异步操作完成，再验证数据读写、暂停恢复和密码轮换。升级后检查数据仍可读，随后通过 API 删除实例并检查 PVC、凭据清理。另创建 Retain 实例，在删除实例后查询保留 PVC，再通过独立的清理接口确认删除，最后卸载 Helm release。

测试凭据仅用于一次性集群。请求失败时仅输出操作路径、状态或错误码，不输出创建和轮换响应中的明文密码。诊断输出包含工作负载状态、事件和服务日志，不打印 Secret 数据。

默认内部模式通过端口转发访问服务，不证明 Ingress、DNS 或 TLS 可用；下文 Gateway 模式另行验证实际 TLS 代理。kind 默认网络不提供本项目网络策略的隔离验收；该门槛需要单独在启用策略执行的 CNI 上验证。测试数据库是临时存储，也不证明数据库备份、恢复或高可用。测试卸载前先删除缓存实例，不能据此假定 Helm 卸载会自动清理所有项目工作负载。

## 真实 Gateway 数据面测试

Gateway 模式还需要 Go 与 OpenSSL。`python3 tools/helm_lifecycle.py --gateway` 在相同的隔离集群中安装 Envoy Gateway v1.8.5，校验 Chart 压缩包 SHA256，控制器和 Envoy v1.38.4 代理均固定镜像摘要。脚本生成短期测试 CA 和通配叶证书；通过 Gateway Service 的本地端口转发访问真实 TLS 监听器，客户端仍验证实际 hostname/SNI 与证书信任，不使用跳过证书验证选项。

WebDAV 检查包括匿名拒绝、错误 hostname/不受信任 CA 拒绝、16 MiB PUT/GET、PROPFIND、LOCK 和受锁约束的 DELETE、暂停恢复、凭据轮换以及实例删除后的入口撤销。故意拒绝 TLS 的测试独立使用端口转发会话，避免 kubectl 在连接重置后退出影响后续测试。

同一任务再创建固定镜像摘要的 bazel-remote v2.6.2 实例。Go 合约客户端通过受信任 TLS 和 gRPC authority 验证 capabilities、FindMissingBlobs、8 MiB ByteStream 分块上传/下载、匿名和旧密码拒绝，并在凭据滚动更新后读取原数据。它使用标准 protobuf 字段构造 wire message，不代表完整 Bazel 构建客户端、ActionCache 或压缩协议已经认证。凭据通过权限 0600 的临时文件交接，调用后删除，不出现在命令行参数或日志中。

该测试没有公网 DNS、外部负载均衡器或执行 NetworkPolicy 的 CNI，因而不证明这些设施可用。实际通过状态与失败记录见 [实施状态](progress.md)。
