// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RotateCredential } from "./RotateCredential";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
it("retries rotation with the original version and never persists the password", async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, options: RequestInit) => {
      calls.push(options);
      if (calls.length === 1) throw new Error("Connection interrupted");
      return new Response(
        JSON.stringify({
          credentials: { username: "cache", password: "new-cache-password" },
        }),
        { status: 202 },
      );
    }),
  );
  const user = userEvent.setup(),
    onChange = vi.fn(),
    onClose = vi.fn();
  const view = render(
    <RotateCredential
      base="/projects/p"
      id="i"
      revision="uid:1"
      onChange={onChange}
      onClose={onClose}
    />,
  );
  expect(calls).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "确认轮换" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Connection interrupted",
  );
  view.rerender(
    <RotateCredential
      base="/projects/p"
      id="i"
      revision="uid:2"
      onChange={onChange}
      onClose={onClose}
    />,
  );
  await user.click(screen.getByRole("button", { name: "确认轮换" }));
  await screen.findByDisplayValue("new-cache-password");
  expect(new Headers(calls[1].headers).get("If-Match")).toBe('"uid:1"');
  expect(new Headers(calls[1].headers).get("Idempotency-Key")).toBe(
    new Headers(calls[0].headers).get("Idempotency-Key"),
  );
  expect(onChange).toHaveBeenCalledOnce();
  expect(JSON.stringify(sessionStorage)).not.toContain("new-cache-password");
  await user.click(screen.getByRole("button", { name: "关闭" }));
  expect(onClose).toHaveBeenCalledOnce();
});
