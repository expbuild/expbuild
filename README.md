# expbuild

基于 Kubernetes 的企业自托管缓存服务管理平台，当前处于架构重构和实现阶段。
为团队快速创建独立缓存实例，统一管理资源、访问凭据、运行状态和淘汰策略。

已接入 bazel-remote（REAPI / Bazel HTTP）和 Apache WebDAV 模板。历史统计、
更多策略和实例域名入口仍在开发。当前方案不提供远程执行服务。

## 组成

| 目录 | 用途 |
|---|---|
| `apps/admin-web` | React / TypeScript 管理控制台 |
| `apps/admin-api` | 管理 API、PostgreSQL、身份权限、异步操作队列 |
| `operator` | Go Kubernetes Operator、CacheInstance CRD、实例调谐 |
| `images` | 平台容器构建定义 |
| `deploy/charts/expbuild` | Helm 安装、迁移任务、RBAC 与控制台 HTTPS 入口 |
| `docs/k8s-platform` | 实现方案和已验证进度 |

管理 API 在 PostgreSQL 中记录项目成员、实例归属、操作与审计；实例期望配置保存在
Kubernetes CacheInstance 中。Operator 将配置落实为 StatefulSet、独立 PVC、
Service 和认证配置。缓存请求直接访问引擎，不经过管理 API。

## 开发

需要 Node 22+、Go 1.23+、PostgreSQL；完整联调还需要 Kubernetes、动态存储和
经过认证的引擎镜像。仓库 CI 使用 Node 24 和 Go 1.27.1。

```sh
npm ci
npm run build
npm test
```

数据库测试需设置 `TEST_DATABASE_URL`，未设置时明确跳过。Operator 测试在
`operator` 目录运行 `go test ./...`；真实 API 测试需设置 `KUBEBUILDER_ASSETS`，
Chart 资源测试还需设置 `HELM_BIN`。

- [管理 API 配置与运行](apps/admin-api/README.md)
- [管理界面开发](apps/admin-web/README.md)
- [Operator 开发和测试](operator/README.md)
- [容器构建](images/README.md)
- [Helm 安装、升级和卸载](deploy/charts/expbuild/README.md)
- [完整实现方案](docs/k8s-platform/implementation-plan.md)
- [实际进度与验证边界](docs/k8s-platform/progress.md)

目前的测试覆盖管理 API、界面组件、调谐器、协议探测及隔离 API Server。
尚未完成真实缓存容器、PVC、TLS 和完整集群故障恢复验收，不能作为生产就绪声明。

旧 Rust 远程执行实现、配置和测试已移除，可通过 Git 历史查阅。
`docs/research`、`docs/design` 和 `docs/strategy` 保留前期研究与备选方案；
当前开发以 `docs/k8s-platform/implementation-plan.md` 和实际进度文档为准。
