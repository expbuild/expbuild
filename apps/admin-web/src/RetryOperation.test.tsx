// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RetryOperation } from "./RetryOperation";
import type { Operation } from "./api";
const operation: Operation = {
  id: "op",
  instance_id: "i",
  kind: "instance.create",
  state: "failed",
  error_code: "operation_deadline_exceeded",
  target_generation: "1",
  created_at: "2026-09-30T00:00:00Z",
  updated_at: "2026-09-30T00:20:00Z",
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
it("confirms recovery, keeps the same key after an ambiguous failure, and blocks repeated submission", async () => {
  const calls: { path: string; options: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit) => {
      calls.push({ path, options });
      if (calls.length === 1) throw new Error("Connection interrupted");
      return new Response(
        JSON.stringify({ operation: { ...operation, state: "reconciling" } }),
        { status: 202 },
      );
    }),
  );
  sessionStorage.setItem("expbuild-csrf", "csrf");
  const user = userEvent.setup(),
    onChange = vi.fn();
  render(
    <RetryOperation
      base="/projects/p"
      operation={operation}
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("button", { name: "恢复检查" }));
  expect(calls).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "确认恢复" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Connection interrupted",
  );
  await user.click(screen.getByRole("button", { name: "确认恢复" }));
  await screen.findByRole("status");
  expect(calls).toHaveLength(2);
  expect(calls[0].path).toBe("/v1/projects/p/operations/op/retry");
  expect(new Headers(calls[1].options.headers).get("Idempotency-Key")).toBe(
    new Headers(calls[0].options.headers).get("Idempotency-Key"),
  );
  expect(new Headers(calls[1].options.headers).get("x-csrf-token")).toBe(
    "csrf",
  );
  expect(screen.queryByRole("button", { name: "确认恢复" })).toBeNull();
  expect(onChange).toHaveBeenCalledOnce();
});
it("shows rejected recovery without claiming success", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: "A newer instance operation exists" }),
          { status: 409 },
        ),
    ),
  );
  const user = userEvent.setup(),
    onChange = vi.fn();
  render(
    <RetryOperation
      base="/projects/p"
      operation={operation}
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("button", { name: "恢复检查" }));
  await user.click(screen.getByRole("button", { name: "确认恢复" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "A newer instance operation exists",
  );
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
});
it("requires explicit deletion confirmation for deletion recovery", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ operation: { ...operation, state: "reconciling" } }),
        { status: 202 },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(
    <RetryOperation
      base="/projects/p"
      operation={{
        ...operation,
        kind: "instance.delete",
        target_generation: null,
      }}
      onChange={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "继续删除" }));
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getByText(/此操作不会撤销删除/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "确认恢复" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "确认继续删除" }));
  await screen.findByRole("status");
  expect(fetch).toHaveBeenCalledOnce();
});
