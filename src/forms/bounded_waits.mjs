/**
 * bounded_waits.mjs — every wait that can block gets a deadline, and says what it was waiting on.
 *
 * WHY THIS EXISTS, measured rather than argued. A browser-driven run had been hanging for eight to fifteen
 * minutes at a time, on a DIFFERENT test each time, burning 16 s of CPU across 15 minutes (`real 15m25s user
 * 0m16s`) — so the process was blocked in a wait, not computing. Two facts explained it, and both were
 * established by experiment before this file was written:
 *
 *   1. PLAYWRIGHT'S PROTOCOL CALLS HAVE NO TIMEOUT, AND AN EXPLICIT ONE IS IGNORED. With a headless
 *      chromium's renderer frozen in the kernel (SIGSTOP), `page.evaluate()` and `locator.count()` had still
 *      not returned after 45 s, and `page.evaluate(fn, arg, { timeout: 4000 })` / `locator.count({ timeout:
 *      4000 })` did not return either — the option was accepted and never fired. `locator.click()` is the
 *      exception: it failed at its own 30 s default ("locator.click: Timeout 30000ms exceeded"). So a page
 *      whose renderer stops answering blocks the driver FOREVER, and nothing on the Playwright side will
 *      ever notice. The wait has to be bounded from the driver's side.
 *
 *   2. A SYNCHRONOUS CHILD CANNOT BE TIMED OUT BY ITS CALLER. `spawnSync` blocks the caller's event loop for
 *      as long as the child runs, and `node:test`'s `timeout:` option is a timer ON THAT SAME LOOP. Measured:
 *      a test declared `{ timeout: 5000 }` whose body blocked for 40 s ran the full 40 s and then reported
 *      **pass**. The per-test budget is not a bound on a synchronous child, which is why the only thing that
 *      ever stopped one was that child's own `spawnSync` budget — and when that budget was longer than the
 *      caller's (a hardcoded 600 s against a 270 s test), the caller's limit killed the child, the child
 *      reported `status: null` and nothing about why, and the test then waited on grandchildren still
 *      holding the pipe. That is the 13-minute hang that reported "exit null".
 *
 * So there are two tools here, and the rule for using them is the same in both directions: A WAIT MUST BE
 * SHORTER THAN THE BUDGET OF WHATEVER IS WAITING ON IT, AND THE FAILURE MUST NAME THE WAIT. A deadline that
 * is longer than its caller's is not a deadline, it is a detach — the caller dies first and the reason is
 * lost.
 */
import { spawn } from "node:child_process";

/**
 * The default deadline for one browser round trip.
 *
 * Fifteen seconds is Playwright's own default for the actions that DO have one (and a tenth of the 120 s
 * budget the round-trip tests give themselves), so a wedged renderer fails here long before a test's own
 * budget could be spent. The slowest healthy read in the fixture suite is well under a second.
 */
export const DEFAULT_WAIT_MS = 15_000;

/**
 * How long a child that has already EXITED may keep its output pipes open before its collected output is
 * returned regardless. Only a grandchild that survived its parent holds them, and waiting on a process this
 * one does not own is how a bounded wait becomes unbounded.
 */
const CLOSE_GRACE_MS = 2_000;

/**
 * Race a promise against a deadline, and name the wait when the deadline wins.
 *
 * The loser is not cancelled — a Playwright call already in flight cannot be withdrawn — so it is detached
 * with a `.catch` that swallows its eventual rejection. Without that, a call that settles after the race is
 * lost becomes an unhandled rejection and takes the process down, which would turn a slow wait into a
 * crash.
 *
 * @template T
 * @param {Promise<T>} promise - the wait. Must already be started, so the deadline covers it.
 * @param {string} what - what is being waited on, in the reader's terms: "page.evaluate" is the mechanism,
 *   "reading #ccb_control's committed display" is what the reader needs.
 * @param {number} [ms] - the deadline. MUST be shorter than the budget of the caller that awaits this.
 * @returns {Promise<T>}
 */
