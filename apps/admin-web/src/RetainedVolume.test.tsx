// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RetainedVolume } from "./RetainedVolume";
const volume = {
  name: "cache-data",
  namespace: "project",
  uid: "volume-uid",
  capacity: "10Gi",
  allocatedCapacity: "10Gi",
  storageClass: "standard",
  phase: "Bound",
  deleting: false,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
it("offers the verified retained volume to the project administrator for reclaim", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(volume))),
  );
  const onReclaim = vi.fn();
  const user = userEvent.setup();
  render(
    <RetainedVolume
      path="/projects/p/instances/i/retained-volume"
      canAdmin
      onChange={vi.fn()}
      onReclaim={onReclaim}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "使用保留卷恢复实例" }),
  );
  expect(onReclaim).toHaveBeenCalledWith(volume);
});
it("requires the exact volume name and preserves identity and idempotency after an ambiguous response", async () => {
  const deletes: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, options: RequestInit) => {
      if (options.method !== "DELETE")
        return new Response(JSON.stringify(volume));
      deletes.push(options);
      if (deletes.length === 1) throw new Error("Connection interrupted");
      return new Response(
        JSON.stringify({ operation: { id: "op", state: "pending" } }),
        { status: 202 },
      );
    }),
  );
  sessionStorage.setItem("expbuild-csrf", "csrf");
  const user = userEvent.setup();
  render(
    <RetainedVolume
      path="/projects/p/instances/i/retained-volume"
      canAdmin
      onChange={vi.fn()}
    />,
  );
  const input = await screen.findByRole("textbox", {
    name: "输入卷名确认清理",
  });
  const button = screen.getByRole("button", { name: "永久清理保留卷" });
  expect(button.hasAttribute("disabled")).toBe(true);
  await user.type(input, "cache");
  expect(button.hasAttribute("disabled")).toBe(true);
  await user.clear(input);
  await user.type(input, "cache-data");
  await user.click(button);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Connection interrupted",
  );
  await user.click(button);
  expect((await screen.findByRole("status")).textContent).toContain("等待结果");
  expect(deletes).toHaveLength(2);
  const first = new Headers(deletes[0].headers),
    second = new Headers(deletes[1].headers);
  expect(first.get("If-Match")).toBe("volume-uid");
  expect(first.get("Idempotency-Key")).toBe(second.get("Idempotency-Key"));
  expect(second.get("x-csrf-token")).toBe("csrf");
  expect(screen.queryByRole("button", { name: "永久清理保留卷" })).toBeNull();
});
it("allows a viewer to inspect storage without a cleanup action", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(volume))),
  );
  render(
    <RetainedVolume
      path="/projects/p/instances/i/retained-volume"
      canAdmin={false}
      onChange={vi.fn()}
    />,
  );
  await screen.findByText(/cache-data/);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "永久清理保留卷" })).toBeNull();
});
it("does not offer cleanup when the volume cannot be verified", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "volume_ownership_conflict" }), {
          status: 409,
        }),
    ),
  );
  render(
    <RetainedVolume
      path="/projects/p/instances/i/retained-volume"
      canAdmin
      onChange={vi.fn()}
    />,
  );
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "永久清理保留卷" })).toBeNull();
});
