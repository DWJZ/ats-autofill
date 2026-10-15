/**
 * test_chrome_launch.mjs — the decision to start a browser, pinned without a browser.
 *
 * The user's requirement (2026-10-13) is that a tool may start a debugging instance when none is running — and
 * that it may never disturb one it did not start. Only the second half can be verified by a test in this
 * checkout, because starting a real Chrome needs a real machine with a real Chrome on it. So the split is:
 *
 *   - WHAT IS TESTED HERE: the probe ("is the port answering, and is it a browser?"), the decision built on it
 *     ("attach" / "start" / "refuse"), the exact command line that would be run, and the profile guard that stops
 *     a launch pointed at somebody's own Chrome profile. All of it as data, no network and no process.
 *   - WHAT IS NOT, and cannot be: that this machine's Chrome accepts those flags and answers on the port. The
 *     launcher's own docstring says so, and `--probe` is how a person checks that half.
 *
 * Both directions of the probe are asserted on purpose. A check that only proved "a closed port means start"
 * would pass against an implementation that also started a browser on top of a healthy instance, which is the
 * precise failure the requirement is written to prevent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PORT,
  EXTRA_ARGS_ENV,
  PROFILE_DIRNAME,
  decide,
  findChrome,
  launchArgs,
  parseArgs,
  parseExtraArgs,
  profileIsOwned,
  probePort,
  readVersion,
  startupDeadlineMs,
} from "./chrome_launch.mjs";
import { DATA_DIR } from "../paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "chrome_launch.mjs");

//: The profile the CLI checks point at: the same one every other command uses, under the data directory this
//: checkout resolves. Written as a path inside it because a profile anywhere else is exactly what the guard
//: refuses - a test that named one would be testing the refusal rather than the launch.
const OWNED_PROFILE = join(DATA_DIR, PROFILE_DIRNAME);

// A real `/json/version` body from a CDP browser, trimmed to the fields that are read.
const VERSION_BODY = JSON.stringify({
  Browser: "Chrome/141.0.7390.55",
  "Protocol-Version": "1.3",
  "User-Agent": "Mozilla/5.0",
  "V8-Version": "14.1.146",
  "WebKit-Version": "537.36",
  webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/abc-123",
});

/** A `fetch` stand-in: the URL is real, the answer is scripted. */
const fakeFetch = (body, { status = 200, fail = null } = {}) => async () => {
  if (fail) throw fail;
  return { ok: status >= 200 && status < 300, status, text: async () => body };
};

const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

// ---------------------------------------------------------------------------- the probe: is anything there?

test("a browser on the port is reported as one, never as a reason to start", async () => {
  const probe = await probePort({ port: DEFAULT_PORT, fetchImpl: fakeFetch(VERSION_BODY) });
  assert.equal(probe.answering, true);
  assert.equal(probe.looksLikeChrome, true);
  assert.equal(probe.version.protocolVersion, "1.3");
  assert.match(probe.detail, /Chrome\/141/);
});

test("a refused connection is an answer: nothing is listening, and that is not an error", async () => {
  const refused = Object.assign(new Error("fetch failed: ECONNREFUSED"), { name: "TypeError" });
  const probe = await probePort({ fetchImpl: fakeFetch("", { fail: refused }) });
  assert.equal(probe.answering, false);
  assert.equal(probe.kind, "refused");
  assert.match(probe.detail, /ECONNREFUSED/);
});

test("a port that accepts the connection and never answers is a timeout, and reads differently from a refusal", async () => {
  // A port held by something that is not listening for HTTP hangs instead of refusing, and the difference is
  // worth keeping: "nothing there" and "something there that will not talk" send the reader to different places.
  const probe = await probePort({ timeoutMs: 50, fetchImpl: fakeFetch("", { fail: timeoutError() }) });
  assert.equal(probe.answering, false);
  assert.equal(probe.kind, "timeout");
  assert.match(probe.detail, /50ms/);
});

test("something that is not a browser is NOT read as a browser", async () => {
  // The dangerous direction. Treating any answer as "Chrome is up" would attach the fillers to whatever else
  // holds the port; treating it as "nothing is there" would start a second browser beside it. Neither happens:
  // the port is reported as answering and as not-a-browser, and `decide` stops on that.
  for (const [label, spec] of [
    ["a proxy's 502", { body: "<html>bad gateway</html>", status: 502 }],
    ["some other JSON service", { body: '{"hello":"world"}', status: 200 }],
    ["an empty 200", { body: "", status: 200 }],
  ]) {
    const probe = await probePort({ fetchImpl: fakeFetch(spec.body, { status: spec.status }) });
    assert.equal(probe.answering, true, label);
    assert.equal(probe.looksLikeChrome, false, label);
  }
});

