# WebDAV 引擎实现进度

第二个引擎使用 Apache HTTP Server 的 [mod_dav](https://httpd.apache.org/docs/2.4/mod/mod_dav.html)
及 [mod_dav_fs](https://httpd.apache.org/docs/2.4/mod/mod_dav_fs.html)。当前已接入
Operator、CRD、Helm 镜像参数、管理 API、管理界面和真实协议测试。

## 资源与能力

- 模板名 `webdav-apache`。新建使用 `0.2.0`，旧 `0.1.0` 实例继续按原版本维护；单副本 StatefulSet + 独立 PVC。
- 独立 HTTP 服务，使用 htpasswd；读取和写入都要求认证。
- 以 UID/GID 1000 运行，fsGroup 1000，根文件系统只读、无额外 capabilities。
- 内容位于 `/data/content`，DAV 锁数据库位于 `/data/locks`，不作为内容暴露。
- 配置使用独立不可变 ConfigMap；沿用暂停、凭据版本、归属检查与 Retain/Delete 流程。
- 就绪要求工作负载版本完成，并用探测凭据执行 Depth=0 的 PROPFIND，检查 207 DAV XML。
- `enginePolicy: none`、`maxCacheGiB: 0`。CRD 拒绝 WebDAV 使用 REAPI 的 LRU/预算配置。`0.2.0` 增加只读内容扫描 sidecar，复用受信 Operator 镜像中的 `/webdav-stats`；将实例 CPU/内存请求与限制拆分给两个容器，总量保持不变。

Apache 没有原生缓存 LRU 或磁盘配额。本模板的 PVC 容量是请求的卷大小，不能当作
所有 CSI 上都有效的硬配额。也不能并发扫描删除活动 DAV 文件来伪装淘汰功能，因为
文件与锁状态需要协调。`0.2.0` 每 30 秒扫描 `/data/content` 的普通文件，最多 100 万条、15 秒，遇到无法完成的扫描则返回不可用而非零。`/status` 仅在内部 Service 的 9093 端口提供，要求当前探测凭据，扫描挂载为只读。该数据是近似文件数与文件大小快照，`capacityBytes` 是 PVC 申请容量，不是 CSI 硬配额；不代表命中率。可靠淘汰策略与请求指标仍待独立实现。

## 开发部署入口

Operator 需配置 `--webdav-image=仓库@sha256:摘要`；Helm 使用 `images.webdav`。
未配置时，WebDAV 实例报告 InvalidConfiguration，不会猜测或拉取任意镜像。
`images/webdav/Dockerfile` 使用已查询官方 Registry 的 Apache 2.4.68 trixie 镜像及固定摘要。
原 2.4.66-bookworm 标签在远程 CI 中确认不存在，已替换。下述原生协议测试使用
Ubuntu Apache 2.4.66，不代表新的容器镜像已通过运行认证。

`operator/examples/webdav.yaml` 展示 CR 格式。实际应用前须创建受管理项目 namespace、
StorageClass 和归属匹配的 Secret，包含 htpasswd、probe-username、probe-password。
Helm 配置 `images.webdav` 后同步设置 API 的 `WEBDAV_ENABLED=true`，模板目录才返回 WebDAV，
未启用时 API 拒绝新建。手动部署需同时配置 API 开关和 Operator 镜像。关闭开关后仍允许
管理已有实例，避免阻止暂停或删除；Operator 镜像应保留到实例全部退出。
API 创建时指定 `template: webdav-apache` 和 `cacheGiB: 0`，其余资源参数与现有模板一致。
模板目录声明无原生 LRU 和缓存预算。`0.2.0` 声明实时内容统计能力；旧 `0.1.0` 仍不支持统计。控制台按精确版本展示能力。
更新必须保留原模板，禁止跨引擎切换。控制台从 API 获取可用模板，启用后可选择 WebDAV 创建；编辑时固定原模板，隐藏缓存预算和统计请求。
对外访问仍需 TLS 入口；当前服务地址为集群内部 HTTP。

## 已验证

本地解包 Ubuntu Apache 2.4.66 二进制和运行库，没有安装或启动系统 Apache 服务。
测试使用临时目录、随机本机端口，退出时停止整个测试进程组。

```sh
cd operator
APACHE_BIN=/path/to/apache2 APACHE_MODULES=/path/to/apache2/modules \
  go test ./internal/webdav -run TestApacheWebDAVContract -count=1 -v
```

真实测试已通过 bcrypt 认证、匿名写入拒绝、MKCOL、PUT/GET、PROPFIND、LOCK、
无锁令牌 DELETE 拒绝和携带正确资源锁条件的 DELETE。配置兼容 UnixD 模块内置或动态加载。
另有资源模型测试、隔离 API Server 的能力约束/调谐测试及协议探测测试。

真实 PostgreSQL 配合模拟 Kubernetes 已验证模板启用限制、错误预算拒绝、创建到就绪、
禁止跨引擎更新、不支持统计时不触发采集，以及关闭创建开关后仍可暂停已有实例。

当前统计实现的真实集群与管理 API 联调已加入 CI，结果仍待确认。请求指标、可靠淘汰、长期扫描开销、生产 CSI、锁持久性和故障恢复仍待验证。
