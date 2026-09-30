// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResourceInventory } from "./ResourceInventory";
import { api } from "./api";
vi.mock("./api", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const result = {
  state: "Healthy",
  issues: [],
  issueCount: 0,
  truncated: false,
  busyInstances: 0,
  counts: { instances: 1, volumes: 1 },
};
it("shows resource differences without destructive actions", async () => {
  vi.mocked(api).mockResolvedValue({
    checkedAt: new Date().toISOString(),
    result: {
      ...result,
      state: "Drift",
      issueCount: 1,
      issues: [
        {
          code: "MissingRetainedVolume",
          kind: "PersistentVolumeClaim",
          resourceName: "c-example-data",
          instanceId: "instance",
        },
      ],
    },
  });
  render(<ResourceInventory base="/projects/one" />);
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("查看资源对账"));
  await screen.findByText("保留卷丢失");
  expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  fireEvent.click(screen.getByText("请求重新对账"));
  await screen.findByText("已安排对账，结果将自动刷新。");
  expect(
    vi
      .mocked(api)
      .mock.calls.some(
        ([path, options]) =>
          path === "/projects/one/inventory/refresh" &&
          options?.method === "POST",
      ),
  ).toBe(true);
});
it("does not label an unavailable scan as an empty healthy inventory", async () => {
  vi.mocked(api).mockResolvedValue({
    checkedAt: new Date().toISOString(),
    result: { ...result, state: "Unavailable", counts: null },
  });
  render(<ResourceInventory base="/projects/one" />);
  fireEvent.click(screen.getByText("查看资源对账"));
  await screen.findByText("无法完成对账，请检查集群连接或权限");
  expect(screen.queryByText("未发现资源差异")).toBeNull();
});
it("marks old observations stale", async () => {
  vi.mocked(api).mockResolvedValue({
    checkedAt: "2020-01-01T00:00:00Z",
    result,
  });
  render(<ResourceInventory base="/projects/one" />);
  fireEvent.click(screen.getByText("查看资源对账"));
  await screen.findByText("结果已过期，请重新对账后判断当前状态。");
  expect(screen.queryByText("未发现资源差异")).toBeNull();
});
