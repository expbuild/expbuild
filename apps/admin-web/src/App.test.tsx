// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import type { Operation } from "./api";

const projectId = "project-1";
let projectState = "ready";
let operations: Operation[] = [];
let webdavEnabled = false;
let gatewayEnabled = false;
let webdavInstance = false;
let policyGeneration: number | undefined;
let role = "admin",
  platform = true;
let requests: { path: string; options: RequestInit }[];
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  sessionStorage.clear();
  role = "admin";
  projectState = "ready";
  webdavEnabled = false;
  gatewayEnabled = false;
  webdavInstance = false;
  policyGeneration = undefined;
  platform = true;
  requests = [];
  operations = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit = {}) => {
      requests.push({ path, options });
      if (path === "/v1/templates")
        return response({
          items: [
            {
              name: "bazel-remote",
              version: "0.1.0",
              capabilities: { capacity: true },
              exposures: gatewayEnabled ? ["ClusterInternal", "Gateway"] : ["ClusterInternal"],
            },
            ...(webdavEnabled
              ? [
                  {
                    name: "webdav-apache",
                    version: "0.1.0",
                    capabilities: { capacity: false },
                  },
                ]
              : []),
          ],
        });
      if (path.endsWith("/instances/dav") && options.method === "PATCH")
        return response({ operation: { id: "updated" } }, 202);
      if (path.endsWith("/instances/dav"))
        return response({
          id: "dav",
          name: "Artifacts",
          lifecycle: "active",
          revision: "uid:1",
          spec: {
            templateRef: { name: policyGeneration === undefined ? "webdav-apache" : "bazel-remote", version: "0.1.0" },
            desiredState: "Running",
            storage: { capacity: "10Gi", deletionPolicy: "Retain" },
            eviction: { maxCacheGiB: 0 },
            resources: { limits: { cpu: "500m", memory: "512Mi" } },
          },
          status: policyGeneration === undefined ? {} : { conditions: [{ type: "PolicyApplied", status: "True", reason: "EngineBudgetVerified", observedGeneration: policyGeneration }] },
        });
      if (path === "/v1/auth/login")
        return response({ csrfToken: "test-csrf" });
      if (path === "/v1/auth/me")
        return response({
          user: {
            id: "user-1",
            email: "admin@example.test",
            platform_admin: platform,
          },
        });
      if (path === "/v1/projects")
        return response({
          items: [
            { id: projectId, name: "Build team", state: projectState, role },
          ],
        });
      if (path.endsWith("/operations")) return response({ items: operations });
      if (path.endsWith("/retry"))
        return response(
          { operation: { id: "retry-op", state: "pending" } },
          202,
        );
      if (path.endsWith("/instances") && options.method === "POST")
        return response(
          {
            operation: { id: "op-1" },
            credentials: { username: "cache", password: "one-time-password" },
          },
          202,
        );
      if (path.endsWith("/instances"))
        return response({
          items: webdavInstance
            ? [
                {
                  id: "dav",
                  display_name: "Artifacts",
                  template_name: "webdav-apache",
                  lifecycle: "active",
                  resource_name: "c-dav",
                },
              ]
            : [],
        });
      return response({ error: "Unexpected request" }, 500);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("management console", () => {
  it('exposes administrator-enabled Gateway access in the create form', async () => {
    gatewayEnabled = true;
    sessionStorage.setItem('expbuild-csrf', 'csrf');
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole('button', { name: '＋ 创建实例' }));
    await screen.findByRole('option', { name: '独立域名（HTTPS / gRPC TLS）' });
    await user.selectOptions(screen.getByLabelText('访问方式'), 'Gateway');
    await user.type(screen.getByLabelText('实例名称'), 'Gateway build');
    await user.click(screen.getByRole('button', { name: '创建实例' }));
    await waitFor(() => expect(requests.some(r => r.options.method === 'POST' && r.path.endsWith('/instances'))).toBe(true));
    const created = requests.find(r => r.options.method === 'POST' && r.path.endsWith('/instances'))!;
    expect(JSON.parse(String(created.options.body)).exposure).toBe('Gateway');
  });

  it.each(["admin", "maintainer", "viewer"])(
    "shows only eligible recovery controls to %s",
    async (memberRole) => {
      role = memberRole;
      platform = false;
      sessionStorage.setItem("expbuild-csrf", "csrf");
      const failed: Operation = {
        id: "bound",
        instance_id: "i",
        kind: "instance.create",
        state: "failed",
        error_code: "operation_deadline_exceeded",
        target_generation: "1",
        created_at: "2026-09-30T00:00:00Z",
        updated_at: "2026-09-30T00:20:00Z",
      };
      operations = [
        failed,
        { ...failed, id: "unbound", target_generation: null },
        { ...failed, id: "delete", kind: "instance.delete" },
      ];
      render(<App />);
      await screen.findAllByText(/operation_deadline_exceeded/);
      expect(
        screen.queryAllByRole("button", { name: "恢复检查" }),
      ).toHaveLength(memberRole === "admin" ? 2 : 0);
      expect(
        screen.queryAllByRole("button", { name: "继续删除" }),
      ).toHaveLength(memberRole === "admin" ? 1 : 0);
    },
  );

  it("creates WebDAV only from the enabled catalog without a cache budget", async () => {
    webdavEnabled = true;
    sessionStorage.setItem("expbuild-csrf", "csrf");
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "＋ 创建实例" }),
    );
    await screen.findByRole("option", { name: "WebDAV / HTTP" });
    await user.selectOptions(
      screen.getByLabelText("协议模板"),
      "webdav-apache",
    );
    expect(screen.queryByLabelText("缓存容量（GiB）")).toBeNull();
    await user.type(screen.getByLabelText("实例名称"), "Artifacts");
    await user.click(screen.getByRole("button", { name: "创建实例" }));
    await screen.findByDisplayValue("one-time-password");
    const sent = requests.find((r) => r.options.method === "POST")!;
    expect(JSON.parse(sent.options.body as string)).toMatchObject({
      template: "webdav-apache",
      cacheGiB: 0,
    });
  });
  it.each([1, 2])("only confirms policy for the current revision (observed %s)", async (generation) => {
    webdavInstance = true;
    policyGeneration = generation;
    sessionStorage.setItem("expbuild-csrf", "csrf");
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "详情" }));
    await screen.findByText(generation === 1 ? /缓存策略已生效/ : /缓存策略尚未确认生效/);
    if (generation !== 1) expect(screen.queryByText(/缓存策略已生效/)).toBeNull();
  });
  it("keeps an existing WebDAV template immutable and does not poll unsupported statistics", async () => {
    webdavInstance = true;
    sessionStorage.setItem("expbuild-csrf", "csrf");
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "详情" }));
    await screen.findByText("此模板暂不支持容量统计。");
    expect(requests.some((r) => r.path.endsWith("/statistics"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "编辑配置" }));
    const select = screen.getByLabelText("协议模板") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("webdav-apache");
    expect(screen.queryByLabelText("缓存容量（GiB）")).toBeNull();
    await user.selectOptions(screen.getByLabelText("运行状态"), "Suspended");
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() =>
      expect(requests.some((r) => r.options.method === "PATCH")).toBe(true),
    );
    const update = requests.find((r) => r.options.method === "PATCH")!;
    expect(JSON.parse(update.options.body as string)).toMatchObject({
      template: "webdav-apache",
      cacheGiB: 0,
      desiredState: "Suspended",
    });
    expect(new Headers(update.options.headers).get("If-Match")).toBe('"uid:1"');
  });

  it("retries failed project initialization and prevents repeated submission", async () => {
    projectState = "failed";
    sessionStorage.setItem("expbuild-csrf", "csrf");
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "重试初始化" }));
    const submitted = await screen.findByRole("button", { name: "重试已提交" });
    expect((submitted as HTMLButtonElement).disabled).toBe(true);
    const sent = requests.find((r) => r.path.endsWith("/retry"))!;
    expect(sent.path).toBe(`/v1/projects/${projectId}/retry`);
    expect(new Headers(sent.options.headers).get("Idempotency-Key")).toMatch(
      /^[a-f0-9-]{36}$/,
    );
  });
  it("logs in with a server session and passes CSRF on writes", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText("邮箱"), "admin@example.test");
    await user.type(screen.getByLabelText("密码"), "correct-password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByRole("heading", { name: "缓存实例" });
    expect(sessionStorage.getItem("expbuild-csrf")).toBe("test-csrf");
    expect(JSON.stringify(sessionStorage)).not.toContain("correct-password");
    expect(
      JSON.parse(
        requests.find((r) => r.path === "/v1/auth/login")!.options
          .body as string,
      ),
    ).toEqual({ email: "admin@example.test", password: "correct-password" });
  });
  it("hides destructive controls from viewers", async () => {
    role = "viewer";
    platform = false;
    sessionStorage.setItem("expbuild-csrf", "csrf");
    render(<App />);
    const create = await screen.findByRole("button", { name: "＋ 创建实例" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "＋ 新建项目" })).toBeNull();
  });
  it("validates cache capacity and only displays returned credentials in memory", async () => {
    sessionStorage.setItem("expbuild-csrf", "csrf");
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "＋ 创建实例" }),
    );
    await screen.findByRole("option", { name: "REAPI / Bazel HTTP" });
    expect(screen.queryByRole("option", { name: "WebDAV / HTTP" })).toBeNull();
    await user.type(screen.getByLabelText("实例名称"), "CI cache");
    await user.clear(screen.getByLabelText("缓存容量（GiB）"));
    await user.type(screen.getByLabelText("缓存容量（GiB）"), "20");
    await user.click(screen.getByRole("button", { name: "创建实例" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "缓存容量必须小于存储卷容量，以预留运行空间。",
    );
    expect(requests.some((r) => r.options.method === "POST")).toBe(false);
    await user.clear(screen.getByLabelText("缓存容量（GiB）"));
    await user.type(screen.getByLabelText("缓存容量（GiB）"), "16");
    await user.click(screen.getByRole("button", { name: "创建实例" }));
    await screen.findByDisplayValue("one-time-password");
    const sent = requests.find((r) => r.options.method === "POST")!;
    expect(new Headers(sent.options.headers).get("x-csrf-token")).toBe("csrf");
    expect(new Headers(sent.options.headers).get("Idempotency-Key")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(JSON.stringify(sessionStorage)).not.toContain("one-time-password");
    await user.click(screen.getByRole("button", { name: "已保存，关闭" }));
    await waitFor(() =>
      expect(screen.queryByDisplayValue("one-time-password")).toBeNull(),
    );
  });
});
