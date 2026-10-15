#!/usr/bin/env node
/**
 * chrome_launch.mjs — start the project's OWN Chrome when nothing is answering on the port, and never touch a
 * Chrome the tool did not start.
 *
 * WHY THIS EXISTS. The toolkit only ever attached: `cdp_tabs.mjs` and every filler call `chromium.connectOverCDP`
 * on `http://127.0.0.1:9223` and fail against a closed port, so the first thing a person met on a fresh checkout
 * was "connect ECONNREFUSED" with no tool in the repository that could fix it. The launcher was a shell script
 * the README told the reader to save as their own and run by hand — which means the instructions to start the
 * browser lived outside the repository that needed it, in whatever the reader had open at the time.
 *
 * WHAT CHANGED, AND WHAT DID NOT. The user has asked for a tool that may start an instance when there is none
 * running. The half that protects the person is unchanged and is the larger half:
 *
 *   - IT NEVER ENDS OR RESTARTS ANYTHING. This script starts a browser or it does nothing; there is no stop or
 *     terminate command anywhere in it. A Chrome it did not start is not a Chrome it can end.
 *   - IT ATTACHES WHEN THE PORT ALREADY ANSWERS, and starting is the branch taken only when it does not. That is
 *     what makes "never start a second instance" true by construction rather than by discipline.
 *   - ITS PROFILE IS ITS OWN, inside the data directory (`<data>/chrome-cdp-profile`), so nothing here reads or
 *     writes the profile of whatever browser the person is using, and no signed-in session of theirs is touched.
 *     The profile is not merely defaulted to that directory: a `--profile` outside it is REFUSED, because a
 *     launcher that can be pointed at a personal profile is a launcher that will be, once, and the cost is
 *     somebody's live session.
 *
 * HEADLESS BY DEFAULT, AND WHY THAT IS A JUDGEMENT RATHER THAN A PREFERENCE. A window that appears is a window
 * that takes the focus, and this project has a standing rule against that. `--headless=new` renders and drives
 * over the same DevTools protocol as a windowed instance, and the suite already proves the fillers work that way:
 * `test_fill_roundtrip.mjs` launches Chrome with `--headless` and runs every real filler against it. So headless
 * is the default, and `--visible` is how the person gets a window when they need one — signing in to a board for
 * the first time in a fresh profile, or finishing a CAPTCHA — which a headless instance cannot offer them.
 *
 * WHAT A TEST CAN PIN, AND WHAT IT CANNOT. The decision — probe the port, attach or start — is a pure function
 * here, so `test_chrome_launch.mjs` holds it without a browser, and the command line is asserted as data. What no
 * test in this checkout can pin is the part that needs a real Chrome: that this machine's Chrome binary accepts
 * these flags, comes up, and answers on the port. `--probe` is how a person checks that, and it is the reason the
 * startup wait reports its own timeout instead of throwing.
 *
 * USAGE
 *   node src/forms/chrome_launch.mjs                  # ensure: attach if the port answers, otherwise start one
 *   node src/forms/chrome_launch.mjs --visible        # start with a window when the person must interact
 *   node src/forms/chrome_launch.mjs --probe          # report whether the port answers, start nothing
 *   node src/forms/chrome_launch.mjs --print-command  # report the decision and the command line, spawn nothing
 *   node src/forms/chrome_launch.mjs --port 9333      # a port other than the toolkit's default
 *   node src/forms/chrome_launch.mjs --extra-args "--no-sandbox --disable-gpu"
 *                                                     # extra Chrome flags, appended before the URL
 *   ATS_CHROME_EXTRA_ARGS="--no-sandbox" node src/forms/chrome_launch.mjs   # the same, via the environment
 *   node src/forms/chrome_launch.mjs --help           # this block
 *
 * `--extra-args` / `$ATS_CHROME_EXTRA_ARGS` take one space-joined string of Chrome flags, e.g.
 * `--no-sandbox --disable-gpu`. They are DELIBERATELY OPT-IN: a launcher run from an ordinary terminal keeps
 * the exact command line it always had, because `--no-sandbox` is a security tradeoff nobody should get by
 * default. The case they exist for is an agent running this launcher INSIDE a file sandbox, where Chrome dies
 * within seconds without them (`Failed to initialize sandbox` ... `GPU process isn't usable. Goodbye.`) —
 * `test_fill_roundtrip.mjs` passes the same two flags for the same reason. Flags the launcher itself owns
 * (`--remote-debugging-port`, `--user-data-dir`, `--no-first-run`, `--no-default-browser-check`, `--headless`,
 * `--profile`) are refused inside extra args, and so is any token that is not a `--flag`.
 *
 * EXIT STATUS: 0 when the port answers at the end, 2 when it does not (so a caller can tell the two apart
 * without reading English), 1 on a refusal to start — a reserved port, a profile outside the data directory, an
 * invalid `--extra-args` value, or no browser found.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { DATA_DIR, ROOT } from "../paths.mjs";

//: The port every other tool in this repository defaults to (`--cdp` overrides it). Kept here as the one value
//: this file owns; `cdp_tabs.mjs` and the fillers spell the same URL, and changing it is a change to all of them.
export const DEFAULT_PORT = 9223;

//: Ports this launcher refuses outright, whatever it is asked to do with them. 9222 answers on many machines
//: because another program — here, the harness running the agent — put a Chrome there, and a profile of this
//: toolkit's own is exactly what must not be started beside it. A refusal is the only safe answer: attaching
//: would write this toolkit's tabs into somebody else's browser, and starting would race it for the port.
export const RESERVED_PORTS = new Set([9222]);

//: Where the launched profile lives: inside the DATA directory, so it travels with the configuration rather than
//: with the checkout, and so `ATS_DATA_DIR` pointing somewhere else gives that configuration its own browser.
export const PROFILE_DIRNAME = "chrome-cdp-profile";

//: The environment variable that carries the same value `--extra-args` takes. `ATS_` because the data directory
//: setting (`ATS_DATA_DIR`) and the download escape hatch (`ATS_NO_SOFFICE_DOWNLOAD`) already use that prefix.
export const EXTRA_ARGS_ENV = "ATS_CHROME_EXTRA_ARGS";

//: The launcher's own flags. An extra-args token that names one of these would put two values for the same
//: switch on one command line, with Chrome free to pick either — so the launcher refuses it instead.
export const OWNED_FLAGS = [
  "--remote-debugging-port",
  "--user-data-dir",
  "--no-first-run",
  "--no-default-browser-check",
  "--headless",
  "--profile",
];

/**
 * Turn the `--extra-args` value (one space-joined string of Chrome flags) into the tokens to append, or refuse.
 *
 * The rules are what make the option safe to offer at all: every token must be a `--flag` (a bare word here
 * would become a URL, and the launch already ends with `about:blank`), and none may name a flag this launcher
 * builds itself. An empty or absent value is simply "no extra flags" — the documented default command line.
 */
