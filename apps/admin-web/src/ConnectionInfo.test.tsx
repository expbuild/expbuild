// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { spawnSync } from 'node:child_process';
import { ConnectionInfo, connectionExample } from './ConnectionInfo';
import type { Detail } from './api';
afterEach(cleanup);
const detail = (): Detail => ({
  id: 'cache', name: 'Cache', lifecycle: 'active', revision: 'uid:2',
  spec: { templateRef: { name: 'bazel-remote', version: '0.1.0' }, desiredState: 'Running', access: { exposure: 'Gateway' }, storage: { capacity: '3Gi', deletionPolicy: 'Retain' }, eviction: { maxCacheGiB: 1 }, resources: { limits: { cpu: '500m', memory: '512Mi' } } },
  status: { conditions: [{ type: 'Ready', status: 'True', reason: 'Available', observedGeneration: 2 }], endpoints: [{ protocol: 'reapi', url: 'grpcs://grpc.example.test' }] },
});
it('shows protocol-specific commands only for the current ready revision', () => {
  const value = detail();
  const view = render(<ConnectionInfo detail={value} />);
  expect(screen.getByText(/bazel build/).textContent).toContain("--remote_cache='grpcs://grpc.example.test'");
  expect(screen.getByText(/客户端需要能够解析/)).toBeTruthy();
  value.status!.conditions![0].observedGeneration = 1;
  view.rerender(<ConnectionInfo detail={value} />);
  expect(screen.queryByText(/bazel build/)).toBeNull();
  expect(screen.getByText(/当前配置尚未确认就绪/)).toBeTruthy();
  value.status!.conditions![0].observedGeneration = 2;
  value.spec!.desiredState = 'Suspended';
  view.rerender(<ConnectionInfo detail={value} />);
  expect(screen.queryByText(/bazel build/)).toBeNull();
  value.spec!.desiredState = 'Running';
  value.lifecycle = 'detached';
  view.rerender(<ConnectionInfo detail={value} />);
  expect(screen.queryByText(/bazel build/)).toBeNull();
});
it('never includes credentials, unsupported schemes or ambiguous endpoint URLs', () => {
  for (const url of ['https://user:password@example.test', 'https://example.test?token=secret', 'https://example.test#secret', 'file:///tmp/cache', 'https://example.test/\necho', 'not a URL']) {
    expect(connectionExample({ protocol: 'webdav', url })).toBeNull();
  }
  expect(connectionExample({ protocol: 'reapi', url: 'https://example.test' })).toBeNull();
  expect(connectionExample({ protocol: 'unknown', url: 'https://example.test' })).toBeNull();
  const example = connectionExample({ protocol: 'webdav', url: 'https://dav.example.test/' })!;
  expect(example).toContain('--request PROPFIND');
  expect(example).toContain("--header 'Depth: 0'");
  expect(example).not.toContain('--insecure');
});
it('Bash examples preserve literal addresses and encode interactive credentials correctly', () => {
  const url = "http://cache.example.test/$(unexpected)'";
  const text = connectionExample({ protocol: 'bazel-http', url })!;
  const result = spawnSync('bash', ['-c', `unexpected() { printf INJECTED; }; bazel() { printf '%s\\n' "$@"; };\n${text}`], { input: 'test-user\ntest-password\n', encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`--remote_cache=${url}\n`);
  expect(result.stdout).not.toContain('INJECTED');
  expect(result.stdout).toContain('--remote_header=Authorization=Basic ' + Buffer.from('test-user:test-password').toString('base64'));
  const dav = connectionExample({ protocol: 'webdav', url: 'http://dav.example.test/' })!;
  const probe = spawnSync('bash', ['-c', `curl() { printf '%s\\n' "$@"; };\n${dav}`], { input: 'test-user\n', encoding: 'utf8' });
  expect(probe.status).toBe(0);
  expect(probe.stdout).toContain('--user\ntest-user\n');
  expect(probe.stdout).toContain('PROPFIND\n');
});
