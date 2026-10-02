import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkRepository, registryErrors } from "./check-lockfile-registry.mjs";

test("accepts scoped/unscoped public npm tarballs and workspace links", () => {
  assert.deepEqual(
    registryErrors({
      packages: {
        "node_modules/tdigest": {
          resolved: "https://registry.npmjs.org/tdigest/-/tdigest-0.1.3.tgz",
        },
        "node_modules/@opentelemetry/api": {
          resolved:
            "https://registry.npmjs.org/@opentelemetry/api/-/api-1.9.1.tgz",
        },
        "node_modules/@expbuild/admin-api": {
          resolved: "apps/admin-api",
          link: true,
        },
        "apps/admin-api": { version: "0.1.0" },
      },
    }),
    [],
  );
});

for (const resolved of [
  "http://mirrors.tencentyun.com/npm/@opentelemetry/api/-/api-1.9.1.tgz",
  "http://mirrors.tencentyun.com/npm/bintrees/-/bintrees-1.0.2.tgz",
  "http://mirrors.tencentyun.com/npm/prom-client/-/prom-client-15.1.3.tgz",
  "http://mirrors.tencentyun.com/npm/tdigest/-/tdigest-0.1.3.tgz",
  "http://registry.npmjs.org/tdigest/-/tdigest-0.1.3.tgz",
  "https://registry.npmmirror.com/tdigest/-/tdigest-0.1.3.tgz",
  "https://registry.npmjs.org.example.com/pkg.tgz",
  "https://registry.npmjs.org@mirror.example.com/pkg.tgz",
  "https://user:password@registry.npmjs.org/pkg.tgz",
  "https://registry.npmjs.org:8443/pkg.tgz",
  "https://registry.npmjs.org/pkg.tgz?mirror=private",
  "git+https://github.com/example/pkg.git",
  "file:../pkg",
  "apps/admin-api",
  "",
  null,
]) {
  test(`rejects unapproved resolved source: ${resolved}`, () => {
    assert.equal(
      registryErrors({ packages: { "node_modules/pkg": { resolved } } }).length,
      1,
    );
  });
}

test("a link flag cannot disguise a remote source or an escaping local path", () => {
  for (const resolved of [
    "https://mirror.example.com/pkg.tgz",
    "../outside",
    "/absolute",
    "apps/../../outside",
  ]) {
    assert.equal(registryErrors({ resolved, link: true }).length, 1);
  }
});

test("finds legacy nested dependency URLs without checking unrelated metadata", () => {
  const errors = registryErrors({
    homepage: "http://example.com",
    dependencies: {
      outer: {
        resolved: "https://registry.npmjs.org/outer/-/outer-1.0.0.tgz",
        dependencies: {
          inner: { resolved: "https://private.example.com/inner.tgz" },
        },
      },
    },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /inner/);
});

test("CLI discovers root/nested lockfiles and shrinkwraps before dependency installation", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "expbuild-lockfiles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  mkdirSync(path.join(root, "apps/example"), { recursive: true });
  mkdirSync(path.join(root, "node_modules"));
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  const valid = JSON.stringify({
    packages: {
      pkg: { resolved: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" },
    },
  });
  writeFileSync(path.join(root, "package-lock.json"), valid);
  writeFileSync(path.join(root, "apps/example/npm-shrinkwrap.json"), valid);
  writeFileSync(
    path.join(root, "node_modules/package-lock.json"),
    "invalid JSON",
  );
  const script = fileURLToPath(
    new URL("./check-lockfile-registry.mjs", import.meta.url),
  );
  const run = () =>
    spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  assert.equal(run().status, 0);
  assert.equal(checkRepository(root).files.length, 2);
  execFileSync("git", ["add", "."], { cwd: root });
  assert.equal(checkRepository(root).files.length, 2);
  writeFileSync(
    path.join(root, "apps/example/package-lock.json"),
    JSON.stringify({
      dependencies: { bad: { resolved: "http://mirror.invalid/bad.tgz" } },
    }),
  );
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /apps\/example\/package-lock.json/);
  writeFileSync(
    path.join(root, "apps/example/package-lock.json"),
    "invalid JSON",
  );
  assert.equal(run().status, 1);
});
