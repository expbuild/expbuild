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

it("explains template and reservation differences", async () => {
  vi.mocked(api).mockResolvedValue({
    checkedAt: new Date().toISOString(),
    result: {
      ...result,
      state: "Drift",
      issueCount: 2,
      issues: [
        {
          code: "TemplateIdentityConflict",
          kind: "CacheInstance",
          resourceName: "cache",
          instanceId: "id",
        },
        {
          code: "ResourceReservationInsufficient",
          kind: "PersistentVolumeClaim",
          resourceName: "cache-data",
          instanceId: "id",
        },
      ],
    },
  });
  render(<ResourceInventory base="/projects/one" />);
  fireEvent.click(screen.getByText("查看资源对账"));
  await screen.findByText("模板名称或版本与平台绑定不一致");
  await screen.findByText("实际资源配置超过账面预留");
});
it("offers a guarded reservation correction only to platform administrators", async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith("/inventory")
      ? {
          checkedAt: new Date().toISOString(),
          result: {
            ...result,
            state: "Drift",
            issueCount: 1,
            issues: [
              {
                code: "ResourceReservationInsufficient",
                kind: "PersistentVolumeClaim",
                resourceName: "cache-data",
                instanceId: "instance",
              },
            ],
          },
        }
      : { reserved: { storageGiB: "4", cpuMillis: "500", memoryMiB: "512" } },
  );
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const view = render(<ResourceInventory base="/projects/one" />);
  fireEvent.click(screen.getByText("查看资源对账"));
  await screen.findByText("实际资源配置超过账面预留");
  expect(screen.queryByText("校正资源预留")).toBeNull();
  view.rerender(<ResourceInventory base="/projects/one" canReconcile />);
  fireEvent.click(screen.getByText("校正资源预留"));
  await screen.findByText("已安排对账，结果将自动刷新。");
  expect(confirm).toHaveBeenCalled();
  expect(
    vi
      .mocked(api)
      .mock.calls.some(
        ([path, options]) =>
          path === "/projects/one/instances/instance/reservations/reconcile" &&
          options?.method === "POST",
      ),
  ).toBe(true);
  confirm.mockRestore();
});
