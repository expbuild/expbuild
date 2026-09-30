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
部署验收仍需要容器启动、卷权限及真实客户端测试。