export function parseExtraArgs(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return { ok: true, reason: "", tokens: [] };
  }
  const tokens = String(value).trim().split(/\s+/);
  for (const token of tokens) {
    if (!token.startsWith("--") || token === "--") {
      return { ok: false, reason: `extra-args token ${JSON.stringify(token)} is not a --flag; the value must be one space-joined string of Chrome flags, e.g. "--no-sandbox --disable-gpu"`, tokens: [] };
    }
    const name = token.split("=", 1)[0];
    if (OWNED_FLAGS.includes(name)) {
      return { ok: false, reason: `extra-args may not set ${name}: the launcher builds that flag itself, and one switch twice is a command line Chrome may read either way`, tokens: [] };
    }
  }
  return { ok: true, reason: "", tokens };
}

/** Every Chrome build worth launching, best first. `$CHROME_PATH` first so a person can name theirs. */
export function findChrome(env = process.env, exists = existsSync) {
  const wanted = [
    env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    // Playwright's own download, which is a Chromium the fixture tests already trust on this machine.
    `${env.HOME || ""}/Library/Caches/ms-playwright/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
  ];
  for (const candidate of wanted) {
    if (!candidate) continue;
    if (candidate.includes("*")) continue;   // a glob is a path a shell expands, not a path to open
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * The flags for a browser this tool owns. Pure, so the exact command line is assertable as data.
 *
 * `about:blank` rather than a URL: a page handed to the process at startup can be torn down before a CDP client
 * attaches, which shows up later as "target has been closed" on the first navigation — `test_fill_roundtrip.mjs`
 * records the same finding. The one token a static guard looks for here is `background` and it is not in this
 * command line at all: that token belongs to opening a TAB inside a browser that is already running.
 */
export function launchArgs({ port = DEFAULT_PORT, profileDir, headless = true, extraArgs = [] } = {}) {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(headless ? ["--headless=new"] : []),
    ...extraArgs,
    "about:blank",
  ];
}

/**
 * Would this profile path be one this tool may write to? A launcher that accepts any path is a launcher that can
 * be pointed at the profile of the browser the person is using, and starting Chrome against a profile already in
 * use either fails or attaches to their session — both are the thing this rule exists to prevent. So the path is
 * checked, not trusted: it must be the tool's own directory under the data directory, and it must not be the data
 * directory itself (which would scatter a browser profile through the configuration).
 */
export function profileIsOwned(profileDir, dataDir = DATA_DIR) {
  if (!profileDir) return { ok: false, reason: "no profile directory given" };
  const resolved = resolve(String(profileDir));
  const base = resolve(String(dataDir));
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    return { ok: false, reason: `profile is outside the data directory (${base})` };
  }
  if (resolved === base) {
    return { ok: false, reason: "profile is the data directory itself, not a directory inside it" };
  }
  return { ok: true, reason: "" };
}

/**
 * What to do, given what the port said and whether a browser can be found. Pure: every branch below is a
 * decision a test can hold without a browser, which is the half of this file that can be verified here at all.
 *
 * The single rule the shape of this function is built around: an answering port is never started against. What
 * `probePort` found is reported and the caller stops, even when the answer came from something that is not
 * Chrome — the alternative is a second browser on the same port, which is the failure the user's requirement
 * names first.
 */
export function decide({ probe, browserPath, profileDir, port = DEFAULT_PORT, headless = true, dataDir = DATA_DIR, extraArgs = [] } = {}) {
  if (!probe || typeof probe.answering !== "boolean") {
    return { action: "error", reason: "no probe result", exitCode: 1 };
  }
  if (probe.answering) {
    return {
      action: "attach",
      reason: probe.looksLikeChrome
        ? "the port already answers as a browser we can attach to"
        : `the port answers, but not as a Chrome DevTools endpoint (${probe.detail}) — stopping rather than starting a second instance`,
      probe,
      exitCode: 0,
    };
  }
  if (!browserPath) {
    return {
      action: "error",
      reason: "nothing is answering on the port and no Chrome binary was found — set $CHROME_PATH, or start a "
        + "browser yourself and re-run with --probe to confirm it",
      probe,
      exitCode: 1,
    };
  }
  const owned = profileIsOwned(profileDir, dataDir);
  if (!owned.ok) return { action: "error", reason: `refusing to start: ${owned.reason}`, probe, exitCode: 1 };
  return {
    action: "start",
    reason: probe.kind === "timeout"
      ? "nothing answered on the port within the timeout"
      : `nothing is listening on the port (${probe.detail})`,
    browserPath,
    args: launchArgs({ port, profileDir, headless, extraArgs }),
    profileDir,
    port,
    headless,
    probe,
    exitCode: 0,
  };
}

/**
 * Read a `/json/version` body as a browser identity, or null when it is not one.
 *
 * A CDP endpoint always names its own protocol version. The check is positive on purpose: a port that answers
 * with some unrelated service must not be read as "Chrome is up", and must not be attached to either.
 */
export function readVersion(body) {
  let parsed;
  try {
    parsed = JSON.parse(String(body || ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !parsed["Protocol-Version"]) return null;
  return {
    browser: typeof parsed.Browser === "string" ? parsed.Browser : "",
    protocolVersion: String(parsed["Protocol-Version"]),
    webSocketDebuggerUrl: typeof parsed.webSocketDebuggerUrl === "string" ? parsed.webSocketDebuggerUrl : "",
  };
}

/** Is the port answering, and does it answer as a browser? Never throws: a refused connection is an answer. */
export async function probePort({ port = DEFAULT_PORT, timeoutMs = 1200, fetchImpl = fetch } = {}) {
  const url = `http://127.0.0.1:${port}/json/version`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return { answering: true, looksLikeChrome: false, url, kind: "http-error", detail: `HTTP ${response.status}` };
    }
    const body = await response.text();
    const version = readVersion(body);
    if (!version) {
      return {
        answering: true, looksLikeChrome: false, url, kind: "not-a-browser",
        detail: "answered with something that is not a DevTools version document",
      };
    }
    return { answering: true, looksLikeChrome: true, url, kind: "browser", detail: version.browser, version };
  } catch (error) {
    const name = (error && error.name) || "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { answering: false, looksLikeChrome: false, url, kind: "timeout", detail: `no answer within ${timeoutMs}ms` };
    }
    return { answering: false, looksLikeChrome: false, url, kind: "refused", detail: String((error && error.message) || error) };
  }
}

