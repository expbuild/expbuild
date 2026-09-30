# 查询历史（Prometheus 接入）

管理 API 和界面支持可选的 Prometheus 历史查询。当前实现查询适配与权限控制，以及可选的 ServiceMonitor 自动生成与凭据引用同步；不部署 Prometheus 或 Prometheus Operator。部署方需要已有的受信任采集系统。无配置时返回 503，采集无数据时返回空序列，不伪造零值。

## 配置与指标契约

Helm 设置 `monitoring.prometheusURL`，例如 `http://prometheus.monitoring.svc:9090`，直接启动 API 时使用 `PROMETHEUS_URL`。允许 HTTP/HTTPS 和路径前缀，不接受 URL 内凭据、查询串或 fragment；不跟随重定向。当前不支持上游查询认证配置，应连接企业内部受控查询入口。

采集对象是 bazel-remote 的 `/metrics`，使用实例当前有效的 Basic 凭据。请求需要满足已有网络策略；启用下文 ServiceMonitor 集成时会生成来源 namespace 与 Pod 标签同时匹配的入口策略；未启用时需由部署方维护访问。

每条样本必须由采集系统附加可信标签：

| 指标标签 | 来源 |
| --- | --- |
| `expbuild_project_id` | CacheInstance 的不可变项目 ID / Pod 的 `cache.expbuild.io/project-id` |
| `expbuild_instance_uid` | Kubernetes 分配的 CR UID / Pod 的 `cache.expbuild.io/instance-uid` |

不能只使用实例名或 namespace 代替 UID，否则删除重建会混入旧数据。多集群共用监控时也需保证这些 UID 标识的归属可信。避免同一目标被重复采集后相加；配置重标签时不能允许引擎自身标签覆盖上述归属标签。

