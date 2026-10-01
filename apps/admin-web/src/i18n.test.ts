import { expect, it } from "vitest";
import { detectLocale, formatDate, formatNumber, setLocale, t } from "./i18n";
import { messages } from "./messages";
import { sections } from "./ui";
import { operationNames, stateNames } from "./api";

it("honors a saved preference and falls back to English for unsupported languages", () => {
  expect(detectLocale("en", ["zh-CN"])).toBe("en");
  expect(detectLocale("zh-CN", ["en-US"])).toBe("zh-CN");
  for (const language of ["en-US", "de-DE", "ar", "zh-TW", "fr-FR"])
    expect(detectLocale(null, [language])).toBe("en");
  expect(detectLocale(null, ["zh-Hans-CN"])).toBe("zh-CN");
  expect(detectLocale("invalid", [])).toBe("en");
});
it("changes document language, persists preference, and formats dates and numbers", () => {
  setLocale("en");
  expect(document.documentElement.lang).toBe("en");
  expect(localStorage.getItem("expbuild-locale")).toBe("en");
  expect(formatNumber(12345.6)).toBe("12,345.6");
  expect(formatDate("invalid")).toBe("—");
  expect(formatDate("2026-10-01T00:00:00Z")).toContain("Oct");
  expect(t("显示 {shown} / {total} 个实例", { shown: 1, total: 4 })).toBe(
    "Showing 1 of 4 instances",
  );
  setLocale("zh-CN");
  expect(t("显示 {shown} / {total} 个实例", { shown: 1, total: 4 })).toBe(
    "显示 1 / 4 个实例",
  );
});
it("retains all interpolation parameters across translations", () => {
  const params = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const [source, translation] of Object.entries(messages)) {
    expect(translation.trim(), source).not.toBe("");
    expect(params(translation), source).toEqual(params(source));
  }
  for (const source of [
    ...Object.values(operationNames),
    ...Object.values(stateNames),
    ...sections.flatMap((section) => [section.label, section.description]),
  ])
    expect(messages[source], source).toBeTruthy();
});
it("has English translations for every static UI message", () => {
  const sources = import.meta.glob<string>("./*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  for (const [name, source] of Object.entries(sources)) {
    if (name.includes(".test.") || name.includes("test-setup")) continue;
    for (const match of source.matchAll(/\bt\(\s*"([^"\n]+)"/g))
      expect(messages[match[1]], `${name}: ${match[1]}`).toBeTruthy();
  }
});
