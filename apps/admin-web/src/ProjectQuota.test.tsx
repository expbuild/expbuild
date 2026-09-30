// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ProjectQuota } from "./ProjectQuota";
import { api } from "./api";
vi.mock("./api", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const value = {
  limits: { instances: 5, storageGiB: 100, cpuMillis: null, memoryMiB: 8192 },
  reserved: { instances: 2, storageGiB: 20, cpuMillis: 1000, memoryMiB: 1024 },
  unknownReservations: 0,
  revision: "7",
};
describe("project quotas", () => {
  it("shows reservations to members without edit controls", async () => {
    vi.mocked(api).mockResolvedValue(value);
    render(<ProjectQuota base="/projects/one" canEdit={false} />);
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("查看项目配额"));
    await screen.findByText("配额由平台管理员调整。");
    expect(screen.queryByText("保存配额")).toBeNull();
    expect(screen.getByText("不限")).toBeTruthy();
  });
  it("saves zero and unlimited distinctly with the quota revision", async () => {
    vi.mocked(api).mockResolvedValue(value);
    render(<ProjectQuota base="/projects/one" canEdit />);
    fireEvent.click(screen.getByText("查看项目配额"));
    const field = await screen.findByLabelText("实例数上限");
    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.click(screen.getByText("保存配额"));
    await screen.findByText("配额已保存");
    const [, options] = vi.mocked(api).mock.calls[1];
    expect(options?.headers).toEqual({ "If-Match": "7" });
    expect(JSON.parse(options?.body as string)).toEqual({
      ...value.limits,
      instances: 0,
    });
  });
  it("preserves errors and does not present unknown reservations as complete usage", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ ...value, unknownReservations: 1 })
      .mockRejectedValueOnce(new Error("Project quota changed"));
    render(<ProjectQuota base="/projects/one" canEdit />);
    fireEvent.click(screen.getByText("查看项目配额"));
    await screen.findByText(/1 个资源预留待核对/);
    fireEvent.click(screen.getByText("保存配额"));
    await screen.findByText(/Project quota changed/);
    expect(screen.queryByText("配额已保存")).toBeNull();
    await waitFor(() =>
      expect(screen.getByText("保存配额").hasAttribute("disabled")).toBe(false),
    );
  });
});
