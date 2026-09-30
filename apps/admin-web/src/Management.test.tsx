// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectManagement, UsersPanel } from "./Management";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

it("requires confirmation before disabling a user and prevents self-disable", async () => {
  const requests: { path: string; options: RequestInit }[] = [];
  const actor = {
    id: "admin",
    email: "admin@example.test",
    platform_admin: true,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit = {}) => {
      requests.push({ path, options });
      return response(
        options.method
          ? { ok: true }
          : {
              items: [
                { ...actor, active: true },
                {
                  id: "other",
                  email: "other@example.test",
                  platform_admin: false,
                  active: true,
                },
              ],
            },
      );
    }),
  );
  const user = userEvent.setup();
  render(<UsersPanel actor={actor} />);
  const ownRow = (await screen.findByText(actor.email)).closest("tr")!;
  expect(
    (within(ownRow).getByRole("button", { name: "停用" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  const row = screen.getByText("other@example.test").closest("tr")!;
  await user.click(within(row).getByRole("button", { name: "停用" }));
  expect(requests.some((x) => x.options.method === "PATCH")).toBe(false);
  await user.click(screen.getByRole("button", { name: "确认停用" }));
  expect(requests.find((x) => x.options.method === "PATCH")).toMatchObject({
    path: "/v1/users/other",
    options: { body: JSON.stringify({ active: false }) },
  });
  await user.click(within(screen.getByText('other@example.test').closest('tr')!).getByRole('button',{name:'重置密码'}));
  await screen.findByRole('heading',{name:'重置 other@example.test 的密码'});
  await user.type(screen.getByLabelText('新密码'),'reset-password-123');
  await user.type(screen.getByLabelText('确认新密码'),'reset-password-123');
  await user.click(screen.getByRole('button',{name:'确认更新密码'}));
  expect(requests.find(x=>x.path==='/v1/users/other/password')?.options.body).toBe(JSON.stringify({password:'reset-password-123'}));
});

it("adds members by email and preserves last-administrator errors", async () => {
  const requests: { path: string; options: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit = {}) => {
      requests.push({ path, options });
      if (options.method === "DELETE")
        return response({ error: "Project must retain an administrator" }, 409);
      if (options.method) return response({ ok: true });
      return response({
        items: [{ id: "admin", email: "admin@example.test", role: "admin" }],
      });
    }),
  );
  const user = userEvent.setup();
  render(<ProjectManagement base="/projects/one" />);
  await user.click(screen.getByRole("button", { name: "成员权限" }));
  await screen.findByText("admin@example.test");
  await user.type(screen.getByLabelText("成员邮箱"), "new@example.test");
  await user.selectOptions(screen.getByLabelText("项目角色"), "maintainer");
  await user.click(screen.getByRole("button", { name: "添加成员" }));
  expect(requests.find((x) => x.options.method === "POST")?.options.body).toBe(
    JSON.stringify({ email: "new@example.test", role: "maintainer" }),
  );
  await user.click(screen.getByRole("button", { name: "移除" }));
  expect(requests.some((x) => x.options.method === "DELETE")).toBe(false);
  await user.click(screen.getByRole("button", { name: "确认移除" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Project must retain an administrator",
  );
  expect(screen.getByRole("button", { name: "确认移除" })).toBeDefined();
});
