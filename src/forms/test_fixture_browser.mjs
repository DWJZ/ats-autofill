/**
 * test_fixture_browser.mjs — resolving a browser to render the fixtures with.
 *
 * `browserCandidates` decides which cached browser build the fixture tests launch. It has to cope
 * with a cache that holds a different build than this `playwright-core` was released against, which
 * is the normal state of this laptop: the package wants one build, the cache holds another, and
 * re-downloading to satisfy a version pin is not worth it when the older build speaks the protocol.
 *
 * The resolution is a pure function of a directory listing and an `exists` probe, so it is checked
 * here without launching anything. Getting it wrong is invisible in production - the tests simply
 * skip, and a suite that skips silently is worse than one that fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserCandidates, fixtureUrl, FIXTURES } from "./fixture_browser.mjs";

/** A throwaway cache shaped like the real one, with the builds named in `builds`. */
function withFakeCache(builds, fn) {
  const root = mkdtempSync(join(tmpdir(), "jh-browsers-"));
  try {
    for (const build of builds) {
      const dir = build.startsWith("chromium_headless_shell")
        ? join(root, build, "chrome-headless-shell-mac-arm64")
        : join(root, build, "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, build.startsWith("chromium_headless_shell") ? "chrome-headless-shell" : "Chromium"), "");
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the newest cached build is tried first", () => {
  withFakeCache(["chromium_headless_shell-1000", "chromium_headless_shell-1243"], (root) => {
    const list = browserCandidates(root, existsSync).filter(p => p.startsWith(root));
    assert.equal(list.length, 2);
    assert.match(list[0], /chromium_headless_shell-1243/);
    assert.match(list[1], /chromium_headless_shell-1000/);
  });
});

test("a full chromium build is usable when no headless shell is cached", () => {
  withFakeCache(["chromium-1228"], (root) => {
    const list = browserCandidates(root, existsSync).filter(p => p.startsWith(root));
    assert.equal(list.length, 1);
    assert.match(list[0], /Chromium\.app\/Contents\/MacOS\/Chromium$/);
  });
});

test("an empty cache resolves to no candidate rather than a wrong path", () => {
  withFakeCache([], (root) => {
    assert.deepEqual(browserCandidates(root, existsSync).filter(p => p.startsWith(root)), []);
  });
});

test("a directory that is not there at all resolves to nothing", () => {
  assert.deepEqual(browserCandidates("/nonexistent/ms-playwright", () => false), []);
});

test("each candidate is an absolute path that exists", () => {
  // The real environment, checked for the property that matters: whatever it returns can be launched.
  const list = browserCandidates(join(process.env.HOME || "", "Library/Caches", "ms-playwright"));
  for (const candidate of list) {
    assert.ok(candidate.startsWith("/"), `${candidate} is not absolute`);
    assert.ok(existsSync(candidate), `${candidate} was offered as a candidate but does not exist`);
  }
});

test("a fixture URL points at a file that is there", () => {
  const url = fixtureUrl("ats_widgets.html");
  assert.ok(url.startsWith("file:///"), url);
  assert.equal(url, `file://${join(FIXTURES, "ats_widgets.html")}`);
  assert.ok(existsSync(join(FIXTURES, "ats_widgets.html")));
});
