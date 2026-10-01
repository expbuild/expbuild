# 可观测功能与部署接入

2026-10-01。本文记录已经实现的首版能力、接入条件及测试边界。完整目标见 [可观测规划](observability-plan.md)，已有 Bazel 历史接口继续见 [monitoring.md](monitoring.md)。

## 用户入口

| 入口 | 已实现功能 | 权限 |
|---|---|---|
| 项目 / 可观测 | 后台采集覆盖率、实例服务状态与数据状态、内容用量和最后观测时间 | 项目成员 |
| 实例 / 指标与诊断 | 容量、查询效果、请求性能、资源历史；条件、操作及相关 Kubernetes 事件；运行日志 | 指标和事件：成员；日志：maintainer/admin |
| 项目 / 告警中心 | 当前告警、原实例诊断入口、静默一小时、已收到的告警历史 | 查看：成员；静默：maintainer/admin |
| 平台 / 平台健康 | 当前 API 副本的后台任务最近成功/失败、数据库连接池、未完成操作队列、数据源配置 | 平台管理员 |

平台管理员可访问所有项目。所有查询在 API 重新授权；历史使用原 CR UID，按集群和项目过滤。浏览器不能提交 PromQL、LogQL、任意匹配器或后端 URL。撤销成员资格后，已有会话无法继续请求项目观测数据。英文、简体中文和本地时区显示沿用管理平台设置。

服务就绪与数据采集状态分开显示。数据源未配置、查询失败、无样本、不支持、过期及真实零值具有不同语义。图表保留缺失点；“最后返回时间点”是 Prometheus 查询的计算时间点，不承诺等于原始抓取时间。计数器使用五分钟 `rate` 后聚合，条目命中率只在 hit 与 miss 均有数据且总查询量大于零时计算；不推算构建任务命中或节省时间。

## 按模板的能力

| 模板版本 | 容量历史 | 查询效果 | 性能与流量 | 淘汰 |
|---|---|---|---|---|
| bazel-remote 0.1.0 | `/status` 快照导出到 Prometheus | AC/CAS、get/contains 分开统计 | 新通用页面尚无已认证映射 | 新通用页面尚无已认证映射 |
| gradle-http 0.2.0 | `/status` 快照；原生 `/metrics` 同时提供当前值 | GET 条目命中、miss、命中率 | GET/PUT 请求、5xx、P95、读写字节速率 | 容量淘汰条目与字节速率 |
| gradle-http 0.1.0 | `/status` 快照 | 不宣称支持持续原生指标 | 不支持 | 不支持 |
| webdav-apache 0.2.0 | 原有扫描快照 | 不支持 | 不支持 | 不支持 |
| webdav-apache 0.1.0 | 不支持 | 不支持 | 不支持 | 不支持 |

WebDAV 引擎及扫描方式保持原状。新建 Gradle 实例使用 0.2.0；旧实例继续按原版本维护，平台不偷偷修改其模板版本，也尚未提供版本升级工作流。必须先发布包含新指标的 Gradle 镜像，再启用这一版本的管理 API/Operator；保留三者对应版本的发布记录。

Gradle `/metrics` 使用专用 `health` 身份，拒绝匿名和缓存客户端身份；`health` 仍不能读写缓存条目。指标抓取不产生缓存查询命中、不改变访问热度。计数器随进程重启，历史查询处理计数重置。请求指标涵盖认证后的缓存 GET/PUT，排除状态与指标探针；延迟包含服务端传输时间，写入字节包含已读取但最终被拒绝的请求体。

资源页面查询 CPU、节流、内存、限制、重启，以及 CSI 能提供的实际卷容量/用量。资源数据依赖集群采集；申请的 PVC 大小不替代实际卷使用量。WebDAV 的容量参考值是申请卷大小，Bazel/Gradle 的容量参考值是引擎预算。

## 启用部署

主 Chart 接入企业监控设施，不安装 Prometheus、Loki、Alertmanager、kube-state-metrics 或节点日志采集器。先完成数据库迁移 `009_observability.sql`，再发布 API、Operator、前端与相应引擎镜像。Helm 的迁移 Job 沿用原有升级流程。

```yaml
monitoring:
  clusterId: production-eu1
  prometheusURL: https://metrics.example.test/prometheus
  queryBearerTokenSecret: expbuild-prometheus-query
  serviceMonitor:
    enabled: true
    namespace: monitoring
  platform:
    enabled: true
    tokenSecret: expbuild-platform-scrape
    serviceMonitor: true
    rules: true
  logs:
    url: https://logs.example.test
    tokenSecret: expbuild-loki-query
  alerts:
    url: https://alerts.example.test
    tokenSecret: expbuild-alertmanager-query
    webhookTokenSecret: expbuild-alert-webhook
```

