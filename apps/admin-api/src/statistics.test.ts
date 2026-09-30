import { test } from "node:test";
import assert from "node:assert/strict";
import { readEngineStatistics } from "./statistics.js";

test("statistics use the owned service address, authentication and explicit missing values", async () => {
  let requested = false;
  const fetcher: typeof fetch = async (url, options) => {
    requested = true;
    assert.equal(url, "http://cache.project.svc:8080/status");
    assert.equal(
      new Headers(options?.headers).get("Authorization"),
      `Basic ${Buffer.from("health:secret").toString("base64")}`,
    );
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal);
    return new Response(
      JSON.stringify({ CurrSize: 1024, MaxSize: 4096, NumFiles: 2 }),
    );
  };
  const result = await readEngineStatistics(
    "project",
    "cache",
    "health",
    "secret",
    fetcher,
  );
  assert.ok(requested);
  assert.equal(result.usedBytes, 1024);
  assert.equal(result.itemCount, 2);
  assert.equal(result.reservedBytes, null);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  await assert.rejects(
    readEngineStatistics("project", "evil/../../", "health", "secret", fetcher),
  );
});
test("invalid and oversized engine responses never become zero statistics", async () => {
  for (const value of [
    { MaxSize: 10, NumFiles: 0 },
    { CurrSize: -1, MaxSize: 10, NumFiles: 1 },
    { CurrSize: 0, MaxSize: 0, NumFiles: 0 },
    { CurrSize: Number.MAX_SAFE_INTEGER + 1, MaxSize: 10, NumFiles: 1 },
  ]) {
    await assert.rejects(
      readEngineStatistics(
        "project",
        "cache",
        "health",
        "secret",
        async () => new Response(JSON.stringify(value)),
      ),
    );
  }
  await assert.rejects(
    readEngineStatistics(
      "project",
      "cache",
      "health",
      "secret",
      async () => new Response("denied", { status: 401 }),
    ),
  );
  await assert.rejects(
    readEngineStatistics(
      "project",
      "cache",
      "health",
      "secret",
      async () => new Response(" ".repeat(65537)),
    ),
  );
});
