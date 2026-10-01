# 独立域名入口（Gateway API）

状态：适配代码、API Server 契约及固定 Envoy Gateway 的隔离集群协议验收已通过。默认关闭；生产部署仍需验证 DNS、入口负载均衡、CNI 与存储环境。

## 资源与职责

部署方安装 Gateway API Standard CRD（代码契约固定 v1.2.1）、兼容 HTTPRoute/GRPCRoute 的控制器，并管理共享 Gateway、DNS 和 TLS 证书。expbuild Operator 仅创建实例所在 namespace 的路由和最小 NetworkPolicy，不创建或修改共享 Gateway、证书、DNS、GatewayClass。

实例访问方式可选 `ClusterInternal` 或 `Gateway`。管理 API 通过 `GATEWAY_ENABLED=true` 启用后，模板目录发布可选方式，界面显示独立域名选项。默认值为 ClusterInternal；PATCH 是完整配置，客户端必须保留当前 exposure，避免意外改回内部访问。

外部地址为 `http-<CR-UID>.<baseDomain>` 与 `grpc-<CR-UID>.<baseDomain>`，分别使用 HTTPS 和 gRPC TLS。域名绑定集群分配的不可变 CR UID，避免手写 CR 重复 instanceId 或跨 namespace 重名导致路由冲突。实例更新和暂停恢复保持 UID；删除重建产生新地址。WebDAV 只有 HTTP 路由。Bazel HTTP 和 REAPI 路由分别指向同一实例 Service 的 8080、9092 端口，后者声明 `kubernetes.io/h2c`。

[Gateway API 的 GRPCRoute 规范](https://gateway-api.sigs.k8s.io/reference/api-types/grpcroute/)建议 HTTP 与 gRPC 使用不同 hostname；本适配采用这一方式。实例本身继续使用引擎原生认证，Gateway 应保留 Authorization 及原始请求方法、路径，不额外缓存或改写请求。

## 配置示例

以下为部署方维护的共享资源示意，不会随 expbuild Chart 自动创建：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: caches
  namespace: edge
spec:
  gatewayClassName: your-approved-gateway-class
  listeners:
    - name: caches-https
      protocol: HTTPS
      port: 443
      hostname: '*.cache.example.com'
      tls:
        mode: Terminate
        certificateRefs:
          - name: cache-wildcard-tls
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              app.kubernetes.io/managed-by: expbuild
        kinds:
          - group: gateway.networking.k8s.io
            kind: HTTPRoute
          - group: gateway.networking.k8s.io
            kind: GRPCRoute
```

证书 Secret 位于 Gateway 所在 namespace，覆盖 `*.cache.example.com`；DNS 同名通配记录指向入口。Gateway API 的 TLS 配置规则见[官方说明](https://gateway-api.sigs.k8s.io/guides/user-guides/tls/)。入口可为内网地址，并不要求公网。

对应 Helm values：

```yaml
gateway:
  enabled: true
  name: caches
  namespace: edge
  sectionName: caches-https
  baseDomain: cache.example.com
  controllerName: your.example.com/gateway-controller
  dataPlaneNamespace: edge-data-plane
```

`controllerName` 必须是所选 GatewayClass 使用的实际控制器名称；示例不是可直接运行的控制器。`dataPlaneNamespace` 是实际转发流量的 Pod 所在 namespace，可以不同于 Gateway 对象或控制器的 namespace。部署方需给这些数据面 Pod 设置 `cache.expbuild.io/gateway=true`，并确保重建后仍保留此标签。

每个外部实例的 NetworkPolicy 同时要求来源 namespace 名称与 Pod 标签匹配，只开放该模板需要的端口。它与项目已有策略共同生效，不撤销已有客户端或控制面权限。若网络插件不执行 NetworkPolicy，不能据此宣称流量已经隔离。

## 就绪与清理

Operator 要求选定监听器为 443/HTTPS/TLS Terminate，Gateway 与监听器当前 generation 的 Accepted/Programmed/ResolvedRefs 状态符合要求；每条路由的父对象、namespace、sectionName、controllerName、当前 generation 的 Accepted/ResolvedRefs 也必须匹配。后端仍需通过既有认证协议探测。

Gateway 模式下，Ready/EndpointReady 表示后端与路由配置接纳。`ExternalReachability=Unknown, reason=NotProbed` 明确表示没有验证外部 DNS、证书信任和客户端可达性；不可把上述状态作为完整外部可用性的证明。

暂停、切回内部访问、删除实例时，先删除归属匹配的 HTTPRoute、GRPCRoute 和入口 NetworkPolicy，再继续后续处理。删除使用 UID/resourceVersion 前置条件，拒绝认领或删除其他实例资源。专门的 gateway-cleanup finalizer 在创建路由之前写入，并在确认路由已不存在后移除；清理失败会保留标记。

关闭入口配置前，应先将 Gateway 实例改回内部访问或删除。关闭后 Operator 不再监听路由变化，但保留路由清理权限，使已有标记的实例仍可在删除时撤销访问。不能先卸载 Gateway API CRD；API 缺失会使安全清理失败并阻止正常完成。路由对象删除与代理实际停止转发之间存在控制器收敛时间，需要在真实数据面验证。

## 已完成的隔离集群验收

[2026-09-30 的真实集群 CI](https://github.com/expbuild/expbuild/actions/runs/36669207282)通过，代码提交 `ea1aaa7`。使用固定 Chart SHA256 和镜像摘要的 Envoy Gateway v1.8.5、Envoy v1.38.4；可复现入口见 [测试说明](testing.md)。

- 实际共享 HTTPS 监听器与跨 namespace HTTPRoute/GRPCRoute 接纳。
- 临时 CA、通配证书、真实 hostname/SNI 校验；错误 hostname 和不受信任证书被拒绝。
- WebDAV 认证、16 MiB PUT/GET、MKCOL/PROPFIND/LOCK、无令牌删除拒绝和指定资源锁令牌删除成功。
- WebDAV 暂停后外部访问停止，恢复后读取原数据；轮换后旧密码拒绝、新密码读原数据；删除后外部入口撤销。
- bazel-remote v2.6.2 固定摘要镜像、非 root UID/fsGroup、只读根文件系统、真实 PVC；gRPC TLS capabilities、FindMissingBlobs、8 MiB ByteStream 分块上传/下载及 Bazel HTTP CAS。
- REAPI 与 HTTP 轮换后旧密码被拒绝、新密码读取原数据；删除后 HTTPRoute/GRPCRoute 清理。

流量通过本地端口转发抵达真实 Gateway TLS 监听器，没有绕过代理或证书校验。它不验证公网 DNS 或外部负载均衡器，也不证明生产 CSI 兼容性。

## 待完成的认证

- 真实 CNI 下允许/拒绝来源，以及生产网络与 DNS 配置。
- 真实 Bazel 构建客户端、ActionCache、压缩与并发客户端行为。
- WebDAV 重定向、MOVE/COPY 及更多客户端兼容性。
- 入口超时、超大请求及负载测试；16 MiB/8 MiB 是已验证样本，不是容量上限或吞吐承诺。
- REAPI 删除后的实际 RPC 拒绝；当前删除检查确认路由对象清理，WebDAV 另有数据面撤销断言。