test("readVersion accepts a DevTools document and nothing else", () => {
  assert.equal(readVersion(VERSION_BODY).protocolVersion, "1.3");
  assert.equal(readVersion("not json at all"), null);
  assert.equal(readVersion("{}"), null, "a JSON object without a protocol version is not a DevTools endpoint");
  assert.equal(readVersion(""), null);
  assert.equal(readVersion(null), null);
});

// ------------------------------------------------------------------- the decision: attach, start, or refuse

const NOTHING = { answering: false, looksLikeChrome: false, kind: "refused", detail: "ECONNREFUSED", url: "u" };
const BROWSER = { answering: true, looksLikeChrome: true, kind: "browser", detail: "Chrome/141", url: "u", version: {} };
const OTHER_SERVICE = { answering: true, looksLikeChrome: false, kind: "not-a-browser", detail: "some other JSON", url: "u" };

test("an answering port is attached to, never started against", () => {
  const plan = decide({ probe: BROWSER, browserPath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  assert.equal(plan.action, "attach");
  assert.equal(plan.exitCode, 0);
  assert.equal(plan.args, undefined, "an attach must not carry a command line to run");
});

test("a port held by something else is reported and nothing is started", () => {
  // The name of the requirement: never a second instance. Starting here would put two browsers on one port and
  // an unexplained failure wherever a tool attached afterwards.
  const plan = decide({ probe: OTHER_SERVICE, browserPath: "/some/chrome" });
  assert.equal(plan.action, "attach");
  assert.match(plan.reason, /not as a Chrome DevTools endpoint/);
  assert.match(plan.reason, /stopping rather than starting a second instance/);
  assert.equal(plan.args, undefined);
});

test("a closed port with no usable browser refuses instead of starting nothing quietly", () => {
  const plan = decide({ probe: NOTHING, browserPath: null });
  assert.equal(plan.action, "error");
  assert.equal(plan.exitCode, 1);
  assert.match(plan.reason, /no Chrome binary was found/);
});

test("a closed port with a browser starts one, and the command line says which profile and how it renders", () => {
  const dataDir = tmpdir();
  const profileDir = join(dataDir, "jh-owned-profile");
  const plan = decide({ probe: NOTHING, browserPath: "/some/chrome", profileDir, dataDir, port: 9223, headless: true });
  assert.equal(plan.action, "start");
  assert.equal(plan.browserPath, "/some/chrome");
  assert.ok(plan.args.includes("--remote-debugging-port=9223"));
  assert.ok(plan.args.includes(`--user-data-dir=${resolve(profileDir)}`));
  assert.ok(plan.args.includes("--headless=new"), "headless is the default and the requirement is stated on the command line");
});

test("the profile guard is asked BEFORE a start, so a refused profile never yields a command line", () => {
  // Order matters here and is the whole assertion: a plan that carried a command line AND a refusal would leave
  // the caller to choose, and the caller is the code. No command line is built for a profile this tool may not
  // write to.
  const plan = decide({
    probe: NOTHING, browserPath: "/some/chrome",
    profileDir: "/Users/someone/Library/Application Support/Google/Chrome", dataDir: "/tmp/data",
  });
  assert.equal(plan.action, "error");
  assert.match(plan.reason, /outside the data directory/);
  assert.equal(plan.args, undefined);
});

test("no probe result is an error rather than a guess", () => {
  assert.equal(decide({ probe: null, browserPath: "/some/chrome" }).action, "error");
  assert.equal(decide({ probe: {}, browserPath: "/some/chrome" }).action, "error");
});

// ------------------------------------------------------------------------------- the command line, as data

test("the launch command line is a fresh-profile, no-window launch by default", () => {
  const args = launchArgs({ port: 9223, profileDir: "/tmp/data/chrome-cdp-profile", headless: true });
  assert.deepEqual(args, [
    "--remote-debugging-port=9223",
    "--user-data-dir=/tmp/data/chrome-cdp-profile",
    "--no-first-run",
    "--no-default-browser-check",
    "--headless=new",
    "about:blank",
  ]);
});

test("extra Chrome flags land in the command line, before the URL and after the launcher's own flags", () => {
  // Finding from a real cold-start smoke test (2026-10-14): a launcher running INSIDE the DSH file sandbox
  // started Chrome with its exact printed command line, and Chrome died within seconds - `Failed to initialize
  // sandbox` / `sandbox initialization failed: Operation not permitted`, then `FATAL ... GPU process isn't
  // usable. Goodbye.` - while the launcher discarded stdio, so it had already reported "ready".
  // `test_fill_roundtrip.mjs` launches Chrome with `--no-sandbox --disable-gpu` for exactly this situation, and
  // now a caller can ask the launcher for the same two flags without editing the launcher.
  const args = launchArgs({
    port: 9223, profileDir: "/tmp/data/chrome-cdp-profile", headless: true,
    extraArgs: ["--no-sandbox", "--disable-gpu"],
  });
  assert.deepEqual(args, [
    "--remote-debugging-port=9223",
    "--user-data-dir=/tmp/data/chrome-cdp-profile",
    "--no-first-run",
    "--no-default-browser-check",
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "about:blank",
  ]);
});

test("without extra flags the command line is byte-identical to the one before the option existed", () => {
  // The opt-in is the security property: `--no-sandbox` is a tradeoff nobody should get by default, so an
  // omitted `--extra-args` must produce the exact array the file shipped with, character for character.
  const args = launchArgs({ port: 9223, profileDir: "/tmp/data/chrome-cdp-profile", headless: true, extraArgs: [] });
  assert.deepEqual(args, launchArgs({ port: 9223, profileDir: "/tmp/data/chrome-cdp-profile", headless: true }));
  assert.ok(!args.some((a) => a.includes("sandbox") || a.includes("disable-gpu")),
    "the sandbox flags are opt-in, never the default");
});

test("a visible launch differs from the headless one by exactly the headless flag", () => {
  // The person needs a window for the two things a headless instance cannot give them: signing in to a board in
  // a fresh profile, and finishing a CAPTCHA. Keeping the difference to one flag is what makes that a switch
  // rather than a second code path.
  const headless = launchArgs({ port: 9223, profileDir: "/tmp/p", headless: true });
  const visible = launchArgs({ port: 9223, profileDir: "/tmp/p", headless: false });
  assert.deepEqual(visible, headless.filter((a) => a !== "--headless=new"));
  assert.ok(!visible.some((a) => a.startsWith("--headless")));
});

test("no command line this file can build names a profile outside the data directory", () => {
  const dataDir = "/tmp/config-outside-the-repo";
  const plan = decide({
    probe: NOTHING, browserPath: "/some/chrome",
    profileDir: `${dataDir}/chrome-cdp-profile`, dataDir,
  });
  assert.equal(plan.action, "start");
  assert.ok(plan.args.every((a) => !/Application Support\/Google\/Chrome/.test(a)));
  assert.ok(plan.args.some((a) => a === `--user-data-dir=${dataDir}/chrome-cdp-profile`));
});

test("profileIsOwned accepts a directory inside the data directory and refuses everything else", () => {
  const data = "/tmp/ats-data";
  assert.equal(profileIsOwned(`${data}/${PROFILE_DIRNAME}`, data).ok, true);
  assert.equal(profileIsOwned(`${data}/nested/browser`, data).ok, true);
  assert.equal(profileIsOwned("/tmp/elsewhere/profile", data).ok, false);
  assert.equal(profileIsOwned(data, data).ok, false, "the data directory itself would scatter a browser through the configuration");
  assert.equal(profileIsOwned("", data).ok, false);
  assert.equal(profileIsOwned(null, data).ok, false);
  // A prefix that is not a path boundary must not pass: `/tmp/ats-data-other` is not inside `/tmp/ats-data`.
  assert.equal(profileIsOwned("/tmp/ats-data-other/profile", data).ok, false);
});

// ------------------------------------------------------------------------------------ finding a browser

test("$CHROME_PATH is honoured first, and a missing one is not returned", () => {
  const exists = (p) => p === "/checked/chrome";
  assert.equal(findChrome({ CHROME_PATH: "/checked/chrome" }, exists), "/checked/chrome");
  assert.equal(findChrome({ CHROME_PATH: "/checked/absent" }, exists), null);
});

test("a glob in the candidate list is never returned as an executable path", () => {
  // A path with a `*` is one a shell expands. Handing it to spawn would fail at launch time with an error that
  // reads like a missing browser, which is a diagnosis in the wrong place.
  const found = findChrome({ HOME: "/Users/someone" }, (p) => p.includes("*"));
  assert.equal(found, null);
});

test("the startup wait is bounded and the bound is the one reported", () => {
  assert.equal(startupDeadlineMs({ attempts: 60, delayMs: 250 }), 15000);
  assert.equal(startupDeadlineMs({ attempts: 4, delayMs: 100 }), 400);
});

// ---------------------------------------------------------------------------------------------- the CLI

test("the argument parser takes a value after a flag and a value inside one", () => {
  const spaced = parseArgs(["--port", "9333", "--visible"]);
  assert.equal(spaced.values["--port"], "9333");
  assert.ok(spaced.flags.has("--visible"));
  const joined = parseArgs(["--port=9333", "--probe"]);
  assert.equal(joined.values["--port"], "9333");
  assert.ok(joined.flags.has("--probe"));
  assert.deepEqual(parseArgs(["--visible", "--print-command"]).values, {}, "a flag followed by a flag is two flags");
});

test("parseExtraArgs splits a space-joined string and passes an absent value through as nothing", () => {
  const parsed = parseExtraArgs("--no-sandbox --disable-gpu");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.tokens, ["--no-sandbox", "--disable-gpu"]);
  assert.deepEqual(parseExtraArgs("").tokens, []);
  assert.deepEqual(parseExtraArgs(undefined).tokens, []);
  assert.deepEqual(parseExtraArgs(null).tokens, []);
  assert.deepEqual(parseExtraArgs("  --no-sandbox  ").tokens, ["--no-sandbox"], "surrounding spaces are not a value");
});

test("an extra-args token that is not a --flag is refused", () => {
  // A bare word in this position would become a URL to open, and the launch already ends with `about:blank` -
  // two pages, one of them unexpected. The refusal names the offending token so the caller can fix the string.
  for (const bad of ["about:blank", "--no-sandbox chrome://version", "-flag", "--"]) {
    const parsed = parseExtraArgs(bad);
    assert.equal(parsed.ok, false, bad);
    assert.match(parsed.reason, /not a --flag/);
  }
});

test("an extra-args token that names a flag the launcher owns is refused", () => {
  // `--extra-args "--remote-debugging-port=9333"` would put two ports on one command line and Chrome could pick
  // either - the same reason the refusal exists for `--headless` and the profile flags.
  for (const bad of ["--remote-debugging-port=9333", "--user-data-dir=/tmp/x", "--no-first-run", "--headless=new", "--profile /x"]) {
    const parsed = parseExtraArgs(bad);
    assert.equal(parsed.ok, false, bad);
    assert.match(parsed.reason, /may not set/);
  }
});

test("--print-command shows what would run and runs nothing", () => {
  // The safe way to see this file's own command line, and the only end-to-end exercise of the CLI that needs no
  // browser: the plan is printed, the launcher returns before spawning anything. `--port 0` is deliberate - port
  // zero is never a listening port, so the branch under test is the START branch on every machine, whether or not
  // the reader happens to have a debugging browser running.
  const profileDir = OWNED_PROFILE;
  const run = spawnSync("node", [SCRIPT, "--print-command", "--port", "0", "--profile", profileDir], {
    encoding: "utf8", timeout: 20000,
  });
  const out = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, out);
  assert.match(out, /^start:/, "port 0 is closed everywhere, so the decision is to start");
  assert.match(out, /--remote-debugging-port=0/);
  assert.match(out, new RegExp(`--user-data-dir=${escapeRegExp(profileDir)}`));
  assert.match(out, /--headless=new/, "headless is the default, so it is in the printed command");
  assert.ok(!/Application Support\/Google\/Chrome/.test(out), "never a personal profile");
});

