# 平台容器

在仓库根目录构建：

```sh
docker build -f images/admin-api/Dockerfile -t registry.example.com/expbuild/admin-api:0.1.0 .
docker build -f images/admin-web/Dockerfile -t registry.example.com/expbuild/admin-web:0.1.0 .
docker build -f images/operator/Dockerfile -t registry.example.com/expbuild/operator:0.1.0 .
docker build -f images/webdav/Dockerfile -t registry.example.com/expbuild/webdav:0.1.0 .
```

三个 Dockerfile 使用多阶段构建。API 镜像包含编译代码、生产依赖及 SQL migrations，
也用于迁移/初始化 Job；Web 使用非 root Nginx 提供静态文件；Operator 使用静态 Go
二进制和非 root distroless。Chart 为可写临时文件挂载有限额的 `/tmp`。

镜像构建流水线不自动发布。发布到企业容器仓库后，用仓库返回的 digest 更新部署
values；生产环境建议对三个平台镜像也使用 digest。当前基础镜像使用版本 tag，
企业可在验证供应链后固定其 digest。缓存引擎镜像独立管理，必须使用 digest。

本地环境没有 Docker/Podman。提交 d90d0a7 的四个镜像已在
[GitHub Actions](https://github.com/expbuild/expbuild/actions/runs/36662004310) 实际构建通过，未发布。
WebDAV 基于固定摘要的 Apache 2.4.68 trixie，运行时由 Operator 挂载配置、认证文件和数据卷。
提交 69a520f 的[容器运行检查](https://github.com/expbuild/expbuild/actions/runs/36662736536)
也已通过。API 覆盖临时 PostgreSQL 迁移、初始化与登录，Web 覆盖 HTTP 页面与健康检查，
WebDAV 覆盖临时数据目录中的认证读写，Operator 仅覆盖可执行入口。
完整集群、PVC 权限、持久化及网络访问仍待验收。

构建本地测试标签后，可在仓库根目录执行 `python3 tools/container_smoke.py <component>`，
组件名为 admin-api、admin-web、operator 或 webdav。脚本需要 Docker；API 检查会拉取
postgres:18 并创建临时数据库容器和网络，退出时自动清理。
