// v0.9.1 keeps appearance/language controls in Settings, not the top toolbar.
// Run against an isolated server: E2E_BASE_URL=http://127.0.0.1:30143 node e2e/themes.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30141";
const artifacts = fileURLToPath(new URL("../test-results/themes/", import.meta.url));
const themes = ["light", "dark", "mist", "rose", "pine", "auto"];
const labels = ["Light", "Dark", "Mist", "Rose", "Pine", "System"];
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});

function contrast(a, b) {
  const luminance = (hex) => {
    const digits = hex.length === 4 ? [...hex.slice(1)].map((digit) => digit + digit).join("") : hex.slice(1);
    const channels = digits.match(/../g).map((part) => {
      const value = parseInt(part, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US", colorScheme: "light", reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(/\/api\/sessions(?:\?.*)?$/, (route) => route.fulfill({ json: { sessions: [], runningSessionIds: [], sessionListVersion: 0 } }));
    await page.goto(base, { waitUntil: "networkidle" });
    const openSettings = async () => {
      const sidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
      if (width <= 640) await sidebar.waitFor();
      if (await sidebar.isVisible()) await sidebar.click();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
    };
    const expectTheme = async (theme) => {
      await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
      const dark = theme === "dark" || theme === "pine";
      assert.equal(await page.locator("html").evaluate((root) => root.classList.contains("dark")), dark);
      assert.equal(await page.locator("html").evaluate((root) => getComputedStyle(root).colorScheme), dark ? "dark" : "light");
    };
    await openSettings();
    for (const [index, theme] of themes.entries()) {
      const radio = page.getByRole("radio", { name: labels[index], exact: true });
      await radio.locator("..").click();
      await expectTheme(theme === "auto" ? "light" : theme);
      assert.equal(await radio.isChecked(), true);
      assert.equal(await page.evaluate(() => localStorage.getItem("pi-theme")), theme);
      const colors = await page.locator("html").evaluate((root) => {
        const style = getComputedStyle(root);
        return Object.fromEntries(["bg", "bg-panel", "bg-hover", "bg-selected", "user-bg", "assistant-bg", "tool-bg", "text", "text-muted", "text-dim", "accent", "accent-hover", "accent-contrast"].map((key) => [key, style.getPropertyValue(`--${key}`).trim()]));
      });
      for (const foreground of ["text", "text-muted", "text-dim", "accent"]) {
        for (const background of ["bg", "bg-panel", "bg-hover", "bg-selected", "user-bg", "assistant-bg", "tool-bg"]) {
          assert.ok(contrast(colors[foreground], colors[background]) >= 4.5, `${theme}: ${foreground} on ${background} must meet WCAG AA`);
        }
      }
      for (const background of ["accent", "accent-hover"]) assert.ok(contrast(colors["accent-contrast"], colors[background]) >= 4.5);
      assert.equal(await page.locator(".settings-theme-option").evaluateAll((options) => options.every((option) => {
        const label = option.querySelector(".settings-theme-option-label");
        const box = option.getBoundingClientRect();
        const text = label.getBoundingClientRect();
        return option.scrollWidth <= option.clientWidth && text.right <= box.right && text.bottom <= box.bottom;
      })), true, `Theme labels must fit at ${width}px`);
      assert.equal(await page.locator(".settings-theme-option svg").count(), 6);
      await page.screenshot({ path: `${artifacts}/${theme}-${width}.png`, animations: "disabled" });
      await page.reload({ waitUntil: "networkidle" });
      await expectTheme(theme === "auto" ? "light" : theme);
      // The local usage entry must remain usable with every upstream palette.
      if (width <= 640) await page.locator("[data-mobile-toolbar-more]").click();
      await page.getByRole("button", { name: "Token usage", exact: true }).click();
      const usage = page.getByRole("dialog", { name: "Token usage", exact: true });
      await usage.locator(".usage-card").first().waitFor();
      const bounds = await usage.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await usage.getByRole("button", { name: "Close", exact: true }).click();
      await openSettings();
      assert.equal(await radio.isChecked(), true, "Selection must survive refresh");
    }
    await page.emulateMedia({ colorScheme: "dark" });
    await expectTheme("dark");
    await page.getByRole("radio", { name: "Pine", exact: true }).locator("..").click();
    await page.emulateMedia({ colorScheme: "light" });
    await expectTheme("pine");
    const light = page.getByRole("radio", { name: "Light", exact: true });
    await light.focus();
    await light.press("ArrowRight");
    await expectTheme("dark");
    assert.equal(await page.getByRole("radio", { name: "Dark", exact: true }).isChecked(), true);

    for (const [locale, name] of [["zh-CN", /^简体中文/], ["zh-TW", /^繁體中文/], ["en", /^English/]]) {
      await page.getByRole("radio", { name }).click();
      assert.equal(await page.evaluate(() => localStorage.getItem("pi-locale")), locale);
    }
    await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    await page.reload({ waitUntil: "networkidle" });
    await expectTheme("dark");
    assert.equal(await page.getByRole("button", { name: /^Theme:/ }).count(), 0, "Theme controls belong in Settings");
    assert.equal(await page.getByRole("button", { name: "Language", exact: true }).count(), 0, "Language controls belong in Settings");
    if (width === 1440) {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      for (const key of ["bg", "bg-panel", "bg-hover", "bg-selected", "border", "text", "text-muted", "text-dim", "user-bg", "tool-bg"]) {
        const hex = await page.locator("html").evaluate((root, token) => getComputedStyle(root).getPropertyValue(`--${token}`).trim(), key);
        const channels = hex.slice(1).match(hex.length === 4 ? /./g : /../g);
        assert.equal(new Set(channels).size, 1, `Dark ${key} must remain neutral gray`);
      }
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: Settings palettes/languages, contrast, persistence, system preference, keyboard, icons and local usage`);
    await context.close();
  }
} finally {
  await browser.close();
}
