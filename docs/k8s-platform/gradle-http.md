# Gradle HTTP 构建缓存引擎（开发中）

Gradle 官方 HTTP build cache 通过 GET 读取 opaque task-output archive，通过 PUT 上传；HTTP Basic 是其原生认证方式。协议说明见 [Gradle Build Cache](https://docs.gradle.org/current/userguide/build_cache.html) 和 [HttpBuildCache API](https://docs.gradle.org/current/dsl/org.gradle.caching.http.HttpBuildCache.html)。这个端点与 Bazel 的 HTTP CAS/AC 不同，不能把 Gradle archive 按 Bazel digest 校验。

`operator/internal/gradlecache` 提供独立数据面：`GET/PUT /cache/<32 或 64 字符小写十六进制 key>`、bcrypt htpasswd 双身份认证（客户端和健康探测）、单条目大小限制、实例总预算、按最近访问时间清理、同 key 首次写入获胜。上传先写同卷临时文件，完成同步后以硬链接原子发布；重启扫描持久目录重建索引并删除遗留上传临时文件。读取命中返回 200、缺失 404、上传成功 201、重复 key 409、过大 413。其他方法拒绝。受认证保护的 `/status` 返回条目数、用量、预算及当前进程的 GET 命中/缺失和 PUT 成功/拒绝计数。凭据文件最多允许两条不重复的记录；格式错误时整体拒绝。

模板 `gradle-http@0.1.0` 已编入 Operator 注册表和 CRD。安装时必须配置受信的 `images.gradle` SHA256 镜像，管理 API 才允许新建；已有实例仍可管理。每实例使用单副本 StatefulSet、独立 PVC、独立 Secret 和 Service；Operator 在工作负载版本就绪后读取带认证的 `/status`，确认容量预算才报告 Ready/PolicyApplied。Gateway HTTPS 入口的连接地址保留 `/cache/` 路径。管理 API/界面提供容量、条目和请求计数，并生成 Gradle Kotlin 初始化脚本；CI 用户可上传，开发机默认只读取。模板和界面已通过本地 PostgreSQL、真实浏览器、Kubernetes API Server admission 与 Helm 渲染测试。

本地已使用官方 Gradle 8.14.3（校验 SHA256）验证首次上传、第二个全新项目和 Gradle 用户目录的 `FROM-CACHE` 命中、禁用缓存的重新执行；测试客户端 Kotlin 初始化脚本与控制台指引保持相同结构。此验证已加入平台 CI。新模板还没有通过真实 kind PVC/Service/入口、暂停恢复、凭据轮换和删除验收，不能把本地原生测试视为完整集群认证。支持的存储必须提供同一文件系统内的原子硬链接；其它 CSI 需单独认证。还需根据真实负载测 bcrypt 验证、访问时间更新和重启索引扫描开销。
