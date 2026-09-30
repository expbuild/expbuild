// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Statistics } from "./Statistics";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("shows collection failure as unavailable rather than a zero", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
    ),
  );
  render(<Statistics path="/projects/p/instances/i" running />);
  expect(
    (await screen.findByText("统计采集暂不可用。暂无有效数据。")).textContent,
  ).toContain("暂无有效数据");
  expect(screen.queryByRole("progressbar")).toBeNull();
});
it("does not scrape a suspended instance", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(<Statistics path="/projects/p/instances/i" running={false} />);
  expect(screen.getByText("实例未运行，实时统计不可用。")).toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
});
