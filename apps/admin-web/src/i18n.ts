import { useSyncExternalStore } from "react";
import { messages } from "./messages";
export type Locale = "en" | "zh-CN";
const key = "expbuild-locale";
export function detectLocale(
  saved: string | null,
  languages: readonly string[],
): Locale {
  if (saved === "en" || saved === "zh-CN") return saved;
  // Only simplified Chinese is currently translated. All other locales use English.
  return /^(zh|zh-CN|zh-SG|zh-Hans(?:-.+)?)$/i.test(languages[0] ?? "")
    ? "zh-CN"
    : "en";
}
function initialLocale(): Locale {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(key);
  } catch {
    /* Storage may be disabled. */
  }
  return detectLocale(
    saved,
    typeof navigator === "undefined" ? [] : navigator.languages,
  );
}
let locale: Locale = initialLocale();
const listeners = new Set<() => void>();
function updateDocument() {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
    document.title =
      locale === "zh-CN"
        ? "expbuild · 缓存管理"
        : "expbuild · Cache management";
  }
}
updateDocument();
export function setLocale(value: Locale) {
  locale = value;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* In-memory preference still works. */
  }
  updateDocument();
  listeners.forEach((listener) => listener());
}
export function useLocale() {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    () => locale,
    () => "en" as Locale,
  );
}
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === key) {
      locale = detectLocale(event.newValue, navigator.languages);
      updateDocument();
      listeners.forEach((listener) => listener());
    }
  });
export function t(
  message: string,
  values: Record<string, string | number> = {},
): string {
  const text = locale === "zh-CN" ? message : (messages[message] ?? message);
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    String(values[name] ?? match),
  );
}
export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
) {
  return new Intl.NumberFormat(locale, options).format(value);
}
export function formatDate(value: string | number | Date) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
