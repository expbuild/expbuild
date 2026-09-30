# WebDAV 引擎实现进度

第二个引擎使用 Apache HTTP Server 的 [mod_dav](https://httpd.apache.org/docs/2.4/mod/mod_dav.html)
及 [mod_dav_fs](https://httpd.apache.org/docs/2.4/mod/mod_dav_fs.html)。当前已接入
Operator、CRD、Helm 镜像参数、管理 API、管理界面和真实协议测试。

## 资源与能力

- 模板名 `webdav-apache`，版本 `0.1.0`，单副本 StatefulSet + 独立 PVC。
- 独立 HTTP 服务，使用 htpasswd；读取和写入都要求认证。
- 以 UID/GID 1000 运行，fsGroup 1000，根文件系统只读、无额外 capabilities。
- 内容位于 `/data/content`，DAV 锁数据库位于 `/data/locks`，不作为内容暴露。
- 配置使用独立不可变 ConfigMap；沿用暂停、凭据版本、归属检查与 Retain/Delete 流程。
- 就绪要求工作负载版本完成，并用探测凭据执行 Depth=0 的 PROPFIND，检查 207 DAV XML。
- `enginePolicy: none`、`maxCacheGiB: 0`。CRD 拒绝 WebDAV 使用 REAPI 的 LRU/预算配置。

Apache 没有原生缓存 LRU 或磁盘配额。本模板的 PVC 容量是请求的卷大小，不能当作
所有 CSI 上都有效的硬配额。也不能并发扫描删除活动 DAV 文件来伪装淘汰功能，因为
文件与锁状态需要协调。后续缓存策略和统计适配仍需独立实现并验证。

## 开发部署入口

Operator 需配置 `--webdav-image=仓库@sha256:摘要`；Helm 使用 `images.webdav`。
未配置时，WebDAV 实例报告 InvalidConfiguration，不会猜测或拉取任意镜像。
`images/webdav/Dockerfile` 提供候选镜像构建，尚未执行容器构建认证。

`operator/examples/webdav.yaml` 展示 CR 格式。实际应用前须创建受管理项目 namespace、
StorageClass 和归属匹配的 Secret，包含 htpasswd、probe-username、probe-password。
Helm 配置 `images.webdav` 后同步设置 API 的 `WEBDAV_ENABLED=true`，模板目录才返回 WebDAV，
未启用时 API 拒绝新建。手动部署需同时配置 API 开关和 Operator 镜像。关闭开关后仍允许
管理已有实例，避免阻止暂停或删除；Operator 镜像应保留到实例全部退出。
API 创建时指定 `template: webdav-apache` 和 `cacheGiB: 0`，其余资源参数与现有模板一致。
模板目录声明无原生 LRU、容量预算和统计能力；统计请求返回 409，不访问不存在的状态接口。
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

仍待：镜像构建/固定 digest、真实 PVC 非 root 权限、浏览器端到端联调、
策略/统计适配、TLS/域名、锁持久性与故障恢复测试。未将这些项目视为已完成。