test("--print-command never prints a command for a profile the guard refuses", () => {
  // The refusal has to happen before the command line is shown, or the printed line is an instruction to do the
  // thing the guard exists to prevent.
  const run = spawnSync("node", [SCRIPT, "--print-command", "--port", "0",
    "--profile", "/Users/someone/Library/Application Support/Google/Chrome"], { encoding: "utf8", timeout: 20000 });
  const out = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, out);
  assert.match(out, /^error: would not start anything/);
  assert.ok(!/--user-data-dir/.test(out), "no command line may be printed for a refused profile");
  assert.ok(!/--remote-debugging-port/.test(out));
});

test("--print-command with no --extra-args prints the exact command line the launcher always printed", () => {
  // The byte-identical half of the opt-in contract: a normal terminal run must not gain a flag it never asked
  // for, because `--no-sandbox` is a security tradeoff. The assertion is on the printed line itself, from the
  // first flag to the end - nothing added, nothing reordered, nothing reworded.
  const profileDir = OWNED_PROFILE;
  const run = spawnSync("node", [SCRIPT, "--print-command", "--port", "0", "--profile", profileDir], {
    encoding: "utf8", timeout: 20000,
  });
  const out = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, out);
  const fromFirstFlag = out.slice(out.indexOf("--remote-debugging-port")).trimEnd();
  assert.equal(
    fromFirstFlag,
    `--remote-debugging-port=0 --user-data-dir=${profileDir} --no-first-run --no-default-browser-check --headless=new about:blank`,
    "the default command line changed; the extra-args option must be opt-in, not a new default");
});

