// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PasswordForm } from "./PasswordForm";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
it("checks confirmation, submits current password and clears session state", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, reauthenticate: true })),
  );
  vi.stubGlobal("fetch", fetch);
  sessionStorage.setItem("expbuild-csrf", "csrf");
  const user = userEvent.setup(),
    changed = vi.fn();
  render(<PasswordForm onClose={() => {}} onChanged={changed} />);
  await user.type(screen.getByLabelText("当前密码"), "old-password");
  await user.type(screen.getByLabelText("新密码"), "new-password-123");
  await user.type(screen.getByLabelText("确认新密码"), "other-password-123");
  await user.click(screen.getByRole("button", { name: "确认更新密码" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "两次输入的新密码不一致。",
  );
  expect(fetch).not.toHaveBeenCalled();
  await user.clear(screen.getByLabelText("确认新密码"));
  await user.type(screen.getByLabelText("确认新密码"), "new-password-123");
  await user.click(screen.getByRole("button", { name: "确认更新密码" }));
  await screen.findByRole("status");
  expect(changed).toHaveBeenCalledOnce();
  expect(sessionStorage.getItem("expbuild-csrf")).toBeNull();
  expect(fetch).toHaveBeenCalledWith(
    "/v1/auth/password",
    expect.objectContaining({
      body: JSON.stringify({
        password: "new-password-123",
        currentPassword: "old-password",
      }),
    }),
  );
});
