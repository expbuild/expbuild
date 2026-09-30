# expbuild 管理界面

React + TypeScript 的新管理控制台，与 `apps/admin-api` 同源部署。

目前支持登录、会话恢复、退出、项目创建/切换、实例列表、实例创建、
资源与淘汰容量配置、暂停/恢复、删除确认、连接地址和操作进度，
以及用户创建/启停、本人修改密码、管理员重置密码、按邮箱添加成员、角色调整/移除、项目审计记录和缓存凭据轮换。
管理员、维护者和只读用户的按钮与后端权限相对应，最终授权由 API 完成。

## 本地运行

在仓库根目录执行：

```sh
npm ci
npm run dev --workspace @expbuild/admin-api
npm run dev --workspace @expbuild/admin-web
```

API 的 `APP_ORIGIN` 使用 `http://localhost:5173`，浏览器也使用这个地址。
Vite 将 `/v1` 代理到本机 3001 端口，保留原始 Origin。
API 需要 PostgreSQL、Kubernetes 配置和操作加密密钥，见对应 README。

```sh
npm run build --workspace @expbuild/admin-web
npm test --workspace @expbuild/admin-web
```

构建结果位于 `dist`。生产部署需由同一入口提供静态文件与 `/v1` 反向代理，
不能把 Vite 开发服务器作为生产服务器。

## 行为与边界

- 认证会话保存在 HttpOnly cookie；CSRF token 使用当前标签页的 sessionStorage。
  新标签页没有 CSRF token 时需重新登录。实例连接密码只保留在组件内存中。
- 同一个表单请求失败后重试沿用幂等键，修改表单内容后生成新键。
- 编辑基于打开表单时的配置版本；后台刷新不会将旧表单升级成新版本写入。
- 实例生命周期与服务 Ready 状态分别显示；服务未就绪不会显示为就绪。
- 当前只有 Bazel Remote 模板；历史指标、命中率、邮件找回密码和
  WebDAV 尚未接入。项目列表最多显示 200 条，操作记录最多显示 100 条。
- 组件测试使用模拟 API，不能代替真实浏览器和 Kubernetes 联调。

实例详情展示引擎缓存使用量、容量、条目数和采集时间。采集失败时保留最近结果并标记不可用；暂停/删除实例停止轮询。统计不等于整个 PVC 的磁盘用量。