export function withDeadline(promise, what, ms = DEFAULT_WAIT_MS) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms waiting on: ${what}`)), ms);
  });
  promise.catch(() => {});   // detached: see the note above
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * A Page-like object for the browser-driven TOOLS, where exactly two calls are unbounded.
 *
 * `apply_form_spec.mjs`, `pick_option.mjs`, `set_radio.mjs`, `answer_by_question_text.mjs` and
 * `inspect_ats_form.mjs` are each spawned as a child of a test (or of the refill loop), and each reads the page
 * with `page.evaluate` dozens of times. Those are the calls measured to ignore a timeout, so a tool that hits
 * a frozen renderer produces no output, no exit, and no reason - which is what a caller sees as
 * `status: null`. The same is true of `locator.count()`, which is the first thing the filler asks about every
 * control.
 *
 * Everything else is forwarded untouched. That is deliberate: `click`, `fill`, `setInputFiles`, `goto` and
 * `waitForLoadState` already have real timeouts, and their failures already name the action and the selector to
 * act on. Re-wrapping them would only replace a good message with a worse one.
 *
 * `setDefaultTimeout` is called first so the methods that DO honour a timeout get this deadline rather than
 * Playwright's own 30 s - which has to be shorter than the caller's budget for the caller to report the
 * failure instead of being killed by its own parent.
 *
 * @param {import("playwright-core").Page} page
 * @param {string} label - the tool's name, used in the timeout message.
 * @param {number} [ms]
 * @returns {import("playwright-core").Page} the same page, with the two unbounded reads bounded.
 */
export function boundedPage(page, label, ms = DEFAULT_WAIT_MS) {
  page.setDefaultTimeout(ms);

  const boundLocator = (loc) => new Proxy(loc, {
    get(target, prop, receiver) {
      if (prop === "count") {
        // The description is carried so the message names the control, not just the method.
        return () => withDeadline(target.count(), `${label}: count(${String(target).slice(0, 90)})`, ms);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return new Proxy(page, {
    get(target, prop, receiver) {
      if (prop === "evaluate") {
        return (fn, arg) => withDeadline(target.evaluate(fn, arg), `${label}: evaluate`, ms);
      }
      if (prop === "evaluateHandle") {
        return (fn, arg) => withDeadline(target.evaluateHandle(fn, arg), `${label}: evaluateHandle`, ms);
      }
      // Locators are wrapped on the way OUT so `.count()` is bounded; `.first()`, `.nth()`, `.filter()` and
      // friends return locators too, and they are wrapped by the same path.
      if (prop === "locator" || prop === "getByRole" || prop === "getByLabel" || prop === "getByText") {
        return (...args) => boundLocator(target[prop](...args));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Start a child, wait for it, and make sure a child that will not finish is NAMED and then actually killed.
 *
 * `spawnSync` is deliberately not used. It blocks the event loop, so it cannot be bounded by the test that
 * called it (see the header), and it reports a timeout as `status: null` with the reason only in `error.code`
 * — which reads as "exit null" in a failure message. This returns the same
 * `{ stdout, stderr, status, signal }` shape so callers do not change, plus `timedOut` and `waitedMs`, and
 * on a timeout it returns `status: null` AND `stderr` that says what timed out and after how long.
 *
 * THE CHILD LEADS ITS OWN PROCESS GROUP (`detached: true`) AND THE GROUP IS WHAT GETS KILLED. A browser-driven
 * child starts chrome and its own children; killing only the child leaves the grandchildren running and, when
 * stdio is piped, they can keep the pipe open after the parent is gone. A negative pid signals the whole
 * group, so one timeout takes the tree with it rather than leaving it behind to be found much later.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ what: string, timeoutMs: number, cwd?: string, env?: NodeJS.ProcessEnv, maxOutputBytes?: number }} opts
 * @returns {Promise<{stdout: string, stderr: string, status: number|null, signal: string|null, timedOut: boolean, waitedMs: number}>}
 */
export function spawnBounded(cmd, args, { what, timeoutMs, cwd, env, maxOutputBytes = 4 * 1024 * 1024 }) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    let closeGrace = null;

    const cap = chunk => {
      const s = chunk.toString();
      return s.length > maxOutputBytes ? s.slice(0, maxOutputBytes) : s;
    };
    child.stdout.on("data", c => { if (stdout.length < maxOutputBytes) stdout += cap(c); });
    child.stderr.on("data", c => { if (stderr.length < maxOutputBytes) stderr += cap(c); });

    const killGroup = sig => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first so a child that can tidy up does; SIGKILL shortly after, because the reason this
      // exists is a child that did not. Both go to the GROUP, not the single pid.
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 5000);
    }, timeoutMs);

    const finish = (status, signal, spawnErr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (closeGrace) clearTimeout(closeGrace);
      const waitedMs = Date.now() - started;
      // RELEASE THE PIPES, WHICH IS NOT THE SAME AS STOPPING THE WAIT AND IS THE HALF THAT IS EASY TO MISS.
      // A grandchild that outlived its parent still holds the write end of these two pipes, so they stay open
      // as live libuv handles and the whole process then refuses to EXIT - with every test already reported.
      // Measured: `process.getActiveResourcesInfo()` showed three surviving PipeWraps and the script sat there
      // after printing its last line. Destroying them drops the handles this process owns; the reader keeps
      // everything that was collected before the deadline.
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (timedOut) {
        // THE REASON IS PUT INTO stderr ON PURPOSE. Every caller already prints the child's own output when
        // the child fails, so a timeout explains itself in the place the reader is already looking, instead
        // of arriving as a bare `status: null`.
        stderr = `TIMED OUT after ${timeoutMs}ms waiting on: ${what} (child ${cmd} killed as a process group)\n`
          + (stderr ? `--- the child's own output before it was killed ---\n${stderr}` : "(the child produced no output)");
      } else if (spawnErr) {
        stderr = `SPAWN FAILED (${spawnErr.code || spawnErr.name}): ${spawnErr.message}\n` + stderr;
      }
      resolve({ stdout, stderr, status, signal, timedOut, waitedMs });
    };

    child.on("error", e => finish(null, null, e));
    // `close` is the clean end: the child is gone AND its stdio is drained, so nothing that was written is
    // lost. `exit` is the backstop. A killed process group usually produces both, but a grandchild can keep
    // the pipe open after its parent has exited - and waiting on that pipe is exactly the multi-minute stall
    // this module exists to remove. So when the child has EXITED, a short grace is allowed for the pipe to
    // close and then the collected output is returned anyway. A deadline that can itself be held open by the
    // thing it is bounding is not a deadline.
    child.on("close", (code, signal) => finish(code, signal, null));
    child.on("exit", (code, signal) => {
      closeGrace = setTimeout(() => {
        stderr += `\n(the child exited but its output pipes stayed open for ${CLOSE_GRACE_MS}ms - a grandchild `
          + `is holding them; returning what was collected rather than waiting on a process this one does not own)\n`;
        finish(code, signal, null);
      }, CLOSE_GRACE_MS);
    });
  });
}
