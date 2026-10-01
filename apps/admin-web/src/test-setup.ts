import { beforeEach } from "vitest";
import { setLocale } from "./i18n";
// Existing permission/lifecycle regressions run in Chinese; international
// behavior is exercised separately in i18n and browser tests.
beforeEach(() => {
  setLocale("zh-CN");
  history.replaceState(null, "", "/");
});
// jsdom does not implement the native dialog API. Real focus trapping and
// Escape behavior are verified in Chromium.
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};
