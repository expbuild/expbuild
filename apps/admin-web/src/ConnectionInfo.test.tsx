// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { spawnSync } from "node:child_process";
import { ConnectionInfo, connectionExample } from "./ConnectionInfo";
import type { Detail } from "./api";
afterEach(cleanup);
const detail = (): Detail => ({
  id: "cache",
  name: "Cache",
  lifecycle: "active",
  revision: "uid:2",
  spec: {
    templateRef: { name: "bazel-remote", version: "0.1.0" },
    desiredState: "Running",
    access: { exposure: "Gateway" },
    storage: { capacity: "3Gi", deletionPolicy: "Retain" },
    eviction: { maxCacheGiB: 1 },
    resources: { limits: { cpu: "500m", memory: "512Mi" } },
  },
  status: {
    conditions: [
      {
        type: "Ready",
        status: "True",
        reason: "Available",
        observedGeneration: 2,
      },
    ],
    endpoints: [{ protocol: "reapi", url: "grpcs://grpc.example.test" }],
  },
});
it("shows protocol-specific commands only for the current ready revision", () => {
  const value = detail();
  const view = render(<ConnectionInfo detail={value} />);
  expect(screen.getByText(/bazel build/).textContent).toContain(
    "--remote_cache='grpcs://grpc.example.test'",
  );
  expect(screen.getByText(/客户端需要能够解析/)).toBeTruthy();
  value.status!.conditions![0].observedGeneration = 1;
  view.rerender(<ConnectionInfo detail={value} />);
  expect(screen.queryByText(/bazel build/)).toBeNull();
  expect(screen.getByText(/当前配置尚未确认就绪/)).toBeTruthy();
  value.status!.conditions![0].observedGeneration = 2;
  value.spec!.desiredState = "Suspended";
  view.rerender(<ConnectionInfo detail={value} />);
  expect(screen.queryByText(/bazel build/)).toBeNull();
  value.spec!.desiredState = "Running";
  value.lifecycle = "detached";
  view.rerender(<ConnectionInfo detail={value} />);
  expect(screen.queryByText(/bazel build/)).toBeNull();
});
it("never includes credentials, unsupported schemes or ambiguous endpoint URLs", () => {
  for (const url of [
    "https://user:password@example.test",
    "https://example.test?token=secret",
    "https://example.test#secret",
    "file:///tmp/cache",
    "https://example.test/\necho",
    "not a URL",
  ]) {
    expect(connectionExample({ protocol: "webdav", url })).toBeNull();
  }
  expect(
    connectionExample({ protocol: "reapi", url: "https://example.test" }),
  ).toBeNull();
  expect(
    connectionExample({ protocol: "unknown", url: "https://example.test" }),
  ).toBeNull();
  expect(
    connectionExample({
      protocol: "gradle-http",
      url: "https://example.test/wrong/",
    }),
  ).toBeNull();
  const example = connectionExample({
    protocol: "webdav",
    url: "https://dav.example.test/",
  })!;
  expect(example).toContain("--request PROPFIND");
  expect(example).toContain("--header 'Depth: 0'");
  expect(example).not.toContain("--insecure");
});
it("Bash examples preserve literal addresses and encode interactive credentials correctly", () => {
  const url = "http://cache.example.test/$(unexpected)'";
  const text = connectionExample({ protocol: "bazel-http", url })!;
  const result = spawnSync(
    "bash",
    [
      "-c",
      `unexpected() { printf INJECTED; }; bazel() { printf '%s\\n' "$@"; };\n${text}`,
    ],
    { input: "test-user\ntest-password\n", encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`--remote_cache=${url}\n`);
  expect(result.stdout).not.toContain("INJECTED");
  expect(result.stdout).toContain(
    "--remote_header=Authorization=Basic " +
      Buffer.from("test-user:test-password").toString("base64"),
  );
  const dav = connectionExample({
    protocol: "webdav",
    url: "http://dav.example.test/",
  })!;
  const probe = spawnSync(
    "bash",
    ["-c", `curl() { printf '%s\\n' "$@"; };\n${dav}`],
    { input: "test-user\n", encoding: "utf8" },
  );
  expect(probe.status).toBe(0);
  expect(probe.stdout).toContain("--user\ntest-user\n");
  expect(probe.stdout).toContain("PROPFIND\n");
  const gradle = connectionExample({
    protocol: "gradle-http",
    url: "https://cache.example.test/cache/$(unexpected)'",
  });
  expect(gradle).toBeNull();
  const gradleValid = connectionExample({
    protocol: "gradle-http",
    url: "https://cache.example.test/cache/",
  })!;
  expect(gradleValid).toContain("remote<HttpBuildCache>");
  expect(gradleValid).toContain('System.getenv("CI") == "true"');
  expect(gradleValid).not.toContain("isAllowUntrustedServer");
});

it("shows experimental profiles only from the API and for the current ready endpoint", () => {
  const value = detail();
  value.clientProfiles = [{ id: "pants", protocol: "reapi", version: "2.33.1", status: "experimental" }];
  const view = render(<ConnectionInfo detail={value} />);
  expect(screen.getByText(/pants 2.33.1/)).toBeTruthy();
  expect(screen.getByText(/实例凭据仍具备写入权限/)).toBeTruthy();
  expect(screen.getByText(/PANTS_REMOTE_PROVIDER=reapi/)).toBeTruthy();
  value.clientProfiles[0].version = "unknown";
  view.rerender(<ConnectionInfo detail={value} />);
  expect(screen.queryByText(/PANTS_REMOTE_PROVIDER=reapi/)).toBeNull();
  value.clientProfiles[0].version = "2.33.1";
  value.status!.conditions![0].observedGeneration = 1;
  view.rerender(<ConnectionInfo detail={value} />);
  expect(screen.queryByText(/PANTS_REMOTE_PROVIDER=reapi/)).toBeNull();
});

it("renders Nx as an experimental profile with an instance-bound token recipe", () => {
  const value = detail();
  value.id = "d21dd71b-3710-4b47-b6a6-8b660a0811cb";
  value.spec!.templateRef = { name: "nx-http", version: "0.1.0" };
  value.clientProfiles = [{ id: "nx", protocol: "nx-http", version: "22.7.12", status: "experimental" }];
  value.status!.endpoints = [{ protocol: "nx-http", url: "https://nx.example.test/" }];
  const view = render(<ConnectionInfo detail={value} />);
  expect(screen.getByText(/nx 22.7.12/)).toBeTruthy();
  expect(screen.getByText(/NX_SELF_HOSTED_REMOTE_CACHE_SERVER=/).textContent).toContain("export NX_SELF_HOSTED_REMOTE_CACHE_SERVER='https://nx.example.test'");
  expect(screen.queryByText(/当前端点尚无/)).toBeNull();
  value.spec!.desiredState = "Suspended";
  view.rerender(<ConnectionInfo detail={value} />);
  expect(screen.queryByText(/NX_SELF_HOSTED_REMOTE_CACHE_SERVER=/)).toBeNull();
});
