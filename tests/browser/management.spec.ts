import { test, expect, type Page } from '@playwright/test';

test.use({ locale: 'zh-CN' });

async function login(page: Page, email = 'admin@browser.test') {
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
}
async function createProject(page: Page, name: string) {
  await page.getByRole('button', { name: '＋ 新建项目' }).click();
  await page.getByLabel('项目名称', { exact: true }).fill(name);
  const response = page.waitForResponse(r => r.url().endsWith('/v1/projects') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  const created = await response;
  expect(created.status()).toBe(202);
  return (await created.json()).id as string;
}

test('real sessions, persisted quotas, CSRF rejection and cross-project denial', async ({ page }) => {
  await login(page);
  const project = await createProject(page, 'Browser persisted quota');
  await expect(page.getByRole('button', { name: '＋ 创建实例' })).toBeEnabled();
  await page.getByRole('link', { name: '资源与配额' }).click();
  await page.getByLabel('实例数上限', { exact: true }).fill('0');
  await page.getByLabel('存储（GiB）上限', { exact: true }).fill('12');
  await page.getByRole('button', { name: '保存配额', exact: true }).click();
  await expect(page.getByText('配额已保存', { exact: true })).toBeVisible();
  const rejected = await page.evaluate(async id => {
    const response = await fetch(`/v1/projects/${id}/quota`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': '2' }, body: JSON.stringify({ instances: 99, storageGiB: 99, cpuMillis: null, memoryMiB: null }) });
    return response.status;
  }, project);
  expect(rejected).toBe(403);
  await page.reload();
  await page.getByRole('link', { name: '资源与配额' }).click();
  await expect(page.getByLabel('实例数上限', { exact: true })).toHaveValue('0');
  await expect(page.getByLabel('存储（GiB）上限', { exact: true })).toHaveValue('12');
  const cookie = (await page.context().cookies()).find(c => c.name === 'expbuild_session');
  expect(cookie?.httpOnly).toBe(true);
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  expect(await page.evaluate(async () => (await fetch('/v1/auth/me')).status)).toBe(401);
  await login(page, 'outsider@browser.test');
  await expect(page.getByRole('button', { name: '＋ 新建项目' })).toHaveCount(0);
  expect(await page.evaluate(async id => (await fetch(`/v1/projects/${id}/quota`)).status, project)).toBe(404);
});

test('instance creation, one-time credentials, pause, resume and deletion through the console', async ({ page }) => {
  await login(page);
  await createProject(page, 'Browser instance lifecycle');
  await expect(page.getByRole('button', { name: '＋ 创建实例' })).toBeEnabled();
  await page.getByRole('button', { name: '＋ 创建实例' }).click();
  await page.getByLabel('实例名称', { exact: true }).fill('Browser cache');
  await page.getByLabel('删除实例时').selectOption('Delete');
  const creating = page.waitForResponse(r => r.url().endsWith('/instances') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '创建实例', exact: true }).click();
  expect((await creating).status()).toBe(202);
  const credential = page.getByRole('heading', { name: '保存连接凭据' }).locator('..');
  await expect(credential.getByLabel('用户名')).not.toHaveValue('');
  await expect(credential.getByLabel('密码')).not.toHaveValue('');
  await credential.getByRole('button', { name: '已保存，关闭' }).click();
  await expect(page.getByRole('heading', { name: '保存连接凭据' })).toHaveCount(0);

  const row = page.getByRole('row').filter({ hasText: 'Browser cache' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('已创建');
  await row.getByRole('button', { name: '详情' }).click();
  await expect(page.getByText('服务已就绪')).toBeVisible();
  await page.getByRole('button', { name: '编辑配置' }).click();
  await page.getByLabel('运行状态').selectOption('Suspended');
  const suspending = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().includes('/instances/'));
  await page.getByRole('button', { name: '保存配置' }).click();
  expect((await suspending).status()).toBe(202);
  await expect(page.getByText('服务尚未就绪')).toBeVisible();
  await expect(page.getByText('暂停', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: '编辑配置' }).click();
  await page.getByLabel('运行状态').selectOption('Running');
  const resuming = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().includes('/instances/'));
  await page.getByRole('button', { name: '保存配置' }).click();
  expect((await resuming).status()).toBe(202);
  await expect(page.getByText('服务已就绪')).toBeVisible();

  await page.getByRole('button', { name: '删除实例' }).click();
  await expect(page.getByText('存储卷也会被删除，缓存数据将丢失。')).toBeVisible();
  const deleting = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().includes('/instances/'));
  await page.getByRole('button', { name: '确认删除' }).click();
  expect((await deleting).status()).toBe(202);
  await expect(row).toContainText('已删除');
});