test("--extra-args lands in the printed command line, before the URL", () => {
  const run = spawnSync("node", [SCRIPT, "--print-command", "--port", "0", "--profile", OWNED_PROFILE,
    "--extra-args", "--no-sandbox --disable-gpu"], { encoding: "utf8", timeout: 20000 });
  const out = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, out);
  assert.match(out, /--headless=new --no-sandbox --disable-gpu about:blank/,
    "the extra flags come after the launcher's own and before the page to open");
});

test("the same extra flags can come from the environment", () => {
  const run = spawnSync("node", [SCRIPT, "--print-command", "--port", "0", "--profile", OWNED_PROFILE], {
    encoding: "utf8", timeout: 20000,
    env: { ...process.env, [EXTRA_ARGS_ENV]: "--no-sandbox --disable-gpu" },
  });
  const out = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, out);
  assert.match(out, /--no-sandbox --disable-gpu about:blank/);
});

test("an invalid --extra-args value is refused before anything is started or printed", () => {
  for (const bad of ["chrome://version", "--remote-debugging-port=9333"]) {
    const run = spawnSync("node", [SCRIPT, "--print-command", "--port", "0", "--profile", OWNED_PROFILE,
      "--extra-args", bad], { encoding: "utf8", timeout: 20000 });
    const out = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 1, out);
    assert.match(out, /^error: /, "the refusal says why, and nothing startable is printed");
    assert.ok(!/^start:/.test(run.stdout), "no command line may be printed for a refused extra-args value");
  }
});

