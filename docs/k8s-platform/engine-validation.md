# bazel-remote 引擎验证记录

当前候选引擎：[官方 bazel-remote v2.6.2](https://github.com/buchgr/bazel-remote/releases/tag/v2.6.2)。
已在 Linux amd64 上运行校验过发布摘要的官方二进制，并完成真实协议测试。
这不是镜像或 Kubernetes 部署认证。

## 可复现入口

```sh
python3 tools/download_bazel_remote.py /tmp/expbuild-bazel-remote
cd operator
BAZEL_REMOTE_BIN=/tmp/expbuild-bazel-remote go test ./internal/controller -run TestRealBazelRemoteContract -count=1 -v
```

下载工具固定版本并检查官方发布资产 SHA256；不会自动采用 latest。
测试使用 Operator 渲染出来的配置，仅把存储目录、认证文件路径和监听地址改为
临时目录与本机随机端口。进程在测试结束时停止，不使用现有服务或集群。
未指定二进制时，该测试明确跳过。CI 已加入下载与执行步骤，本地执行已通过；
尚未推送仓库，因此不声称远程 CI 已运行。

## 已通过的行为

- 原生配置格式启动，配置的 1 GiB 缓存预算与认证探测匹配。
- bcryptjs 生成的 htpasswd 可用于 HTTP Basic 和 gRPC Basic 认证。
- 未认证 HTTP 读写与 REAPI FindMissingBlobs 被拒绝。
- HTTP CAS 按 SHA256 路径上传/下载，读取内容与原始数据一致。
- 同一 digest 上传前被 FindMissingBlobs 返回，上传后不再缺失。
- 使用新的认证文件重启后，旧用户被拒绝，新用户能读取此前存储的数据。

FindMissingBlobs 测试使用官方 [REAPI protobuf 字段定义](https://github.com/bazelbuild/remote-apis/blob/main/build/bazel/remote/execution/v2/remote_execution.proto)，
直接构造 wire message；这验证该 RPC 的真实行为，不代表完整 Bazel 客户端验收。

## 仍需完成

- 发布并固定容器镜像 digest；验证多架构、非 root UID、PVC 权限和磁盘满行为。
- 实际 Kubernetes StatefulSet 更新、凭据轮换、故障恢复和单写者约束。
- 真实 Bazel 客户端、ActionCache、ByteStream、大 blob、压缩及 FindMissing 批量负载。
- 淘汰策略边界、存储容量变化、指标与平台统计的一致性。
- 入口 TLS/独立域名、真实认证轮换期间客户端行为。

测试没有模拟这些结果，也不将已通过的少量 RPC 扩大为完整性能或生产可用性结论。