/** How long a launched browser gets to answer before the caller is told it did not. */
export function startupDeadlineMs({ attempts = 60, delayMs = 250 } = {}) {
  return attempts * delayMs;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Start the browser this tool owns. Detached and with stdio discarded, so it outlives this process: the point of
 * launching it is that the NEXT command finds it already there.
 *
 * `--no-sandbox` is deliberately absent. `test_fill_roundtrip.mjs` passes it because a Playwright-spawned
 * renderer inside the file sandbox dies without it, and it says so; this launcher starts the person's own Chrome
 * from an ordinary terminal, which is the case the flag is not for.
 */
export function startChrome({ browserPath, args }) {
  const child = spawn(browserPath, args, { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}

async function waitForBrowser({ port, attempts, delayMs }) {
  let probe = null;
  for (let i = 0; i < attempts; i += 1) {
    probe = await probePort({ port });
    if (probe.answering) return probe;
    await sleep(delayMs);
  }
  return probe;   // the last miss, so the caller can say WHY it never came up
}

/** Read `--flag value` / `--flag=value`, and report the boolean flags that are set. */
export function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq > 0) {
      values[token.slice(0, eq)] = token.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (token === "--extra-args" && next && next.includes(" ")) {
      // `--extra-args "--no-sandbox --disable-gpu"` arrives as ONE argv item whose first character is `--`,
      // so the generic rule below would read it as a flag of its own and the value would vanish. A quoted
      // value is the only spelling that can contain a space; a bare `--flag` after the option is the UNQUOTED
      // mistake and stays a flag, which `main` refuses with the quoting message.
      values[token] = next;
      i += 1;
    } else if (next && !next.startsWith("--")) {
      values[token] = next;
      i += 1;
    } else {
      flags.add(token);
    }
  }
  return { flags, values };
}

//: The `--help` page. The one option that changed since the file first shipped is spelled out in full, because
//: it is opt-in on purpose and the header above explains why.
const HELP_TEXT = `chrome_launch.mjs — ensure the toolkit's own debugging Chrome is running, starting one only
when nothing answers on the port. It never stops or restarts a browser it did not start.

  --visible                start with a window (default is headless, so nothing takes the focus)
  --probe                  report whether the port answers and start nothing
  --print-command          report the decision and the exact command line, spawn nothing
  --port <n>               a port other than the default ${DEFAULT_PORT}
  --profile <dir>          the launch profile (must be inside the data directory)
  --extra-args <flags>     extra Chrome flags, space-joined, appended before the URL; OPT-IN, e.g.
                           --extra-args "--no-sandbox --disable-gpu" for a launcher running inside a
                           file sandbox where Chrome dies without them. The same value can come from
                           the environment as ${EXTRA_ARGS_ENV}. Without either, the command line is
                           exactly what it always was. Flags the launcher builds itself and tokens
                           that are not --flags are refused.
  --help                   this page
`;

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  if (flags.has("--help") || flags.has("-h")) {
    console.log(HELP_TEXT);
    return 0;
  }
  const port = Number(values["--port"] || process.env.CDP_PORT || DEFAULT_PORT);
  const headless = !flags.has("--visible");

  // The one optional extra knob, from the flag or the environment, and REFUSED when it is not a space-joined
  // string of --flags. The bare-flag spelling (`--extra-args --no-sandbox`, unquoted) is caught here: parseArgs
  // read `--no-sandbox` as a flag of its own, so the value would silently vanish and the launch would miss the
  // one thing the caller asked for.
  let extraArgs = [];
  if (values["--extra-args"] !== undefined) {
    const parsed = parseExtraArgs(values["--extra-args"]);
    if (!parsed.ok) {
      console.error(`error: ${parsed.reason}`);
      return 1;
    }
    extraArgs = parsed.tokens;
  } else if (flags.has("--extra-args")) {
    console.error(`error: --extra-args was given with no value. Pass it quoted so the whole string is one argument:`);
    console.error(`  node src/forms/chrome_launch.mjs --extra-args "--no-sandbox --disable-gpu"`);
    console.error(`  (unquoted, every --token after it is read as a flag of the launcher's own)`);
    return 1;
  } else if (process.env[EXTRA_ARGS_ENV] !== undefined) {
    const parsed = parseExtraArgs(process.env[EXTRA_ARGS_ENV]);
    if (!parsed.ok) {
      console.error(`error: ${EXTRA_ARGS_ENV}: ${parsed.reason}`);
      return 1;
    }
    extraArgs = parsed.tokens;
  }

  // An unset data directory would resolve quietly to the working directory, and the browser's profile would then
  // be built somewhere in the checkout. `paths.mjs` is the one definition of that setting, so this reports what
  // it found rather than guessing at a second one.
  if (!DATA_DIR) {
    console.error("error: the data directory could not be resolved, so there is nowhere to put this browser's profile.");
    return 1;
  }
  const profileDir = values["--profile"] || resolve(DATA_DIR, PROFILE_DIRNAME);

  // THE ONE PORT THIS TOOL MAY NOT OWN. `RESERVED_PORTS` is checked before the probe, so no probe, no start and
  // no printed command line ever names it - the refusal is not a branch the rest of the file can talk its way
  // out of.
  if (RESERVED_PORTS.has(port)) {
    console.error(`error: port ${port} is reserved for another program on this machine, not for this toolkit.`);
    console.error("  It is a browser this repository must never attach to or start. Use the default port, or name");
    console.error("  another one with --port.");
    return 1;
  }

  const browserPath = findChrome();
  const first = await probePort({ port });
  const plan = decide({ probe: first, browserPath, profileDir, port, headless, extraArgs });

  // `--print-command` reports the decision and stops: it never spawns. The refusal is applied inside `decide`
  // BEFORE a command line is built, so what is printed here is a command that would run.
  if (flags.has("--print-command")) {
    if (plan.action !== "start") {
      console.log(`error: would not start anything — ${plan.reason}`);
      return 0;
    }
    console.log(`start: ${plan.browserPath} ${plan.args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
    return 0;
  }

  if (plan.action === "attach") {
    console.log(`attach: ${plan.reason}`);
    console.log(`  ${first.url} — ${first.detail}`);
    console.log(`  ${ROOT}`);
    return 0;
  }
  if (plan.action === "error") {
    console.error(`error: ${plan.reason}`);
    return plan.exitCode;
  }

  if (flags.has("--probe")) {
    console.log(`no browser: ${plan.reason}`);
    return 2;
  }

  console.log(`start: ${plan.reason}`);
  console.log(`  ${plan.browserPath}`);
  console.log(`  ${plan.headless ? "headless" : "visible"} profile ${plan.profileDir}`);
  const pid = startChrome({ browserPath: plan.browserPath, args: plan.args });
  console.log(`  pid ${pid}, waiting up to ${startupDeadlineMs()}ms for it to answer`);
  const after = await waitForBrowser({ port, attempts: 60, delayMs: 250 });
  if (!after || !after.answering) {
    console.error(`error: started pid ${pid} but the port still does not answer (${(after && after.detail) || "no answer"}).`);
    console.error("  This tool will not stop or restart a browser it started - that is the person's decision. Check");
    console.error("  whether the profile is already open in another Chrome, then run --probe to see the current state.");
    return 2;
  }
  console.log(`ready: ${after.url} — ${after.detail}`);
  return 0;
}

// Only a direct run starts a browser. An importer - the test, above all - gets the functions and no side effect.
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = await main();
}
