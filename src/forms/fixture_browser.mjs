/**
 * fixture_browser.mjs — a private headless browser for the fixture tests.
 *
 * The point of the fixtures is to verify the fillers without touching a live application. That only
 * works if the tests can render them, and rendering needs a real engine: the scanners walk shadow
 * roots, read `getComputedStyle`, measure `getBoundingClientRect` and rely on real visibility, so a
 * DOM stub would test the stub rather than the scanner.
 *
 * Three rules this module exists to enforce:
 *
 * 1. It launches its OWN browser. It never connects to the project instance on 9223, never touches
 *    the user's Chrome, and never opens a visible window. `chromium.launch({ headless: true })` runs
 *    a separate process with its own profile.
 * 2. A missing browser is a SKIP, not a failure. Tests run on a laptop where the cache may be empty
 *    or hold a different build than `playwright-core` was pinned to; treating that as a test failure
 *    would make `npm test` lie about the code.
 * 3. Resolution is a pure function of a directory listing, so `browserCandidates` is unit-testable
 *    without a browser at all.
 */
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WAIT_MS as PAGE_WAIT_MS, boundedPage, withDeadline } from "./bounded_waits.mjs";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** One fixture's total budget. A fixture scan is ~50-600 ms; this is two orders of magnitude above that. */
const FIXTURE_BUDGET_MS = 30_000;

/** Absolute path of a fixture page. */
export function fixturePath(name, dir = FIXTURES) {
  return join(dir, name);
}

/** `file://` URL for a fixture page, ready for `page.goto`. */
export function fixtureUrl(name, dir = FIXTURES) {
  return `file://${fixturePath(name, dir)}`;
}

/**
 * Every cached browser build that could serve the tests, best first.
 *
 * `chromium.executablePath()` names the build this `playwright-core` was released against. The cache
 * is shared and may hold a different one — older builds still speak the same protocol and are worth
 * trying before declaring the browser unavailable, which is cheaper than a re-download and keeps the
 * suite runnable offline.
 *
 * @param {string} cacheRoot - the playwright browser cache (e.g. `~/Library/Caches/ms-playwright`).
 * @param {(p: string) => boolean} exists - injectable so the ordering is testable without a cache.
 * @returns {string[]} absolute executable paths that exist, in preference order.
 */
export function browserCandidates(cacheRoot, exists = existsSync) {
  const found = [];
  const wanted = (() => {
    try {
      return chromium.executablePath();
    } catch {
      return "";
    }
  })();
  if (wanted && exists(wanted)) found.push(wanted);
  if (!exists(cacheRoot)) return found;

  let builds;
  try {
    builds = readdirSync(cacheRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      // Newest build number first: a later build is the more likely match for a later playwright-core.
      .sort((a, b) => (parseInt(b.split("-").pop(), 10) || 0) - (parseInt(a.split("-").pop(), 10) || 0));
  } catch {
    return found;
  }

  const relative = [
    ["chromium_headless_shell", ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64"], "chrome-headless-shell"],
    ["chromium", ["chrome-mac-arm64", "chrome-mac-x64"], "Chromium.app/Contents/MacOS/Chromium"],
  ];
  for (const build of builds) {
    for (const [prefix, platforms, tail] of relative) {
      if (!build.startsWith(prefix)) continue;
      for (const platform of platforms) {
        const candidate = join(cacheRoot, build, platform, tail);
        if (exists(candidate) && !found.includes(candidate)) found.push(candidate);
      }
    }
  }
  return found;
}

/**
 * Launch the first candidate that works, or return null when none can run.
 *
 * @param {string[]} candidates - from `browserCandidates`.
 * @returns {Promise<import("playwright-core").Browser|null>} null means "skip", never "fail".
 */
export async function launchHeadless(candidates) {
  for (const executablePath of candidates) {
    try {
      return await chromium.launch({ headless: true, executablePath });
    } catch {
      // Try the next build. A build that starts but cannot open a page is caught by the callers.
    }
  }
  return null;
}

/**
 * Open one fixture, hand the page to `fn`, and always close the page.
 *
 * EVERY WAIT HERE IS BOUNDED, because the page is where the suite's hangs came from and this is the one place
 * that hands a page to a test. `page.evaluate` and `locator.count()` have no timeout of their own - with the
 * renderer frozen they had still not returned after 45 s, and passing `{ timeout: 4000 }` did not make either
 * one give up - so a test reading a wedged fixture would block its file forever. The page is wrapped by
 * `boundedPage` and the per-fixture work gets a deadline of its own, so a fixture that stops answering fails
 * fast and names the read instead of hanging the suite.
 *
 * @param {import("playwright-core").Browser} browser
 * @param {string} name - fixture file name.
 * @param {(page: import("playwright-core").Page) => Promise<any>} fn
 * @param {number} [budgetMs] - the whole fixture's budget; well above the ~50-600 ms these take.
 */
export async function withFixture(browser, name, fn, budgetMs = FIXTURE_BUDGET_MS) {
  const raw = await browser.newPage();   // focus-ok: private headless browser, never the user's
  const page = boundedPage(raw, name, PAGE_WAIT_MS);
  try {
    await page.goto(fixtureUrl(name)).catch(() => {});
    return await withDeadline(fn(page), `the ${name} fixture work`, budgetMs);
  } finally {
    // The page is closed even when the work timed out, and the close itself is bounded: a browser that has
    // stopped answering must not turn the cleanup into the next hang.
    await withDeadline(raw.close().catch(() => {}), `closing ${name}`, PAGE_WAIT_MS).catch(() => {});
  }
}