test("--extra-args written unquoted is refused instead of silently dropping the flags", () => {
  // `--extra-args --no-sandbox` parses as a bare flag plus an unknown flag, and the launch would run WITHOUT the
  // one flag the caller asked for - a Chrome that then dies in a sandbox, exactly the reported failure. The
  // launcher must say so rather than pretend the option was honoured.
  const run = spawnSync("node", [SCRIPT, "--print-command", "--port", "0", "--profile", OWNED_PROFILE,
    "--extra-args", "--no-sandbox"], { encoding: "utf8", timeout: 20000 });
  const out = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 1, out);
  assert.match(out, /--extra-args was given with no value/);
});

test("--help documents the option and its environment variable", () => {
  const run = spawnSync("node", [SCRIPT, "--help"], { encoding: "utf8", timeout: 20000 });
  const out = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, out);
  assert.match(out, /--extra-args/);
  assert.ok(out.includes(EXTRA_ARGS_ENV), "the environment spelling is documented beside the flag");
  assert.match(out, /--no-sandbox --disable-gpu/, "the sandbox case the option exists for is the example given");
});

test("the launcher has no way to stop, kill or restart a browser", () => {
  // The requirement in one assertion. A stop path is the thing that would make "never quits an instance the tool
  // did not start" a promise instead of a property, so its absence is the property. Read as source text, comments
  // included, because a commented-out kill is the next author's invitation.
  const source = readFileSync(SCRIPT, "utf8");
  for (const forbidden of ["kill", "SIGTERM", "SIGKILL", "execFileSync", "pgrep", "pkill", "taskkill"]) {
    assert.ok(!source.includes(forbidden), `chrome_launch.mjs must not contain ${forbidden}`);
  }
});

test("the browser this project must never touch is refused rather than used", () => {  // 9222 belongs to the harness running these agents, not to this toolkit's configuration. The launcher is the
  // one place that could start something on it, so the refusal lives here and is asserted here.
  const run = spawnSync("node", [SCRIPT, "--port", "9222", "--print-command"], { encoding: "utf8", timeout: 20000 });
  const out = `${run.stdout}${run.stderr}`;
  assert.match(out, /9222 is reserved/, "the CLI must name the reserved port and refuse");
  assert.equal(run.status, 1);
  assert.ok(!/User Data|default\/chrome/.test(out));
});

/** Regex-escape a path so it can be asserted inside a pattern rather than string-compared. */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

