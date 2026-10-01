// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
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

it("does not display a late result from the previously selected instance", async () => {
  let finishOld!: (response: Response) => void;
  const old = new Promise<Response>((resolve) => {
    finishOld = resolve;
  });
  const snapshot = (items: number) =>
    new Response(
      JSON.stringify({
        observedAt: "2026-09-30T00:00:00Z",
        usedBytes: 1024,
        capacityBytes: 2048,
        itemCount: items,
        reservedBytes: 0,
      }),
    );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("/instances/old/") ? old : snapshot(22),
    ),
  );
  const view = render(<Statistics path="/projects/p/instances/old" running />);
  view.rerender(<Statistics path="/projects/p/instances/new" running />);
  await screen.findByText("22");
  await act(async () => {
    finishOld(snapshot(111));
    await old;
  });
  expect(screen.getByText("22")).toBeDefined();
  expect(screen.queryByText("111")).toBeNull();
});

it("labels WebDAV content snapshots without claiming cache hits or a hard quota", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            source: "webdav-content-scan",
            observedAt: new Date().toISOString(),
            usedBytes: 1024,
            capacityBytes: 3 * 1024 ** 3,
            itemCount: 7,
            reservedBytes: null,
          }),
        ),
    ),
  );
  render(<Statistics path="/projects/p/instances/dav" running />);
  expect(await screen.findByText("申请卷容量")).toBeDefined();
  expect(screen.getByText("文件条目")).toBeDefined();
  expect(screen.getByText(/不代表缓存命中率/)).toBeDefined();
});

it("shows Gradle request counts without presenting GET hits as task hits", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            source: "gradle-http-status",
            observedAt: new Date().toISOString(),
            usedBytes: 1024,
            capacityBytes: 3 * 1024 ** 3,
            itemCount: 7,
            reservedBytes: null,
            requestCounts: {
              getHits: 4,
              getMisses: 2,
              putSuccess: 1,
              putRejected: 0,
            },
          }),
        ),
    ),
  );
  render(<Statistics path="/projects/p/instances/gradle" running />);
  expect(await screen.findByText("GET 命中")).toBeDefined();
  expect(screen.getByText("GET 缺失")).toBeDefined();
  expect(screen.getByText(/不等同于构建任务命中率/)).toBeDefined();
});
