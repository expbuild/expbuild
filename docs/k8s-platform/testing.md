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

测试通过端口转发访问服务，不证明 Ingress、DNS 或 TLS 可用。kind 默认网络不提供本项目网络策略的隔离验收；该门槛需要单独在启用策略执行的 CNI 上验证。测试数据库是临时存储，也不证明数据库备份、恢复或高可用。测试卸载前先删除缓存实例，不能据此假定 Helm 卸载会自动清理所有项目工作负载。
