# 平台容器

在仓库根目录构建：

```sh
docker build -f images/admin-api/Dockerfile -t registry.example.com/expbuild/admin-api:0.1.0 .
docker build -f images/admin-web/Dockerfile -t registry.example.com/expbuild/admin-web:0.1.0 .
docker build -f images/operator/Dockerfile -t registry.example.com/expbuild/operator:0.1.0 .
```

三个 Dockerfile 使用多阶段构建。API 镜像包含编译代码、生产依赖及 SQL migrations，
也用于迁移/初始化 Job；Web 使用非 root Nginx 提供静态文件；Operator 使用静态 Go
二进制和非 root distroless。Chart 为可写临时文件挂载有限额的 `/tmp`。

镜像构建流水线不自动发布。发布到企业容器仓库后，用仓库返回的 digest 更新部署
values；生产环境建议对三个平台镜像也使用 digest。当前基础镜像使用版本 tag，
企业可在验证供应链后固定其 digest。缓存引擎镜像独立管理，必须使用 digest。

本地环境目前没有 Docker/Podman，因此没有在这里执行容器构建。CI 构建定义
不能视为已通过的构建结果；部署验收还需要拉取、启动及真实客户端测试。