这些 Secret 均由部署方预先在控制面 namespace 创建，字段名为 `bearer-token`；Chart 只引用 Secret，不把明文存入 values。查询凭据、平台抓取凭据和入站告警凭据应独立。抓取/入站凭据至少 32 字符，不含空格/换行；更新环境变量 Secret 后需要滚动重启 API/Operator。后端使用原生无认证 HTTP 时可以不配置相应查询 Secret，但网络入口必须由部署方控制。

`clusterId` 必须稳定，并同时用于平台指标、实例指标、集群资源指标、日志和告警；更改会切断既有历史的查询范围。平台当前单集群控制模型不因新增标签变为多集群管理。

Prometheus Operator 的 ServiceMonitor/PrometheusRule CRD 需提前安装。其选择器须包含：控制面 namespace 内由 Helm 管理的两个平台 ServiceMonitor 和规则，以及项目 namespace 内由 expbuild 管理的实例 ServiceMonitor。不要只选择 `app.kubernetes.io/managed-by=expbuild`，那会漏掉 Helm 管理的平台监控对象。实例采集 Pods 还需带 `cache.expbuild.io/monitoring=true` 标签，满足项目 NetworkPolicy。

未使用 Prometheus Operator 时，可以关闭 ServiceMonitor/规则对象创建，用标准 Prometheus 配置抓取：

- API Service 的 `/internal/metrics`，Bearer 鉴权，端口 9090。
- Operator Service 的 `/metrics`，相同安装级抓取凭据，端口 9090。
- Bazel/Gradle 0.2.0 实例的 `/metrics`，使用其专用 probe Basic 凭据，端口 8080。
- 所有目标关闭跟随重定向与信任客户端时间戳，约 30 秒采样；设置 `expbuild_cluster_id`，平台目标另设置 `expbuild_component=api|operator`。
- 实例目标必须从可信 CR/Service 绑定覆盖 `expbuild_project_id`、`expbuild_instance_uid`，不能信任引擎自报身份。平台 API 导出的多实例快照标签来自数据库与 CR 双重归属校验，不应被改写成单一实例。

资源采集需要 kube-state-metrics 的 Pod/PVC 标签 allowlist：`cache.expbuild.io/instance-uid`。查询使用 `label_cache_expbuild_io_instance_uid`；kube-state-metrics、kubelet/cAdvisor 的采集目标也需设置一致的集群标签。查询按历史时间点关联 Pod/PVC，不以当前 Pod 名称替代历史归属。没有这些资源指标时，页面显示无样本。

## 日志接入

API 默认输出结构化日志，并为响应返回 `X-Request-ID`。默认不记录请求体、完整 URL、Authorization、Cookie 或缓存 key。请求指标按路由模板统计，后台任务使用固定事件代码；审计继续独立记录管理行为。

节点采集器由部署方安装、限制采集范围、补齐可信 Kubernetes 身份并在写入 Loki 前脱敏。Loki 流必须包含 `expbuild_cluster_id`、`expbuild_project_id`、`expbuild_instance_uid`；这些字段来自 Pod/CR 归属，不从日志正文提取。请求 ID、对象路径等不能成为流标签。当前查询适配不向客户端开放 Loki 的租户头；多租户 Loki 应通过部署方配置的查询代理固定租户。

日志 API 最多读取一小时，页面默认最近 15 分钟；每次最多 500 行，超过标记截断，上游响应最多 1 MiB，五秒超时，每个 API 副本每个后端最多八个并发查询。可选 level 筛选要求采集后的 JSON 使用 `info/warn/error` 字符串。API 对常见密钥字段再脱敏；它不能替代源头禁止输出机密或采集端脱敏。

## 告警接入

Chart 提供六条规则：平台目标采集失败、API 高错误率、实例未就绪、实例统计不可用、无活动实例采集器、操作长时间未完成。采集失败不等于缓存宕机，暂停状态抑制对应实例规则；低命中率与接近容量预算默认不触发告警。阈值目前随规则发布；项目级阈值编辑仍是后续工作，用户已可创建 5 分钟至 24 小时的实例/规则范围静默，界面提供一小时预设。

企业通知渠道继续由 Alertmanager 管理；平台不持有邮件或聊天系统凭据。向实例告警的现有路由添加下面的接收配置，将服务地址替换为实际 release 名称；不要覆盖企业已有通知路由。

