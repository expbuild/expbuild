# Gradle HTTP 构建缓存引擎（开发中）

Gradle 官方 HTTP build cache 通过 GET 读取 opaque task-output archive，通过 PUT 上传；HTTP Basic 是其原生认证方式。协议说明见 [Gradle Build Cache](https://docs.gradle.org/current/userguide/build_cache.html) 和 [HttpBuildCache API](https://docs.gradle.org/current/dsl/org.gradle.caching.http.HttpBuildCache.html)。这个端点与 Bazel 的 HTTP CAS/AC 不同，不能把 Gradle archive 按 Bazel digest 校验。

`operator/internal/gradlecache` 现在提供独立数据面原型：`GET/PUT /cache/<32 或 64 字符小写十六进制 key>`、单用户 bcrypt htpasswd、单条目大小限制、实例总预算、按最近访问时间清理、同 key 首次写入获胜。上传先写同卷临时文件，完成同步后以硬链接原子发布；重启扫描持久目录重建索引并删除遗留上传临时文件。读取命中返回 200、缺失 404、上传成功 201、重复 key 409、过大 413。其他方法拒绝。受同一凭据保护的 `/status` 返回当前条目数、用量、预算及进程生命周期内的 GET 命中/缺失和 PUT 成功/拒绝计数。`images/gradle-cache/Dockerfile` 构建非 root 静态镜像，容器 CI 验证认证与读写。当前尚未接入 Operator、CRD、管理 API、Helm，也没有完成原生 Gradle 客户端三阶段构建、PVC/CSI 和大规模性能验收，因此不能作为可创建实例的模板发布。

下一步是为该引擎接入精确版本模板、受信镜像、PVC/Service/StatefulSet、协议就绪探测与统计，再运行原生 Gradle 客户端首次上传、干净本地缓存命中、禁用远程缓存对照，以及预算淘汰和重启恢复的 kind 验收。支持的存储必须提供同一文件系统内的原子硬链接；其它 CSI 需单独认证。还需根据真实负载测 bcrypt 验证与访问时间更新的开销。
