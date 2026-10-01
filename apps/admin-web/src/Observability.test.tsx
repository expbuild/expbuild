import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  InstanceObservability,
  MetricChart,
  ProjectObservability,
} from "./Observability";
import { setLocale } from "./i18n";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("keeps zero values and missing spans distinct in charts and accessible samples", async () => {
  const { container } = render(
    <MetricChart
      series={{
        name: "used_bytes",
        unit: "bytes",
        points: [
          [1000, 0],
          [1060, 1],
          [1120, null],
          [1180, 3],
          [1240, 0],
        ],
      }}
    />,
  );
  expect(container.querySelectorAll("polyline")).toHaveLength(2);
  await userEvent.click(screen.getByText("查看采样值"));
  expect(screen.getByText("—")).toBeTruthy();
  expect(screen.getAllByText("0").length).toBeGreaterThan(1);
});
it("does not query logs for viewers and shows unsupported instead of zero", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      calls.push(path);
      return new Response(JSON.stringify({ state: "unsupported", series: [] }));
    }),
  );
  setLocale("en");
  render(
    <InstanceObservability
      path="/projects/project/instances/instance"
      canEdit={false}
    />,
  );
  expect(await screen.findByText("Unsupported by this template")).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Runtime logs" })).toBeNull();
  await userEvent.click(
    screen.getByRole("tab", { name: "Cache effectiveness" }),
  );
  await waitFor(() =>
    expect(calls.some((p) => p.includes("group=lookups"))).toBe(true),
  );
  expect(calls.some((p) => p.includes("/logs"))).toBe(false);
});
it("configured alerting failure never becomes a healthy empty alert list", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(JSON.stringify({ state: "error", items: [] })),
    ),
  );
  setLocale("en");
  render(
    <ProjectObservability
      base="/projects/project"
      canEdit={false}
      alertsOnly
    />,
  );
  expect(
    (await screen.findAllByText("Data temporarily unavailable")).length,
  ).toBeGreaterThan(0);
  expect(screen.queryByText("No active alerts.")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Silence for one hour" }),
  ).toBeNull();
});
