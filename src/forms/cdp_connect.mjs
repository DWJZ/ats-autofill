/**
 * cdp_connect.mjs — the ONE way a tool in this repository attaches to the debugging Chrome.
 *
 * WHY THIS EXISTS. `chromium.connectOverCDP(url)` makes Playwright create a `playwright-artifacts-<random>`
 * directory, and NOTHING REMOVES IT - not the caller, because every tool here ends with `process.exit(...)`, and
 * not Playwright either. Measured, on this checkout:
 *
 *   * `connectOverCDP(url)` then `process.exit(0)`   -> the directory stays
 *   * `connectOverCDP(url)` then `await browser.close()` -> the directory STILL stays (52 -> 53)
 *   * passing `artifactsDir` alone                   -> the directory moves, it does not disappear
 *
 * The last one is worth stating plainly because it is the tempting wrong fix: `artifactsDir` only chooses WHERE
 * the directory goes. The suite had known about this for a while - `test_fill_roundtrip.mjs` passes an
 * `artifactsDir` inside its own profile directory and then removes that directory itself, with a comment saying
 * the connection "ends with `process.exit` and so never reaches Playwright's own cleanup". Fifty files here
 * connect without any of that, so a normal day of driving forms left 119 of these directories in the system
 * temporary directory, and a test asserts a fill leaves none.
 *
 * WHAT THIS DOES INSTEAD. It makes the directory the PROCESS'S OWN, under a name that says which process, and
 * removes it on the way out:
 *
 *   * `ATS_CDP_ARTIFACTS_DIR` (or the repo's ignored `tmp/cdp-artifacts/`) holds one directory per process,
 *     named for the pid, so two tools running at once never share one;
 *   * `process.on("exit", ...)` removes it SYNCHRONOUSLY, which is the only hook that runs for a tool whose last
 *     act is `process.exit(0)` - an async cleanup would never be reached;
 *   * `SIGINT`/`SIGTERM` are turned into a normal exit so a Ctrl-C also cleans up;
 *   * directories left by KILLED runs (a `SIGKILL` cannot run any handler) are swept by the next run, but only
 *     when they are old enough that no live process could own them.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never touches the browser: no navigation, no `bringToFront`, no
 * `browser.close()` on a Chrome this process did not start. Attaching and detaching is the whole of it, which is
 * the standing rule for this repository (see docs/RULES.md and `src/tools/check_no_focus_steal.py`).
 */
import { chromium } from "playwright-core";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the per-process directories live. `tmp/` is generated and gitignored, like every other scratch path. */
export const ARTIFACTS_ROOT = process.env.ATS_CDP_ARTIFACTS_DIR
  || join(HERE, "..", "..", "tmp", "cdp-artifacts");

/** The default CDP endpoint: the toolkit's own port, and the one `chrome_launch.mjs` starts a browser on. */
export const DEFAULT_CDP = "http://127.0.0.1:9223";

/** How old a directory must be before a later run may remove it: no live process owns one this stale. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** This process's own artifacts directory. Named for the pid so two tools never share one. */
export function artifactsDirFor(pid = process.pid) {
  return join(ARTIFACTS_ROOT, `cdp-${pid}`);
}

/**
 * Remove directories left by runs that were KILLED rather than exited.
 *
 * A `SIGKILL`, a crashed node, or a machine that lost power runs no handler at all, so those directories are
 * nobody's to clean up at the time. The next tool to start sweeps them - and only when they are old, because a
 * directory younger than `STALE_AFTER_MS` may belong to a tool that is running RIGHT NOW and about to need it.
 */
export function sweepStaleArtifacts(root = ARTIFACTS_ROOT, now = Date.now()) {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    const path = join(root, name);
    try {
      if (now - statSync(path).mtimeMs < STALE_AFTER_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // A directory that cannot be read or removed is not this call's problem; the next run tries again.
    }
  }
  return removed;
}

/**
 * Attach to the running Chrome, with this process's own artifacts directory removed on the way out.
 *
 * @param {string} [cdp] - the CDP endpoint. Defaults to the toolkit's port.
 * @param {{quiet?: boolean, root?: string}} [options] - `quiet` silences the sweep line; `root` overrides where
 *   the directories live (used by the test, which must not write into the checkout's `tmp/`).
 * @returns {Promise<import("playwright-core").Browser>}
 */
export async function connect(cdp = DEFAULT_CDP, options = {}) {
  const root = options.root || ARTIFACTS_ROOT;
  const dir = join(root, `cdp-${process.pid}`);
  mkdirSync(dir, { recursive: true });

  const swept = sweepStaleArtifacts(root);
  if (swept.length && !options.quiet) {
    console.error(`cdp_connect: removed ${swept.length} artifacts director${swept.length === 1 ? "y" : "ies"} left by killed runs`);
  }

  // SYNCHRONOUS ON PURPOSE. `process.on("exit")` may only run synchronous work, and it is the one hook that
  // fires for a tool whose last statement is `process.exit(0)`. An `await` here would silently never run.
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.on("exit", cleanup);
  // A Ctrl-C or a `kill` also deserves a clean exit, so the handler above gets its chance.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      cleanup();
      process.exit(130);
    });
  }

  return chromium.connectOverCDP(cdp, { artifactsDir: dir });
}
