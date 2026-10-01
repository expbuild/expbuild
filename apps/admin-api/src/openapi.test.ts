import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openapi } from "./openapi.js";
import SwaggerParser from "@apidevtools/swagger-parser";

test('published JSON matches the runtime contract',async()=>{
  const published=await readFile(new URL('../../../docs/k8s-platform/openapi.json',import.meta.url),'utf8');
  assert.equal(published,JSON.stringify(openapi,null,2)+'\n','regenerate docs/k8s-platform/openapi.json');
});

test("exported API contract validates as OpenAPI 3.1", async () => {
  const result = await SwaggerParser.validate(
    JSON.parse(JSON.stringify(openapi)),
  );
  assert.equal(result.info.title, "expbuild Management API");
});

test("OpenAPI covers every registered route and only resolves local schema references", async () => {
  const implemented = new Set<string>();
  for (const filename of ["app.ts", "instance-routes.ts"]) {
    const source = await readFile(new URL(filename, import.meta.url), "utf8");
    for (const match of source.matchAll(
      /app\.(get|post|patch|put|delete)\(\s*['"]([^'"]+)['"]/g,
    )) {
      implemented.add(
        `${match[1]} ${match[2]!.replace(/:([A-Za-z]+)/g, "{$1}")}`,
      );
    }
  }
  const documented = new Set<string>(),
    ids = new Set<string>();
  for (const [path, methods] of Object.entries(openapi.paths))
    for (const [method, value] of Object.entries(methods)) {
      documented.add(`${method} ${path}`);
      const operation = value as {
        operationId: string;
        parameters: { name: string; in: string; required: boolean }[];
        responses: Record<string, unknown>;
      };
      assert.ok(!ids.has(operation.operationId));
      ids.add(operation.operationId);
      for (const match of path.matchAll(/\{([^}]+)\}/g))
        assert.ok(
          operation.parameters.some(
            (p) => p.name === match[1] && p.in === "path" && p.required,
          ),
        );
      assert.ok(
        Object.keys(operation.responses).some((code) => code.startsWith("2")),
      );
    }
  assert.deepEqual([...documented].sort(), [...implemented].sort());
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref") {
        assert.equal(typeof child, "string");
        assert.ok(String(child).startsWith("#/components/schemas/"));
        assert.ok(openapi.components.schemas[String(child).split("/").at(-1)!]);
      } else visit(child);
    }
  }
  visit(openapi);
});

test("instance request schema retains input defaults and password fields are write-only", () => {
  const variants = (openapi.components.schemas.InstanceInput as { anyOf: {
    required: string[];
    properties: Record<string, { default?: unknown; const?: unknown }>;
  }[] }).anyOf;
  assert.equal(variants.length, 3);
  const input = variants.find(x => x.properties.template.const === 'bazel-remote')!;
  const webdav = variants.find(x => x.properties.template.const === 'webdav-apache')!;
  const gradle = variants.find(x => x.properties.template.const === 'gradle-http')!;
  assert.ok(webdav.required.includes('template'));
  assert.equal(webdav.properties.cacheGiB.const, 0);
  assert.ok(gradle.required.includes('template'));
  assert.ok(!input.required.includes('template'));
  assert.ok(input.required.includes("storageGiB"));
  assert.ok(!input.required.includes("cpuMillis"));
  assert.equal(input.properties.cpuMillis.default, 500);
  const login = openapi.paths["/v1/auth/login"].post as {
    security: unknown[];
    requestBody: {
      content: Record<
        string,
        { schema: { properties: { password: { writeOnly: boolean } } } }
      >;
    };
  };
  assert.deepEqual(login.security, []);
  assert.equal(
    login.requestBody.content["application/json"].schema.properties.password
      .writeOnly,
    true,
  );
});
