// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LookupHistory } from "./LookupHistory";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("loads on demand and separates missing values, lookup kinds and time windows", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          start: 0,
          end: 60,
          rateWindowSeconds: 300,
          series: [
            { kind: "cas", method: "get", outcome: "hit", points: [[60, 2.5]] },
            {
              kind: "cas",
              method: "get",
              outcome: "miss",
              points: [[60, null]],
            },
          ],
        }),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<LookupHistory path="/projects/p/instances/i" />);
  expect(fetcher).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "查看查询历史" }));
  await screen.findByText("2.5");
  expect(screen.getByText("—")).toBeTruthy();
  await user.selectOptions(screen.getByLabelText("缓存类型"), "ac");
  await screen.findByText(/此范围暂无有效采样/);
  await user.selectOptions(screen.getByLabelText("时间范围"), "24h");
  expect(fetcher.mock.calls.length).toBe(2);
});
it("does not turn failed monitoring into zero activity", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
    ),
  );
  render(<LookupHistory path="/projects/p/instances/i" />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "查看查询历史" }));
  await screen.findByText(/历史统计暂不可用/);
  expect(screen.queryByRole("table")).toBeNull();
});
