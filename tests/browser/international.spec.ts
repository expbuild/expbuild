import { test, expect } from "@playwright/test";

test.use({ locale: "de-DE", viewport: { width: 1440, height: 1000 } });

test("international workspace: navigation, forms, language persistence and responsive layout", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.screenshot({
    path: testInfo.outputPath("login-en.png"),
    fullPage: true,
  });
  await page.getByLabel("Email", { exact: true }).fill("admin@browser.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "+ New project" }).click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Project name", { exact: true })
    .fill("Build infrastructure");
  await dialog
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "+ Create instance" }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "+ Create instance" }).click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Instance name", { exact: true })
    .fill("Linux build cache");
  await dialog.getByLabel("Language / 语言").selectOption("zh-CN");
  await expect(dialog.getByLabel("实例名称", { exact: true })).toHaveValue(
    "Linux build cache",
  );
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await dialog.getByLabel("Language / 语言").selectOption("en");
  await expect(dialog.getByLabel("Instance name", { exact: true })).toHaveValue(
    "Linux build cache",
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/v1/projects/*/instances", async (route) => {
    if (route.request().method() === "POST") await held;
    await route.continue();
  });
  await dialog
    .getByRole("button", { name: "Create instance", exact: true })
    .click();
  try {
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
  } finally {
    release();
  }

  await page.getByRole("button", { name: "Saved, close" }).click();
  const row = page.getByRole("row").filter({ hasText: "Linux build cache" });
  await expect(row).toContainText("Created");
  await page.screenshot({
    path: testInfo.outputPath("instances-en.png"),
    fullPage: true,
  });

  await page.getByLabel("Search instances", { exact: true }).fill("missing");
  await expect(
    page.getByRole("heading", { name: "No matching instances" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Details" }).click();
  await expect(page.getByText("Service ready")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Details" })).toBeFocused();

  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Instances", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Resources & quotas" }).click();
  await expect(
    page.getByLabel("Instances limit", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Resources & quotas" }),
  ).toBeVisible();
  await page.getByLabel("Language / 语言").selectOption("zh-CN");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "资源与配额" })).toBeVisible();
  await page.getByRole("link", { name: "缓存实例" }).click();
  await page.screenshot({
    path: testInfo.outputPath("instances-zh.png"),
    fullPage: true,
  });
  await page.getByLabel("Language / 语言").selectOption("en");
  await page.getByRole("link", { name: "Members & access" }).click();
  await expect(page.getByLabel("Member email", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Audit log" }).click();
  await expect(page.getByRole("columnheader", { name: "Actor" })).toBeVisible();
  await page.getByRole('link',{name:'Observability',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Project observability'})).toBeVisible();
  await expect(page.getByText('Valid observations cover 0 of 1 instances')).toBeVisible();
  await page.getByRole('link',{name:'Alerts',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Alerts',exact:true,level:1})).toBeVisible();
  await expect(page.getByText('No active alerts.')).toHaveCount(0);
  await page.getByRole('link',{name:'Platform health',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Platform health',exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('observability-health-en.png'),fullPage:true});
  await page.getByRole("link", { name: "Users", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "User directory" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.waitForResponse(response => response.url().endsWith("/v1/projects") && response.request().method() === "GET");
  await expect(page.getByRole("button", { name: "Toggle navigation" })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("link", { name: "Cache instances" }).click();
  await expect(
    page.getByRole("heading", { name: "Cache instances" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Toggle navigation" }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({
    path: testInfo.outputPath("instances-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "+ Create instance" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});
