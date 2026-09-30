# bazel-remote 引擎验证记录

当前候选引擎：[官方 bazel-remote v2.6.2](https://github.com/buchgr/bazel-remote/releases/tag/v2.6.2)。
已在 Linux amd64 上运行校验过发布摘要的官方二进制，并完成真实协议测试。
原生协议测试与下文的隔离 Kubernetes 镜像验证分别记录，不代表生产环境认证。

## 可复现入口

```sh
python3 tools/download_bazel_remote.py /tmp/expbuild-bazel-remote
cd operator
BAZEL_REMOTE_BIN=/tmp/expbuild-bazel-remote go test ./internal/controller -run TestRealBazelRemoteContract -count=1 -v
```

下载工具固定版本并检查官方发布资产 SHA256；不会自动采用 latest。
测试使用 Operator 渲染出来的配置，仅把存储目录、认证文件路径和监听地址改为
临时目录与本机随机端口。进程在测试结束时停止，不使用现有服务或集群。
未指定二进制时，该测试明确跳过。本地与[远程 Kubernetes CI](https://github.com/expbuild/expbuild/actions/runs/36668365993)均已通过该原生引擎测试；容器与 Gateway 链路单独验收。

## 已通过的行为

- 原生配置格式启动，配置的 1 GiB 缓存预算与认证探测匹配。
- bcryptjs 生成的 htpasswd 可用于 HTTP Basic 和 gRPC Basic 认证。
- 未认证 HTTP 读写与 REAPI FindMissingBlobs 被拒绝。
- HTTP CAS 按 SHA256 路径上传/下载，读取内容与原始数据一致。
- 同一 digest 上传前被 FindMissingBlobs 返回，上传后不再缺失。
- 使用新的认证文件重启后，旧用户被拒绝，新用户能读取此前存储的数据。

FindMissingBlobs 测试使用官方 [REAPI protobuf 字段定义](https://github.com/bazelbuild/remote-apis/blob/main/build/bazel/remote/execution/v2/remote_execution.proto)，
直接构造 wire message；这验证该 RPC 的真实行为，不代表完整 Bazel 客户端验收。

## 已通过的 Kubernetes 与 TLS 链路

[真实 kind/Helm/Gateway CI](https://github.com/expbuild/expbuild/actions/runs/36669207282)已通过固定镜像
`buchgr/bazel-remote-cache:v2.6.2@sha256:8109f1f39eb17d898cf51e08b41e4eabaaaeb1f584c2f22c1be45b7568fcc512`。

- 经管理 API 创建实例，Operator 启动非 root UID/GID/fsGroup 1000、只读根文件系统的 StatefulSet，使用真实 PVC 和独立临时卷。
- 受信任 TLS/SNI 下 GetCapabilities、FindMissingBlobs、8 MiB ByteStream 分块上传/下载，以及 HTTPS CAS 上传/下载。
- 匿名访问被拒绝；通过管理 API 轮换凭据并滚动更新后，旧密码被拒绝，新密码通过 gRPC/HTTP 读取原数据。
- 删除实例后清理 HTTPRoute 与 GRPCRoute。

这是 Linux amd64、kind 默认存储与固定 Envoy Gateway 的验证，不涵盖所有架构、生产 CSI 或真实 Bazel 构建客户端。

## 仍需完成

- 多架构、生产 PVC 权限、磁盘满、故障恢复和单写者边界。
- 真实 Bazel 客户端、ActionCache、压缩及 FindMissing 批量负载。
- 淘汰策略边界、存储容量变化、指标与平台统计的一致性。
- 公网 DNS、实际网络策略隔离、轮换期间并发客户端行为与性能基线。

测试不将已通过的 RPC 扩大为完整性能或生产可用性结论。