test('Gradle template can be created and displays a ready client configuration', async ({ page }) => {
  await login(page);
  await createProject(page, 'Browser Gradle cache');
  await expect(page.getByRole('button', { name: '＋ 创建实例' })).toBeEnabled();
  await page.getByRole('button', { name: '＋ 创建实例' }).click();
  await page.getByLabel('协议模板').selectOption('gradle-http');
  await page.getByLabel('实例名称', { exact: true }).fill('Gradle browser cache');
  const creating = page.waitForResponse(r => r.url().endsWith('/instances') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '创建实例', exact: true }).click();
  expect((await creating).status()).toBe(202);
  await page.getByRole('button', { name: '已保存，关闭' }).click();
  const row = page.getByRole('row').filter({ hasText: 'Gradle browser cache' });
  await expect(row).toContainText('Gradle HTTP');
  await row.getByRole('button', { name: '详情' }).click();
  await expect(page.getByText('服务已就绪')).toBeVisible();
  await page.getByText('客户端连接指引').click();
  await expect(page.getByText(/remote<HttpBuildCache>/)).toBeVisible();
});

test('two browser tabs cannot silently overwrite a stale quota revision', async ({ page }) => {
  await login(page);
  await createProject(page, 'Browser quota conflict');
  await page.getByRole('link', { name: '资源与配额' }).click();
  await expect(page.getByLabel('实例数上限', { exact: true })).toBeVisible();
  const opened = page.waitForEvent('popup');
  await page.evaluate(() => { window.open('/', '_blank'); });
  const second = await opened;
  await second.getByRole('link', { name: '资源与配额' }).click();
  await expect(second.getByLabel('实例数上限', { exact: true })).toBeVisible();
  await page.getByLabel('实例数上限', { exact: true }).fill('2');
  await page.getByRole('button', { name: '保存配额', exact: true }).click();
  await expect(page.getByText('配额已保存', { exact: true })).toBeVisible();
  await second.getByLabel('实例数上限', { exact: true }).fill('3');
  const rejected = second.waitForResponse(r => r.url().endsWith('/quota') && r.request().method() === 'PUT');
  await second.getByRole('button', { name: '保存配额', exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(second.getByRole('alert')).toContainText('刷新');
  await second.getByRole('button', { name: '刷新配额' }).click();
  await expect(second.getByLabel('实例数上限', { exact: true })).toHaveValue('2');
  await second.close();
});

test('moonrepo profile is discoverable on a ready REAPI instance without storing credentials', async ({ page }) => {
  await login(page);
  await createProject(page, 'Browser moonrepo cache');
  await page.getByRole('button', { name: '＋ 创建实例' }).click();
  await page.getByLabel('协议模板').selectOption('bazel-remote');
  await page.getByLabel('实例名称', { exact: true }).fill('Moon browser cache');
  const creating = page.waitForResponse(r => r.url().endsWith('/instances') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '创建实例', exact: true }).click();
  expect((await creating).status()).toBe(202);
  const credential = page.getByRole('heading', { name: '保存连接凭据' }).locator('..');
  const password = await credential.getByLabel('密码').inputValue();
  expect(password).not.toBe('');
  await credential.getByRole('button', { name: '已保存，关闭' }).click();
  const row = page.getByRole('row').filter({ hasText: 'Moon browser cache' });
  await row.getByRole('button', { name: '详情' }).click();
  await expect(page.getByText('服务已就绪')).toBeVisible();
  await page.getByText('客户端连接指引').click();
  await page.getByText('moonrepo 2.5.6 — 实验性配置', { exact: true }).click();
  await expect(page.getByText(/MOON_REMOTE_HOST=/)).toBeVisible();
  await expect(page.getByText(/独立 JSON 验证工作区/)).toBeVisible();
  expect(await page.getByRole('dialog').textContent()).not.toContain(password);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain(password);
});