```yaml
receivers:
  - name: expbuild-history
    webhook_configs:
      - url: http://RELEASE-expbuild-api.CONTROL_NAMESPACE.svc:80/internal/alerts
        send_resolved: true
        max_alerts: 50
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/expbuild-webhook/bearer-token
```

将独立 webhook Secret 挂载到 Alertmanager 的上述路径。入站接口接受最大 64 KiB 请求体；避免冗长 annotation，50 是条数上限而不是保证任意 50 条都能放入。跨集群/项目/原 UID 不匹配的通知被忽略。接收端按项目、UID、fingerprint、startsAt 幂等，重复和乱序投递不会把已恢复的一轮告警重新打开。

后台每分钟有界核对已收到且未恢复的告警，每批最多十个项目。当前列表中消失只记为“最近核对时已不在活跃列表中”，不伪造恢复时间；查询失败保留上次核对时间。告警历史明确提示通知接收中断可能造成缺失，不等同完整 Alertmanager 历史。静默先记录审计请求，再调用后端；结果未知时要求先刷新检查再重试。

## 数据保留与运行边界

后台实例采集每批最多 20 个实例，最多四个实例并发；完整轮询结束等待约 30 秒。PostgreSQL 会话锁维持单活动采集器，检测到数据库连接失效后停止该副本的内存指标导出，下个副本可接管。不要通过事务池化模式的数据库代理承载这个会话锁；使用直连或 session pooling。

数据库只存每实例最新快照。Prometheus 抓取时间戳、Ready、期望运行、统计可用性和容量 gauges，形成历史；停止更新 120 秒后不再导出旧快照。内存最多保留 10,000 个实例快照，这是保护上限，不是已验收的规模承诺。采集覆盖率和过期状态用于暴露未覆盖实例。

Kubernetes 事件只关联当前能确认归属的 CR、Pod、PVC UID。每实例最多关联八个资源、每资源最多 100 个事件，返回最多 100 个，截断和失败单独报告。只保存稳定原因、类型、次数、发生时间，不保存事件原始正文。同一个事件的计数更新原记录，不重复插入。实例诊断事件保留至多 1,000 条或 30 天；清理任务分批运行，时间保留不是精确到秒的删除保证。采集断开期间已过期的 Kubernetes 事件无法补回。

告警恢复后的历史保留 30 天，未恢复告警保留以待核对。指标、日志的保留由企业后端配置；建议起点仍为指标 15 天、日志 7 天，主 Chart 不替后端承诺保留或持久性。审计和业务操作记录维持独立策略。

查询后端故障只影响观测结果，不修改缓存 Ready、不暂停缓存、不触发引擎重启。API 健康页面中的“已配置”只代表配置存在，后台任务状态只代表处理该请求的 API 副本。Operator 的实际调谐、队列和 leader 指标由 controller-runtime 端点提供；当前原生平台健康页尚未把这些指标完整绘图。

## 验证与下一步

首版验证包括真实 PostgreSQL 权限与历史去重、真实 Prometheus 查询、真实 Loki 日志、真实 Alertmanager 静默与恢复、规则回放、Go 竞争检测、Kubernetes API Server/etcd 的 CRD/RBAC 验证，以及 Chromium 管理流程。API 兼容测试固定 [Alertmanager 0.28.1](https://github.com/prometheus/alertmanager/releases/tag/v0.28.1) 与 [Loki 3.5.0](https://github.com/grafana/loki/releases/tag/v3.5.0)，下载工具校验固定发行摘要；它们是测试基线，不是企业生产版本推荐。

```bash
npm run build
TEST_DATABASE_URL=... npm test
PROMETHEUS_BIN=... ALERTMANAGER_BIN=... LOKI_BIN=... npm test --workspace apps/admin-api
TEST_DATABASE_URL=... npm run test:browser
cd operator
go test -race ./internal/gradlecache ./internal/monitoring
KUBEBUILDER_ASSETS=... HELM_BIN=... go test ./...
```

告警规则回放：`python3 tools/test_observability_rules.py --helm /path/to/helm --promtool /path/to/promtool`，需要 PyYAML。CI 已加入固定后端和规则验证。本轮没有将清单应用到业务集群；envtest 不运行 kubelet、CSI/CNI 或真实采集 Pods，仍需在目标集群验收全链路、凭据轮换、采集器故障与规模成本。

后续深化范围：项目级规则阈值编辑、完整 Operator/依赖趋势与生命周期分阶段耗时、告警历史的补偿接收与绝对时间窗口联动、Bazel 其他原生指标适配、节点采集器的认证部署包、调用链、自研 WebDAV/分层缓存指标、SLO 与大规模负载基线。上述项目不作为本次已完成能力。