本次映射锁定 bazel-remote v2.6.2 的 `bazel_remote_incoming_requests_total`，来源见官方 [计数器定义](https://github.com/buchgr/bazel-remote/blob/v2.6.2/cache/disk/options.go)和[计数行为](https://github.com/buchgr/bazel-remote/blob/v2.6.2/cache/disk/metrics.go)：

- `kind=ac|cas` 分别表示动作缓存与内容缓存。
- `method=get` 表示读取；`contains` 表示存在性检查，FindMissing 按 digest 数量计数。
- `status=hit|miss` 表示引擎实际查询结果。错误不会自动算作未命中。

平台使用五分钟 `rate`，按上述三个标签分别聚合，每秒查询次数与构建命中率不同。暂不合并读取与存在性检查，也不把 HTTP/gRPC 成功状态解释为缓存命中。

## 管理 API

`GET /v1/projects/{projectId}/instances/{instanceId}/statistics/history?window=1h`

支持 `1h`、`6h`、`24h`，对应步长 60、120、300 秒；结束时间对齐步长。服务端从授权后的数据库绑定读取原 CR UID，调用者不能提交 PromQL 或标签选择器。项目成员可读取，历史实例删除后仍按原 UID 查询；当前保留多久取决于外部 Prometheus 的配置。

返回 `series`，每条包含 kind、method、outcome 和 `[Unix秒, 每秒次数或null]` 点列。非有限值转为 null，空序列表示无有效数据。上游警告、错误、过大响应、重复序列或异常时间戳被拒绝；请求限时 5 秒，响应最多 1 MiB、8 条序列、每条最多 300 点。接口不返回上游查询文本或地址。

界面按需加载，不持续轮询历史查询。可选时间范围、缓存类型和查询类型；监控失败时显示不可用，缺失样本显示空缺。实时容量仍从引擎状态接口采集，与历史查询独立。

## 验证范围与后续工作

单元测试覆盖查询范围、标签注入拒绝、时间和响应限制、缺失值；真实 PostgreSQL 测试覆盖绑定 UID、历史记录授权及跨项目拒绝；界面测试覆盖按需加载、筛选与监控不可用。本地已通过固定 Prometheus v3.15.0 的真实认证采集与范围查询测试：受控 exporter 为三个项目/UID 组合提供不同计数速率，确认项目及 UID 分别隔离，缺失实例为空序列、有效零值仍为零。该测试验证真实 PromQL/HTTP 行为，采集源是合约 fixture，尚未覆盖真实缓存引擎自动采集。实例采集自动化、网络入口、凭据轮换和长期负载仍待验收。资源指标、延迟、流量和 WebDAV 指标仍未接入。


## 复现真实 Prometheus 测试

```sh
python3 tools/download_prometheus.py /tmp/expbuild-prometheus
PROMETHEUS_BIN=/tmp/expbuild-prometheus npx tsx --test apps/admin-api/src/history-engine.test.ts
```

下载器锁定[官方 v3.15.0 Linux amd64 发布资产](https://github.com/prometheus/prometheus/releases/tag/v3.15.0)及 SHA256；仅提取校验过归档中的指定普通二进制文件。测试创建临时配置/TSDB、随机本地端口和独立进程，退出后清理。需要等待真实采样进入分钟对齐的查询窗口，通常几十秒；缺少 PROMETHEUS_BIN 时明确跳过，CI 下载后强制执行。不连接默认或生产 Prometheus。

## 可选的实例采集自动化

部署方先安装兼容的 Prometheus Operator 与 ServiceMonitor CRD。本平台的 CRD 契约测试固定官方 v0.94.1 CRD 和 SHA256；尚未完成 Prometheus Operator 容器到真实缓存引擎的全链路验收。启用示例：

```yaml
monitoring:
  prometheusURL: http://prometheus.monitoring.svc:9090
  serviceMonitor:
    enabled: true
    namespace: monitoring
```

Prometheus 自身需要选择项目 namespace 中带 `app.kubernetes.io/managed-by=expbuild` 的 ServiceMonitor，并给采集 Pod 设置 `cache.expbuild.io/monitoring=true`。Prometheus Operator 需要读取这些 namespace 内的凭据 Secret，Prometheus 需要相应服务发现权限；这些是部署方所维护监控系统的权限，不由 expbuild Chart 自动授予。

expbuild 每十秒调谐一次实例的 ServiceMonitor，限定 `/metrics`、HTTP 端口、30 秒采集间隔与 5 秒超时，不跟随重定向。凭据通过当前 Secret 的 probe-username/probe-password 引用传递，不把明文写入 ServiceMonitor。凭据轮换时更新引用，由 Prometheus Operator 异步重新加载；短暂采集空缺可能发生，不承诺零中断。

目标按 CR UID、项目和实例标签选择，并通过服务名重标签规则排除 headless Service，避免同一引擎重复采集。项目/UID 标签由固定重标签规则写入，honorLabels=false。配套 NetworkPolicy 同时限制来源 namespace 名称与采集 Pod 标签，只开放 8080；仍需执行网络策略的 CNI 才能证明实际隔离。

`MonitoringConfigured=True/ResourcesApplied` 只表示采集对象和策略写入成功，不代表已有样本。监控错误单独报告，不将已通过协议探测的缓存判为不可用。可选监控 API 不参与启动时的 informer 注册，以免其不可用阻断缓存控制器启动。

暂停、删除或关闭集成会清理精确归属的采集对象与网络策略，使用 UID/resourceVersion 删除前置条件；不接管其他 owner 的同名对象。清理标记在资源写入前添加，关闭功能后仍保留清理权限。Operator 只新增 ServiceMonitor get/create/patch/delete 权限，不获得 Prometheus 创建权限，管理 API 无 ServiceMonitor 写权限。

关闭集成后等待清理完成，再卸载 CRD 或撤销清理权限。监控 API 缺失时无法确认清理，实例删除可能保留 finalizer；不要直接移除标记掩盖未完成的资源清理。当前自动采集仅针对 bazel-remote，WebDAV 尚无相应指标适配。
