import { test, expect, type Page } from '@playwright/test';

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
  await expect(page.getByRole('button', { name: '＋ 创建实例' })).toBeDisabled();
  await page.getByRole('button', { name: '查看项目配额' }).click();
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
  await page.getByRole('button', { name: '查看项目配额' }).click();
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

test('two browser tabs cannot silently overwrite a stale quota revision', async ({ page }) => {
  await login(page);
  await createProject(page, 'Browser quota conflict');
  await page.getByRole('button', { name: '查看项目配额' }).click();
  await expect(page.getByLabel('实例数上限', { exact: true })).toBeVisible();
  const opened = page.waitForEvent('popup');
  await page.evaluate(() => { window.open('/', '_blank'); });
  const second = await opened;
  await second.getByRole('button', { name: '查看项目配额' }).click();
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
