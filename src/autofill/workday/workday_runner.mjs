#!/usr/bin/env node
/**
 * workday_runner.mjs — drive a whole Workday application wizard from one payload + one answer plan.
 *
 * WHY: the settled path (`unified_runner.fillWorkday`) covers ONLY the My Experience step, and only when that step
 * is already on screen; everything else (the Autofill-with-Resume upload, and the questionnaire, disclosure and
 * review steps) had to be hand-driven every time. This runner closes that gap so a Workday application is one
 * command.
 *
 * USAGE
 *   node src/autofill/workday/workday_runner.mjs <payload.json> \
 *        [--answers <answers.json>] [--cdp http://127.0.0.1:9223] [--submit] [--discover] [--max-steps 12]
 *        [--email <addr>] [--account-password <pw>] [--reset-password] [--dump] [--goto <step regex>]
 *
 *   --goto     click a step-navigation item matching the regex and run the fill loop from there (used to go back
 *              to a section the wizard skipped, e.g. My Experience on a tenant that uploads first).
 *
 *   --reset-password  when an account exists but sign-in fails (typically because the emailed activation link is
 *                 single-use and was already spent), drive the tenant's own "Forgot your password?" flow: submit
 *                 the address, read the reset mail with the project mail tool, open the link, set the stored
 *                 password, and sign in.
 *
 *   --email / --account-password   for tenants that require creating a Workday account before applying
 *                 (Commerce/BigCommerce is one). The password is generated when omitted and written to
 *                 <payload-dir>/<slug>_account.json so the user owns the credential.
 *
 *   --discover    walk the wizard printing every control on every step - kind, question text, and the offered
 *                 options for each select - so an answer plan can be written from evidence instead of probing
 *                 the DOM by hand. Nothing is submitted.
 *
 *   payload.json  — the per-job Workday payload already produced for other tenants
 *                   (src/autofill/workday/<company>_payload.json): work_experience, education, resume_path.
 *   answers.json  — a per-step answer plan (see ANSWERS SHAPE below). Optional: without it the runner still does
 *                   step 1 (upload + parse) and step 3 (experience via the settled helper), and reports which
 *                   questions it left for the caller.
 *
 * ANSWERS SHAPE
 *   {
 *     "2": { "texts":   { "<input name or label regex>": "<value>" },
 *            "selects": [ { "q": "<question regex>", "option": "<exact option text>" } ] },
 *     "4": { "selects": [ ... ] },
 *     "5": { "selects": [ ... ], "texts": { ... } },
 *     "6": { "selects": [ ... ], "checks": [ "<question regex>" ] }
 *   }
 *   Keys are the Workday step numbers (see the step bar: 1 Autofill, 2 My Information, 3 My Experience,
 *   4/5 Application Questions, 6 Voluntary Disclosures/Self Identify, 7 Review).
 *
 * PRIMITIVES USED (the ones this project learned the hard way)
 *   - Select One dropdowns are read through the element named by the button's `aria-controls`; scraping generic
 *     page text after a click returns step labels and unrelated lists.
 *   - The error summary's `Error-…` entries are buttons that jump to the offending control.
 *   - Date masks ignore programmatic values: text is typed with real keystrokes and read back.
 *   - Every select/checkbox choice is read back and compared to the wanted text before moving on.
 */
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
// Telemetry must never break a submission: see src/forms/submit_with_verification_code.mjs.
const { recordLedger, SUBMIT } = await import("../../forms/_ledger.mjs")
  .catch(() => ({ recordLedger: () => null, SUBMIT: "submit" }));

const CDP_DEFAULT = "http://127.0.0.1:9223";

function parseArgs(argv) {
  const a = { payload: null, answers: null, cdp: CDP_DEFAULT, submit: false, discover: false, dump: false, goto: "", back: 0, maxSteps: 12, email: "", accountPassword: "", resetPassword: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--answers") a.answers = argv[++i];
    else if (v === "--cdp") a.cdp = argv[++i];
    else if (v === "--submit") a.submit = true;
    else if (v === "--discover") a.discover = true;
    else if (v === "--email") a.email = argv[++i];
    else if (v === "--account-password") a.accountPassword = argv[++i];
    else if (v === "--reset-password") a.resetPassword = true;
    else if (v === "--dump") a.dump = true;
    else if (v === "--goto") a.goto = argv[++i];
    else if (v === "--back") a.back = Number(argv[++i]) || 0;
    else if (v === "--max-steps") a.maxSteps = Number(argv[++i]);
    else if (!v.startsWith("--") && !a.payload) a.payload = v;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.payload) {
  console.error("usage: workday_runner.mjs <payload.json> [--answers answers.json] [--cdp url] [--submit]");
  process.exit(2);
}
const payload = JSON.parse(await readFile(args.payload, "utf8"));
// application_bundles/<slug>.json names it resume_pdf_path; the older workday payloads use resume_path.
if (!payload.resume_path && payload.resume_pdf_path) payload.resume_path = payload.resume_pdf_path;

// A bundle carries the resume and the job URL but not the work history, so merge the sibling payload the same way
// the Workday tenant expects it: <bundle dir>/<bundle base>_payload.json (built from application_profile.json).
try {
  const path = await import("node:path");
  const { readFile } = await import("node:fs/promises");
  const sibling = path.join(
    path.dirname(path.resolve(args.payload)),
    `${path.basename(args.payload).replace(/\.json$/, "")}_payload.json`,
  );
  const extra = JSON.parse(await readFile(sibling, "utf8"));
  for (const k of ["work_experience", "education", "social_networks", "websites", "excluded_websites"]) {
    if (extra[k] && !payload[k]) payload[k] = extra[k];
  }
  payload.__payload_file = sibling;
} catch { /* no sibling payload - experience will be reported as missing */ }
const plan = args.answers ? JSON.parse(await readFile(args.answers, "utf8")) : {};

const log = (...m) => console.log("[workday]", ...m);
const browser = await chromium.connectOverCDP(args.cdp);

/**
 * Pick the RIGHT tab. A session can hold several Workday tabs (another tenant, or a finished application's
 * confirmation page), and matching on "any Workday URL" once attached the runner to the wrong tenant entirely.
 * The payload's job URL is the authority: prefer the tab whose URL shares the requisition id, then the tenant host,
 * and never a completed-application page.
 */
function pickTab(pages) {
  const jobUrl = payload.job_url || payload.source || "";
  const reqId = (jobUrl.match(/([A-Za-z0-9_]*_?R?\d{5,})/) || [])[1] || "";
  const host = (jobUrl.match(/https?:\/\/([^/]+)/) || [])[1] || "";
  const workday = pages.filter((p) => /myworkdayjobs\.com|myworkdaysite\.com/.test(p.url()));
  const usable = workday.filter((p) => !/jobTasks\/completed|\/completed\/application/i.test(p.url()));
  const score = (p) => {
    let s = 0;
    if (reqId && p.url().toLowerCase().includes(reqId.toLowerCase())) s += 4;
    if (host && p.url().includes(host)) s += 3;
    if (/\/apply\//i.test(p.url())) s += 2;
    return s;
  };
  const ranked = (usable.length ? usable : workday).map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s);
  return ranked.length ? ranked[0].p : null;
}

let page = pickTab(browser.contexts()[0].pages());
// NEVER DRIVE AN UNRELATED WORKDAY TAB (added 2026-10-07). With --goto, a handover tab on ANOTHER Workday tenant
// outranked nothing at all: the target requisition had no tab open, the runner fell back to the only Workday page it
// could see (an NVIDIA application left for the user), reported "control not found (goto ...)", and then pressed
// Save and Continue on THAT wizard. When the target host has no tab, open one in the background and re-pick - the
// handover tab must keep its exact state.
const gotoHost = (String(args.goto || "").match(/https?:\/\/([^/]+)/) || [])[1] || "";
if (args.goto && gotoHost && (!page || !page.url().includes(gotoHost))) {
  try {
    const { execFileSync } = await import("node:child_process");
    log(`no tab on ${host}; opening the posting in a background tab`);
    execFileSync("node", ["src/forms/cdp_tabs.mjs", "open", args.goto], { stdio: "inherit" });
    await new Promise((resolve) => setTimeout(resolve, 9000));
    page = pickTab(browser.contexts()[0].pages());
  } catch (err) {
    log(`could not open a background tab: ${String(err).slice(0, 120)}`);
  }
}
if (!page) {
  console.error("no Workday tab found; open the posting first (cdp_tabs.mjs open <url>)");
  process.exit(2);
}
log(`attached to: ${page.url().slice(0, 110)}`);

// CAP THE DEFAULT TIMEOUT (2026-10-07). The education path retries a control across several aliases and rows, and
// each retry was burning Playwright's 30-second default - one verification run passed fourteen minutes inside those
// loops and had to be killed, which is how a working fix looks broken. Six seconds is still an order of magnitude
// longer than any interaction needs on a page that has already loaded, and an explicit timeoutMs on a call still
// overrides this.
try { page.setDefaultTimeout(6000); } catch { /* older/newer Playwright shapes differ; never fail the run for this */ }

// Guard: answer any file chooser Playwright sees, so a native dialog never reaches the desktop.
page.on("filechooser", async (fc) => {
  try {
    if (payload.resume_path) {
      await fc.setFiles(payload.resume_path);
      log("file chooser intercepted and answered with the resume");
    } else {
      await fc.setFiles([]);
      log("file chooser intercepted (no resume in the payload)");
    }
  } catch (e) {
    log("could not answer the file chooser:", String(e).slice(0, 100));
  }
});

const sleep = (ms) => page.waitForTimeout(ms);

/** read the wizard's current step number and any errors */
async function state() {
  return await page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, " ");
    const m = t.match(/current step (\d+) of (\d+)/i);
    return {
      step: m ? Number(m[1]) : 0,
      total: m ? Number(m[2]) : 0,
      errors: (t.match(/Error-[A-Za-z][^.]{0,120}/g) || []).slice(0, 8),
      buttons: [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim()).filter(Boolean),
    };
  });
}

/** click the wizard's forward control */
async function advance() {
  await dismissConsent();
  const pressed = await pressVerified(findButton("^(save and continue|next|continue)$"), "wizard advance");
  if (!pressed.ok) {
    log("advance failed:", JSON.stringify(pressed).slice(0, 260));
    return false;
  }
  await sleep(6500);
  return true;
}

/** set a text field by input name, verified by reading the value back */


/**
 * Browser-side source for the plan-key resolver, passed INTO page.evaluate as data.
 *
 * The resolver must run in the page, so it cannot be a Node-scope function referenced from a callback - doing that threw
 * "resolveOrdinal is not defined". Passing the source and evaluating it keeps ONE definition while making it available in
 * every callback.
 *
 * Keys accept a `#N` (1-based) ordinal, because Workday regenerates the My Experience element IDs on every render while
 * their ORDER stays fixed:
 *   name#N | companyName#3 | location#5   -> Nth element with that name
 *   startMonth#N | endMonth#N             -> Nth dateSectionMonth input in a start/endDate block
 *   startYear#N  | endYear#N              -> Nth dateSectionYear  input in a start/endDate block
 */
const RESOLVER_SRC = `
(key) => {
  const m = String(key).match(/^(.*)#(\\d+)$/);
  if (!m) return document.querySelector('input[name="' + key + '"], textarea[name="' + key + '"]') || document.getElementById(key);
  const base = m[1];
  const n = Number(m[2]) - 1;
  const suffix = { startMonth: "startDate", endMonth: "endDate", startYear: "startDate", endYear: "endDate" }[base];
  if (suffix) {
    const kind = base.endsWith("Month") ? "dateSectionMonth" : "dateSectionYear";
    const all = [...document.querySelectorAll('input[id*="' + suffix + '"][id*="' + kind + '"]')];
    return all[n] || null;
  }
  const all = [...document.querySelectorAll('input[name="' + base + '"], textarea[name="' + base + '"]')];
  return all[n] || null;
}`;

async function setText(name, value) {
  // Ordinal date-section keys take the PROVEN path: Playwright's fill() on the nth spinbutton, with the month as a
  // zero-padded two-digit number. workday_experience_helper.mjs does exactly this and works; keyboard typing here stored
  // February for every row and a plain "1" was rejected.
  {
    const m = String(name).match(/^(start|end)(Month|Year)#(\d+)$/);
    if (m) {
      const [, which, kind, nRaw] = m;
      const sel = `input[id*="${which}Date"][id*="${kind === "Month" ? "dateSectionMonth" : "dateSectionYear"}"]`;
      const loc = page.locator(sel).nth(Number(nRaw) - 1);
      const count = await page.locator(sel).count();
      if (count < Number(nRaw)) return { name, ok: false, why: `only ${count} ${sel} control(s)` };
      const want = kind === "Month" ? String(value).padStart(2, "0") : String(value);
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.fill(want).catch((e) => ({ err: String(e).slice(0, 80) }));
      await sleep(250);
      const read = await loc.inputValue().catch(() => "");
      return { name, ok: String(read).trim() === want || String(read).includes(want), read, how: "fill" };
    }
  }

  // The resolver source travels INTO the page as data: a Node-scope function referenced from page.evaluate throws
  // "resolveOrdinal is not defined", because the callback runs in the browser.
  const before = await page.evaluate(({ n, src }) => {
    const resolveOrdinal = eval(src);
    const el = resolveOrdinal(n);
    if (!el) return null;
    if (typeof isHoneypot === "function" && isHoneypot(el)) return "HONEYPOT";
    el.scrollIntoView({ block: "nearest" });
    el.focus();
    el.select && el.select();
    return el.value;
  }, { n: name, src: RESOLVER_SRC });
  if (before === null) return { name, ok: false, why: "not found" };
  if (before === "HONEYPOT") return { name, ok: false, why: "refused: anti-bot trap field" };
  await page.keyboard.press("Meta+a").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(String(value), { delay: 18 });
  // Date-section MONTH fields are typeaheads: without Enter the typed value is not committed and Workday stores a default
  // (February was observed for several rows). Enter commits the highlighted match, as a human would.
  const isMonth = await page.evaluate(({ n, src }) => {
    const resolveOrdinal = eval(src);
    const el = resolveOrdinal(n);
    return !!el && /dateSectionMonth/i.test(el.id || "");
  }, { n: name, src: RESOLVER_SRC });
  if (isMonth) {
    await page.keyboard.press("Enter").catch(() => {});
    await sleep(350);
  }
  const after = await page.evaluate(({ n, src }) => {
    const resolveOrdinal = eval(src);
    const el = resolveOrdinal(n);
    return el ? el.value : "";
  }, { n: name, src: RESOLVER_SRC });
  const norm = (s) => String(s || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return { name, ok: norm(after).includes(norm(value).slice(0, 12)) || norm(after) === norm(value), read: after };
}

/** choose an option from a 'Select One' dropdown, reading the listbox named by aria-controls.
 *  `index` selects the nth matching field, which is required when a page repeats a question (e.g. one Degree
 *  dropdown per education block). */
async function chooseSelect(questionRe, optionText, index = 0) {
  // Escape before opening: a menu left open by the previous field swallows the next click
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(300);
  // locate the field and note whether its menu is ALREADY open (aria-controls set). Clicking a control whose menu
  // is open CLOSES it, which is how an earlier run turned a working field into 'Select One' again.
  const open = await page.evaluate(({ src, idx, w }) => {
    const re = new RegExp(src, "i");
    const matches = [];
    for (const f of document.querySelectorAll('[data-automation-id^="formField-"]')) {
      if (!re.test((f.innerText || "").replace(/\s+/g, " "))) continue;
      // A button is the usual trigger, but some tenants render the same control as an INPUT combobox (id="<name>--<name>",
      // often with aria-haspopup / role=combobox and no button at all). Accept either.
      const btn = f.querySelector('button[aria-haspopup="listbox"], button')
        || f.querySelector('input[role="combobox"], input[aria-haspopup="listbox"], input[aria-haspopup="true"], input[id*="--"][type="text"]');
      if (!btn) continue;
      matches.push({ f, btn });
    }
    if (idx >= matches.length) return { ok: false, why: `only ${matches.length} matching fields` };
    const { f, btn } = matches[idx];
    const marker = `runner-${Date.now()}-${idx}`;
    f.setAttribute("data-runner-target", marker);
    f.scrollIntoView({ block: "nearest" });
    const r = btn.getBoundingClientRect();
    return {
      ok: true,
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      aid: f.getAttribute("data-automation-id"),
      suffix: (f.getAttribute("data-automation-id") || "").replace(/^formField-/, ""),
      marker,
      count: matches.length,
      // No aria-controls means the attribute cannot say whether the menu is open. Do NOT fall back to "any visible
      // listbox": Workday keeps a pagination listbox visible at all times whose options are "Partial List (First 500
      // Entries)" / "All", and treating that as an open menu made the runner SKIP the click and then read the pagination
      // list as the field's options - the exact signature that stalled the Degree dropdown on two tenants. Only a visible
      // listbox that actually holds the wanted option counts as already open.
      alreadyOpen: btn.getAttribute("aria-controls")
        || ([...document.querySelectorAll('ul[role="listbox"], [role="listbox"]')].some((e) => {
              const r = e.getBoundingClientRect();
              if (!(r.width > 2 && r.height > 2 && getComputedStyle(e).display !== "none")) return false;
              const want = String(w).trim().toLowerCase();
              return [...e.querySelectorAll('[role=option], li')].some((o) => (o.innerText || "").trim().toLowerCase() === want);
            }) ? "listbox-with-option" : null),
      current: (btn.innerText || "").trim(),
    };
  }, { src: questionRe, idx: index, w: optionText });
  if (!open.ok) return { q: questionRe, index, ok: false, why: open.why };
  if (!open.alreadyOpen) {
    await page.mouse.click(open.x, open.y);
    await sleep(1700);
    // The coordinate press can miss: on Micron's tenant it never opened the Degree menu, leaving an unrelated pagination
    // listbox as the only visible one. Ask the button itself to open before giving up.
    // The coordinate press is unreliable for tenants whose prompt buttons carry no aria-controls; a locator click on the
    // button itself opens the menu. Do it whenever no visible listbox already offers the wanted option.
    const menuReady = await page.evaluate((want) => {
      const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).display !== "none"; };
      const norm = String(want).trim().toLowerCase();
      return [...document.querySelectorAll('ul[role="listbox"], [role="listbox"]')].some((b) =>
        visible(b) && [...b.querySelectorAll('[role=option], li')].some((o) => (o.innerText || "").trim().toLowerCase() === norm));
    }, optionText).catch(() => false);
    if (!menuReady) {
      // Marked-field click first, then the id-suffix locator, which is what a standalone probe used successfully on a
      // prompt whose coordinate press never opened it (both Micron's and Workday's Degree controls).
      const marked = `[data-runner-target="${open.marker}"] button[aria-haspopup="listbox"], [data-runner-target="${open.marker}"] button`;
      await page.locator(marked).first().click({ timeout: 6000 }).catch(() => {});
      await sleep(1400);
      const stillShut = await page.evaluate((want) => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).display !== "none"; };
        const norm = String(want).trim().toLowerCase();
        return ![...document.querySelectorAll('ul[role="listbox"], [role="listbox"]')].some((b) =>
          vis(b) && [...b.querySelectorAll('[role=option], li')].some((o) => (o.innerText || "").trim().toLowerCase() === norm));
      }, optionText).catch(() => false);
      if (stillShut && open.suffix) {
        await page.locator(`button[id$="--${open.suffix}"]`).nth(index).click({ timeout: 6000 }).catch(() => {});
        await sleep(1600);
      }
    }
  } else {
    log(`  (field #${index} already had its menu open: ${open.alreadyOpen})`);
  }

  const picked = await page.evaluate(({ aid, marker, want }) => {
    const f = document.querySelector(`[data-runner-target="${marker}"]`) || document.querySelector(`[data-automation-id="${aid}"]`);
    const btn = f ? f.querySelector('button[aria-haspopup="listbox"], button') : null;
    const id = btn ? btn.getAttribute("aria-controls") : null;
    // Some tenants render the prompt with NO aria-controls at all (Micron's Degree buttons): the options live in a
    // ul[role=listbox] with a random id that nothing references. Only one menu is open at a time, so fall back to the
    // visible listbox.
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 2 && r.height > 2 && getComputedStyle(e).display !== "none";
    };
    const optsOf = (b) => (b ? [...b.querySelectorAll('[role=option], li')].map((e) => (e.innerText || "").trim()).filter(Boolean) : []);
    // Candidates: the aria-controls listbox first, then EVERY visible listbox. The wanted option decides - the first
    // visible listbox on this page is a pagination control ("Partial List (First 500 Entries)" / "All"), and choosing it
    // left the field at "Select One" while the real menu sat ignored beside it.
    const candidates = [];
    if (id) { const n = document.getElementById(id); if (n) candidates.push(n); }
    for (const e of document.querySelectorAll('ul[role="listbox"], [role="listbox"]')) if (visible(e)) candidates.push(e);
    const wantNorm = String(want).trim().toLowerCase();
    let box = candidates.find((b) => optsOf(b).some((o) => o.toLowerCase() === wantNorm)) || null;
    let opts = optsOf(box);
    if (!box) { box = candidates[0] || null; opts = optsOf(box); }
    if (!box) return { ok: false, why: "no listbox (aria-controls missing)", opts };
    const exact = opts.find((o) => o === want);
    const loose = opts.find((o) => o.toLowerCase() === want.toLowerCase());
    const target = exact || loose;
    if (!target) return { ok: false, why: "option not offered", opts };
    for (const o of box.querySelectorAll('[role=option], li')) {
      if ((o.innerText || "").trim() === target) {
        o.scrollIntoView({ block: "nearest" });
        o.click();
        return { ok: true, picked: target };
      }
    }
    return { ok: false, why: "option vanished" };
  }, { aid: open.aid, marker: open.marker, want: optionText });

  await sleep(1000);
  const readback = await page.evaluate(({ aid, marker }) => {
    const f = document.querySelector(`[data-runner-target="${marker}"]`) || document.querySelector(`[data-automation-id="${aid}"]`);
    const btn = f ? f.querySelector('button[aria-haspopup="listbox"], button') : null;
    return btn ? (btn.innerText || "").trim().slice(0, 60) : "?";
  }, { aid: open.aid, marker: open.marker });
  return { q: questionRe, index, ok: picked.ok && readback.toLowerCase().includes(optionText.toLowerCase().slice(0, 12)), picked: picked.picked, read: readback, offered: picked.opts ? picked.opts.slice(0, 6) : undefined };
}


/** Choose one or more options from a Workday MULTISELECT prompt ('N items selected').
 *  Distinct from a Select One: the control opens a list whose rows are menuItems/promptLeafNodes, the choice is a
 *  click on the row itself, and the field only clears its error once the selection is committed. */
async function chooseMultiSelect(questionRe, optionText, index = 0) {
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(300);

  // Prefer the field's OWN input (`#source--source` on Commerce/BigCommerce). Clicking the container midpoint can
  // miss a narrow input entirely, which is why an earlier attempt left the field at '0 items selected'.
  const open = await page.evaluate(({ src, idx }) => {
    const re = new RegExp(src, "i");
    const matches = [];
    for (const f of document.querySelectorAll('[data-automation-id^="formField-"]')) {
      if (!re.test((f.innerText || "").replace(/\s+/g, " "))) continue;
      const input = f.querySelector("input");
      if (!input) continue;
      matches.push({ f, input });
    }
    if (idx >= matches.length) return { ok: false, why: `only ${matches.length} matching fields` };
    const { f, input } = matches[idx];
    const marker = `multi-${Date.now()}-${idx}`;
    f.setAttribute("data-runner-target", marker);
    f.scrollIntoView({ block: "nearest" });
    input.focus();
    const r = input.getBoundingClientRect();
    return { ok: true, x: Math.round(r.x + Math.min(r.width, 60) / 2), y: Math.round(r.y + r.height / 2), marker, id: input.id || "" };
  }, { src: questionRe, idx: index });
  if (!open.ok) return { q: questionRe, ok: false, why: open.why };

  await page.mouse.click(open.x, open.y);
  await sleep(900);

  // TYPING IS WHAT OPENS THIS LIST (fixed 2026-10-08). On NVIDIA's "How Did You Hear About Us?" the control is a
  // multiselectInputContainer > monikerSearchBox, and a click alone leaves its menu EMPTY - the container reports
  // "Expanded" while holding no rows at all, the field reads as unset, and the wizard refuses to advance with "The
  // field How Did You Hear About Us? is required and must have a value". The options are fetched as the text changes,
  // so REAL keystrokes are needed: a page-context value write plus an input event, and even two ArrowDown keydowns,
  // produced no options.
  //
  // THE FOCUS HAS TO BE RE-ASSERTED FIRST. A first version typed right after the click and the input came back EMPTY
  // (`val: ""`), because the click leaves focus on the multiselect CONTAINER rather than its inner searchBox - so the
  // keystrokes went nowhere. Focusing by the id the measure step already captured is what makes the typing land.
  if (open.id) await page.locator(`#${open.id}`).focus({ timeout: 4000 }).catch(() => {});
  await page.keyboard.type(String(optionText).slice(0, 24), { delay: 60 }).catch(() => {});
  await sleep(1800);

  const readMenu = async () =>
    await page.evaluate(() => {
      const rows = [];
      // `li` ALONE WAS CATCHING THE WIZARD STEP BAR, which is why this runner once reported the step names as the
      // field's "offered" options. Scope it to the prompt subtree rather than dropping it, so tenants whose rows are
      // list items inside a prompt container keep working.
      for (const el of document.querySelectorAll('[role=option], [data-automation-id="menuItem"], [data-automation-id="promptLeafNode"], [data-automation-id*="prompt" i] li')) {
        const t = (el.innerText || "").trim();
        const r = el.getBoundingClientRect();
        if (t && t.length < 60 && r.width > 5 && r.height > 5) rows.push({ t });
      }
      return [...new Set(rows.map((r) => r.t))].slice(0, 18);
    });

  // Measure the row, then press it with a REAL MOUSE EVENT. A page-context el.click() on these rows does not
  // commit the choice: the field keeps reading 'Expanded' even though the row reports aria-selected.
  const clickRow = async (want, allowLoose = true) => {
    const found = await page.evaluate(({ w, loose }) => {
      const rows = [];
      for (const el of document.querySelectorAll('[role=option], [data-automation-id="menuItem"], [data-automation-id="promptLeafNode"], [data-automation-id*="prompt" i] li')) {
        const t = (el.innerText || "").trim();
        const r = el.getBoundingClientRect();
        if (t && t.length < 60 && r.width > 5 && r.height > 5) rows.push({ el, t, r });
      }
      const hit = rows.find((x) => x.t === w)
        || rows.find((x) => x.t.toLowerCase() === w.toLowerCase())
        || (loose ? rows.find((x) => x.t.toLowerCase().includes(w.toLowerCase())) : null);
      if (!hit) return { ok: false, offered: [...new Set(rows.map((r) => r.t))].slice(0, 14) };
      return {
        ok: true,
        picked: hit.t,
        x: Math.round(hit.r.x + hit.r.width / 2),
        y: Math.round(hit.r.y + hit.r.height / 2),
      };
    }, { w: want, loose: allowLoose });
    if (!found.ok) return found;
    await page.mouse.move(found.x, found.y).catch(() => {});
    await sleep(120);
    await page.mouse.click(found.x, found.y).catch(() => {});
    await sleep(1200);
    return found;
  };

  let menu = await readMenu();
  let result = await clickRow(optionText);
  if (!result.ok) {
    // tolerate the tenant's wording (Website vs Company Website) before giving up
    const alternates = ["Company Website", "Website", "Careers Page", "Company Site", "Other"];
    for (const alt of alternates) {
      if (result.ok) break;
      if (!menu.some((m) => new RegExp(alt, "i").test(m))) continue;
      result = await clickRow(alt);
    }
  }
  if (!result.ok) {
    return { q: questionRe, ok: false, why: "option not offered", offered: result.offered || menu };
  }
  await sleep(1500);

  // A two-level picker drills into a submenu after the first click; if the field still reads 0 selected, choose the
  // company's own site from whatever submenu appeared.
  let readback = await page.evaluate((m) => {
    const f = document.querySelector(`[data-runner-target="${m}"]`);
    return f ? (f.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80) : "?";
  }, open.marker);
  // '0 items selected' OR 'Expanded' both mean "not chosen yet": the second is what a two-level picker shows after
  // the first click drills into its submenu. Only a real selection (N items selected) counts as done.
  if (/0 items selected/.test(readback) || /expanded/i.test(readback)) {
    // PRESS THE REQUESTED ROW A SECOND TIME BEFORE FALLING BACK TO A SHORTLIST (fixed 2026-10-07, NVIDIA).
    // On NVIDIA's "How Did You Hear About Us?" the first press opened the listbox and reported the row as picked,
    // while the field still read "Expanded Error: The field ... is required" - the menu had re-rendered the row
    // underneath the press. The old fallback then searched a shortlist written for other tenants (careers page /
    // company website / other) and matched NOTHING, because NVIDIA's own list is Associations, Event/Conference,
    // Job Board, Social Media, University, Website - so it logged the menu and left the required field empty, which
    // blocked the whole wizard. The row the plan actually asked for is now re-pressed first, and the shortlist is
    // consulted only if that still does not settle it.
    // READ THE MENU AGAIN **AND KEEP THE ONE ALREADY CAPTURED** (fixed 2026-10-07, NVIDIA). On NVIDIA the listbox
    // CLOSES on the first press, so this re-read returns only the page's own <li> elements - the step bar and the
    // phone dialling codes - and the option list the fallback needs is no longer in it. That made every fallback
    // impossible to match on this tenant, and the "submenu offered" line it logged was the step bar, not a menu.
    const fresh = await readMenu();
    const sub = [...new Set([...fresh, ...menu])];
    let own = sub.find((s) => s.toLowerCase() === String(optionText).toLowerCase())
      || sub.find((s) => s.toLowerCase().includes(String(optionText).toLowerCase()));
    if (own) {
      const retry = await clickRow(own);
      log("  re-pressed the requested row:", JSON.stringify(retry).slice(0, 160));
      await sleep(1200);
      readback = await page.evaluate((m) => {
        const f = document.querySelector(`[data-runner-target="${m}"]`);
        return f ? (f.innerText || "").replace(/\s+/g, " ").trim().slice(0, 90) : "?";
      }, open.marker);
      log("  after re-press:", readback);
    }
    if (/0 items selected/.test(readback) || /expanded/i.test(readback)) {
      const preferred = sub.find((s) => /careers page/i.test(s))
        || sub.find((s) => /commerce|bigcommerce|trimble|workday/i.test(s))
        || sub.find((s) => /company website|company site/i.test(s))
        || sub.find((s) => /website/i.test(s))
        || sub.find((s) => /other/i.test(s));
      if (preferred) own = preferred;
    }
    if (own) {
      const second = await clickRow(own);
      log("  two-level picker: chose sub-option", JSON.stringify(second).slice(0, 160));
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(1200);
      readback = await page.evaluate((m) => {
        const f = document.querySelector(`[data-runner-target="${m}"]`);
        return f ? (f.innerText || "").replace(/\s+/g, " ").trim().slice(0, 90) : "?";
      }, open.marker);
      log("  after sub-option:", readback);
    } else {
      log("  two-level picker submenu offered:", JSON.stringify(sub).slice(0, 220));
    }
  }

  await page.evaluate(() => {
    for (const b of document.querySelectorAll("button")) {
      if (/^(save|done|ok|apply|close)$/i.test((b.innerText || "").trim())) { b.click(); return; }
    }
  });
  await sleep(1000);
  const settled = /\d+ items? selected/i.test(readback) && !/0 items selected/i.test(readback);
  return { q: questionRe, ok: settled, picked: result.picked, read: readback, menu };
}

/** choose a radio option (Workday renders Yes/No and similar questions as radio groups) by question + option text */
async function chooseRadio(questionRe, optionRe) {
  const r = await page.evaluate(({ q, o }) => {
    const qre = new RegExp(q, "i");
    const ore = new RegExp(o, "i");
    for (const f of document.querySelectorAll('[data-automation-id^="formField-"]')) {
      if (!qre.test((f.innerText || "").replace(/\s+/g, " "))) continue;
      for (const lab of f.querySelectorAll("label")) {
        const t = (lab.innerText || "").replace(/\s+/g, " ").trim();
        if (!ore.test(t) || t.length > 30) continue;
        lab.scrollIntoView({ block: "nearest" });
        lab.click();
        const input = lab.querySelector('input[type="radio"]') || (lab.htmlFor ? document.getElementById(lab.htmlFor) : null);
        return { ok: input ? input.checked : true, picked: t, checked: input ? input.checked : "?" };
      }
    }
    return { ok: false, why: "radio option not found" };
  }, { q: questionRe, o: optionRe });
  await sleep(800);
  return { q: questionRe, ...r };
}

/** tick a checkbox located by its question text.
 *  A page-context label click is not always enough (Workday's consent boxes ignore it), so this falls back to the
 *  input's own click and finally to a real mouse press on the input's rectangle - the sequence that actually
 *  works. The result is read back every time. */
async function tickCheckbox(questionRe) {
  // Accept either a plain question regex or a plan object ({q, note}), and an optional option regex for checkbox GROUPS
  // whose members share one field. A group's first box is not necessarily the wanted one.
  const wantQ = typeof questionRe === "string" ? questionRe : (questionRe && questionRe.q) || "";
  const wantO = typeof questionRe === "object" && questionRe ? questionRe.option : undefined;
  const locate = await page.evaluate(({ src, opt }) => {
    const re = new RegExp(src, "i");
    for (const f of document.querySelectorAll('[data-automation-id^="formField-"]')) {
      const fieldText = (f.innerText || "").replace(/\s+/g, " ");
      if (!re.test(fieldText)) continue;
      if (opt) {
        // the option lives in a label whose own text matches; tick that one rather than the first box
        const ore = new RegExp(opt, "i");
        const lab = [...f.querySelectorAll("label")].find((l) => ore.test((l.innerText || "").replace(/\s+/g, " ")));
        if (lab) {
          const box = lab.querySelector('input[type="checkbox"]');
          lab.setAttribute("data-runner-option", "1");
          f.setAttribute("data-runner-target", "chk-opt");
          return { ok: true, marker: "chk-opt", byOption: true, checked: box ? box.checked : false, picked: (lab.innerText || "").trim().slice(0, 60) };
        }
      }
      const box = f.querySelector('input[type="checkbox"]');
      if (!box) continue;
      const marker = `chk-${Date.now()}`;
      f.setAttribute("data-runner-target", marker);
      return { ok: true, marker, checked: box.checked };
    }
    return { ok: false, why: "not found" };
  }, { src: wantQ, opt: wantO });
  if (!locate.ok) return { q: wantQ, ok: false, why: locate.why };
  if (locate.byOption) {
    await page.evaluate(() => document.querySelector('[data-runner-option="1"]')?.click());
    await sleep(900);
    const after = await page.evaluate(() => {
      const lab = document.querySelector('[data-runner-option="1"]');
      const b = lab ? lab.querySelector('input[type="checkbox"]') : null;
      return { checked: b ? b.checked : "?", picked: (lab?.innerText || "").trim().slice(0, 60) };
    });
    return { q: wantQ, option: wantO, ok: after.checked === true, checked: after.checked, picked: after.picked, how: "option label click" };
  }
  if (locate.checked) return { q: wantQ, ok: true, checked: true, how: "already ticked" };

  const read = async () =>
    await page.evaluate((m) => {
      const f = document.querySelector(`[data-runner-target="${m}"]`);
      const b = f ? f.querySelector('input[type="checkbox"]') : null;
      return b ? b.checked : "?";
    }, locate.marker);

  // 1) page-context label click
  await page.evaluate((m) => {
    const f = document.querySelector(`[data-runner-target="${m}"]`);
    const b = f ? f.querySelector('input[type="checkbox"]') : null;
    if (b && !b.checked) (b.closest("label") || b.parentElement).click();
  }, locate.marker);
  await sleep(600);
  if ((await read()) === true) return { q: questionRe, ok: true, checked: true, how: "label click" };

  // 2) the input's own click
  await page.evaluate((m) => {
    const f = document.querySelector(`[data-runner-target="${m}"]`);
    const b = f ? f.querySelector('input[type="checkbox"]') : null;
    if (b && !b.checked) b.click();
  }, locate.marker);
  await sleep(600);
  if ((await read()) === true) return { q: questionRe, ok: true, checked: true, how: "input click" };

  // 3) a real mouse press on the control
  const geo = await page.evaluate((m) => {
    const f = document.querySelector(`[data-runner-target="${m}"]`);
    const b = f ? f.querySelector('input[type="checkbox"]') : null;
    const el = b || f;
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + Math.min(r.width, 24) / 2), y: Math.round(r.y + r.height / 2) };
  }, locate.marker);
  if (geo) {
    await page.mouse.click(geo.x, geo.y).catch(() => {});
    await sleep(700);
  }
  const final = await read();
  return { q: questionRe, ok: final === true, checked: final, how: "mouse press" };
}


/** set a text/textarea by its question LABEL (for fields with no usable name, e.g. Workday's Date and Name on a
 *  self-identify step). Real keystrokes, value read back. */
async function setTextByLabel(questionRe, value) {
  const found = await page.evaluate((src) => {
    const re = new RegExp(src, "i");
    for (const f of document.querySelectorAll('[data-automation-id^="formField-"]')) {
      if (!re.test((f.innerText || "").replace(/\s+/g, " "))) continue;
      const el = f.querySelector("textarea, input[type=text], input:not([type])");
      if (!el) continue;
      const marker = `lbl-${Date.now()}`;
      f.setAttribute("data-runner-target", marker);
      el.scrollIntoView({ block: "nearest" });
      el.focus();
      el.select && el.select();
      return { ok: true, marker, name: el.name || "" };
    }
    return { ok: false };
  }, questionRe);
  if (!found.ok) return { q: questionRe, ok: false, why: "field not found" };
  await page.keyboard.press("Meta+a").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(String(value), { delay: 90 });
  await sleep(400);
  const read = await page.evaluate((m) => {
    const f = document.querySelector(`[data-runner-target="${m}"]`);
    const el = f ? f.querySelector("textarea, input[type=text], input:not([type])") : null;
    return el ? el.value : "?";
  }, found.marker);
  const norm = (s) => String(s || "").replace(/\D/g, "");
  const ok = String(value).match(/\d/) ? norm(read) === norm(value) : read.toLowerCase().includes(String(value).toLowerCase().slice(0, 8));
  return { q: questionRe, name: found.name, ok, read };
}

/** check exactly one box in a group, by the option text (used for Workday's disability self-identification) */
async function checkOneOption(questionRe, optionRe) {
  const r = await page.evaluate(({ q, o }) => {
    const qre = new RegExp(q, "i");
    const ore = new RegExp(o, "i");
    for (const f of document.querySelectorAll('[data-automation-id^="formField-"]')) {
      if (!qre.test((f.innerText || "").replace(/\s+/g, " "))) continue;
      const boxes = [...f.querySelectorAll('input[type="checkbox"]')];
      if (!boxes.length) continue;
      const chosen = boxes.map((c) => {
        let node = c, text = "";
        for (let k = 0; k < 6 && node; k++) {
          node = node.parentElement;
          const tt = (node && node.innerText || "").replace(/\s+/g, " ").trim();
          if (tt.length > 12) { text = tt; break; }
        }
        return { c, text };
      }).find((x) => ore.test(x.text));
      if (!chosen) return { ok: false, why: "option not found", offered: boxes.length };
      if (!chosen.c.checked) {
        (chosen.c.closest("label") || chosen.c.parentElement).click();
        if (!chosen.c.checked) chosen.c.click();
      }
      // exactly one: untick any other that is checked
      for (const c of boxes) if (c !== chosen.c && c.checked) (c.closest("label") || c.parentElement).click();
      const final = boxes.map((c) => c.checked);
      return { ok: chosen.c.checked && final.filter(Boolean).length === 1, picked: chosen.text.slice(0, 60), states: final };
    }
    return { ok: false, why: "group not found" };
  }, { q: questionRe, o: optionRe });
  await sleep(600);
  return { q: questionRe, ...r };
}


/** --discover: print every control on the current step, with a select's offered options, without changing anything */
async function discoverStep() {
  const rows = await page.evaluate(() => {
    const out = [];
    for (const f of document.querySelectorAll('[data-automation-id^="formField-"]')) {
      const label = (f.innerText || "").replace(/\s+/g, " ").trim();
      const btn = f.querySelector('button[aria-haspopup="listbox"], button');
      const boxes = [...f.querySelectorAll('input[type="checkbox"]')];
      const texts = [...f.querySelectorAll('input[type="text"], input:not([type]), textarea')];
      const radios = [...f.querySelectorAll('input[type="radio"]')];
      out.push({
        aid: f.getAttribute("data-automation-id"),
        kind: btn ? "select" : boxes.length ? "checks" : radios.length ? "radio" : texts.length ? "text" : "other",
        label: label.slice(0, 110),
        names: texts.map((i) => i.name).filter(Boolean),
        required: /\*/.test(label),
      });
    }
    return out;
  });
  console.log(`\n--- step ${(await state()).step} controls ---`);
  for (const r of rows) {
    console.log(`  [${r.kind}${r.required ? "*" : ""}] ${r.label}`);
    if (r.names.length) console.log(`        names: ${r.names.join(", ")}`);
    if (r.kind === "select") {
      const opts = await page.evaluate((aid) => {
        const f = [...document.querySelectorAll('[data-automation-id^="formField-"]')].find((x) => x.getAttribute("data-automation-id") === aid);
        if (!f) return null;
        const btn = f.querySelector('button[aria-haspopup="listbox"], button');
        if (!btn) return null;
        const wasOpen = btn.getAttribute("aria-controls");
        if (!wasOpen) btn.click();
        return { id: btn.getAttribute("aria-controls"), wasOpen: Boolean(wasOpen) };
      }, r.aid);
      if (opts && opts.id) {
        await sleep(900);
        const list = await page.evaluate((id) => {
          const box = document.getElementById(id);
          return box ? [...box.querySelectorAll('[role=option], li')].map((e) => (e.innerText || "").trim()).filter(Boolean) : [];
        }, opts.id);
        if (list.length) console.log(`        options: ${JSON.stringify(list.slice(0, 12))}`);
        if (!opts.wasOpen) await page.keyboard.press("Escape").catch(() => {});
        await sleep(300);
      }
    }
  }
  return rows.length;
}





/** Activate the account when the tenant emailed an activation link.
 *
 *  Some tenants (Commerce/BigCommerce) create the account in a pending state and mail a one-click activation URL;
 *  signing in before activating simply bounces back to /login, which is exactly the symptom this fixes. The link is
 *  read from the newest matching message with the project's own mail tool, so the whole account lifecycle stays
 *  scripted. Returns true when it navigated. */
async function activateAccountIfRequired() {
  const onLogin = /\/login/i.test(page.url());
  const looksPending = onLogin || /verify|activate/i.test(await page.evaluate(() => document.body.innerText.slice(0, 400)));
  if (!looksPending) return false;
  const tenantWord = (page.url().match(/\/\/([^.]+)\./) || [])[1] || "";
  log("checking the mailbox for an activation link", tenantWord ? `(${tenantWord})` : "");
  let body = "";
  try {
    const { execFile } = await import("node:child_process");
    const run = (args) => new Promise((res) => execFile("osascript", args, { maxBuffer: 4 << 20 }, (e, so) => res(e ? "" : String(so))));
    body = await run(["src/tools/mail_app_body.applescript", "Verify your candidate account"]);
  } catch (e) {
    log("could not read the mailbox:", String(e).slice(0, 120));
    return false;
  }
  const links = [...body.matchAll(/https:\/\/[^\s"<>]*\/activate\/[^\s"<>]+/g)].map((m) => m[0]);
  if (!links.length) {
    log("no activation link found in that message");
    return false;
  }
  const link = links[0];
  log("activating via the emailed link");
  await page.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(8000);
  const st = await state();
  log(`after activation: ${page.url().slice(0, 90)} | step ${st.step} errors=${JSON.stringify(st.errors).slice(0, 160)}`);
  return true;
}


/** Read the credential recorded for this application. */
async function loadCredential() {
  const path = await import("node:path");
  const { readFile } = await import("node:fs/promises");
  const accountPath = path.join(
    path.dirname(path.resolve(args.payload)),
    `${path.basename(args.payload).replace(/\.json$/, "")}_account.json`,
  );
  try {
    return JSON.parse(await readFile(accountPath, "utf8"));
  } catch {
    if (args.email && args.accountPassword) return { email: args.email, password: args.accountPassword };
    return null;
  }
}

/** Read the newest Workday password-reset mail and return its link. */
async function readResetLink() {
  const { execFile } = await import("node:child_process");
  const run = (a) => new Promise((res) => execFile("osascript", a, { maxBuffer: 4 << 20 }, (e, so) => res(e ? "" : String(so))));
  for (const subject of ["Reset your password", "password reset", "Reset Password"]) {
    const body = await run(["src/tools/mail_app_body.applescript", subject]);
    const links = [...body.matchAll(/https:\/\/[^\s"<>]*(?:reset|password|activate)[^\s"<>]*/gi)].map((m) => m[0]);
    if (links.length) return links[0];
  }
  return "";
}

/** Drive the tenant's "Forgot your password?" flow, then sign in. Returns true when it acted. */
async function resetPasswordIfRequested() {
  if (!args.resetPassword) return false;
  const cred = await loadCredential();
  if (!cred) { log("--reset-password needs a stored credential or --email/--account-password"); return false; }
  log("password reset requested for", cred.email);

  await dismissConsent();

  // Already on the tenant's reset form? Go straight to setting the password - re-requesting would only mint a
  // second link and leave this one unused.
  const alreadyOnResetForm = /passwordreset|resetpassword|reset-password/i.test(page.url());
  if (alreadyOnResetForm) log("already on the reset form; setting the password directly");
  const opened = alreadyOnResetForm ? true : await page.evaluate(() => {
    const link = [...document.querySelectorAll("a,button")].find((e) => /forgot your password|reset/i.test((e.innerText || "").trim()));
    if (!link) return false;
    link.scrollIntoView({ block: "nearest" });
    link.click();
    return true;
  });
  log("forgot-password control:", opened ? "clicked" : "not found");
  await sleep(4000);

  // fill the address field of whatever form is now shown
  const typed = await page.evaluate((em) => {
    const trap = (el) => {
      const wrap = el.closest('[data-automation-id^="formField-"]') || el.closest("label") || el.parentElement;
      const text = wrap ? (wrap.innerText || "") : "";
      return /robots? only|do not enter|for robots|honeypot|anti[- ]?spam/i.test(text) || /^(website|url|homepage|fax|honeypot|trap)$/i.test(el.name || "");
    };
    const candidates = [...document.querySelectorAll("input")].filter((i) => !trap(i) && !["hidden", "password", "submit", "button", "checkbox", "radio"].includes(i.type));
    const el = candidates.find((i) => /email|username/i.test(i.name || i.id || "")) || candidates.find((i) => i.type === "email") || candidates.find((i) => i.type === "text") || candidates[0];
    if (!el) return false;
    el.setAttribute("data-runner-target", "rst-email");
    el.scrollIntoView({ block: "nearest" });
    el.focus();
    el.select && el.select();
    return true;
  }, cred.email);
  if (!alreadyOnResetForm && typed) {
    await page.keyboard.press("Meta+a").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(cred.email, { delay: 30 });
  }
  await dismissConsent();
  const pressed = await page.evaluate(() => {
    for (const re of [/^(submit|send|reset|continue|next|request)/i]) {
      const pool = document;
      const b = [...pool.querySelectorAll("button")].find((x) => re.test((x.innerText || "").trim()));
      if (b) {
        b.scrollIntoView({ block: "nearest" });
        const r = b.getBoundingClientRect();
        return { label: b.innerText.trim(), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
    }
    return null;
  });
  const requested = await pressVerified(findButton("^(submit|send|reset|request|continue|next)"), "reset request");
  log("reset request:", JSON.stringify(requested).slice(0, 240));
  await sleep(7000);

  if (!alreadyOnResetForm) {
    log("waiting for the reset mail");
    let link = "";
    for (let i = 0; i < 5 && !link; i++) {
      await sleep(6000);
      link = await readResetLink();
    }
    if (!link) { log("no reset link arrived yet; re-run this mode after the mail lands"); return true; }
    log("opening the reset link");
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sleep(7000);
  }

  // set the stored password on the reset form (two password fields)
  const set = await page.evaluate(() => {
    const pws = [...document.querySelectorAll('input[type="password"]')];
    pws.forEach((el, i) => el.setAttribute("data-runner-target", i === 0 ? "rst-pw1" : "rst-pw2"));
    return pws.length;
  });
  log("password fields on the reset form:", set);
  for (const tag of ["rst-pw1", "rst-pw2"]) {
    const ok = await page.evaluate((tg) => {
      const el = document.querySelector(`[data-runner-target="${tg}"]`);
      if (!el) return false;
      el.scrollIntoView({ block: "nearest" });
      el.focus();
      el.select && el.select();
      return true;
    }, tag);
    if (!ok) continue;
    await page.keyboard.press("Meta+a").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(cred.password, { delay: 30 });
  }
  await dismissConsent();
  const confirm = await page.evaluate(() => {
    // Prefer the button INSIDE the password form, and prefer reset-specific wording: a page-level nav 'Sign In'
    // matched first on the previous run and submitted nothing.
    const pw = document.querySelector('[data-runner-target="rst-pw1"]');
    const form = pw ? pw.closest("form") : null;
    const pools = form ? [form, document] : [document];
    const labels = [/^(reset password|save password|change password|set password|save|submit)/i, /^(continue|next)/i, /^sign in/i];
    for (const re of labels) {
      for (const pool of pools) {
        const b = [...pool.querySelectorAll("button")].find((x) => re.test((x.innerText || "").trim()));
        if (b) {
          b.scrollIntoView({ block: "nearest" });
          const r = b.getBoundingClientRect();
          return { label: b.innerText.trim(), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), scoped: pool !== document };
        }
      }
    }
    return null;
  });
  const changed = await pressVerified(findButton("^(submit|save|reset password|change password|set password|save|continue|sign in)"), "password change");
  log("password change:", JSON.stringify(changed).slice(0, 240));
  await sleep(9000);
  log(`after reset: step ${(await state()).step} | ${page.url().slice(0, 90)}`);
  return true;
}

/** Sign in when the tenant has bounced us to its login page (which happens right after creating an account).
 *  Credentials come from <slug>_account.json, i.e. the file account creation wrote, so the flow is self-contained. */
async function followPostActivationRedirect() {
  if (!/\/login\/ok/i.test(page.url())) return false;
  const target = await page.evaluate(() => new URL(location.href).searchParams.get("redirect"));
  if (!target) return false;
  const origin = new URL(page.url()).origin; // `location` is a browser global; in Node the page URL is the source
  const url = target.startsWith("http") ? target : new URL(target, origin).toString();
  log("post-activation screen: following the redirect to the application");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(8000);
  const st = await state();
  log(`after redirect: step ${st.step} | ${page.url().slice(0, 90)}`);
  return true;
}

async function signInIfRequired() {
  const onLogin = /\/login/i.test(page.url()) && !/\/login\/ok/i.test(page.url());
  const hasLogin = await page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, " ");
    return document.querySelectorAll('input[type="password"]').length >= 1 && /sign in|password/i.test(t);
  });
  if (!onLogin && !hasLogin) return false;

  let cred = null;
  try {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const accountPath = path.join(
      path.dirname(path.resolve(args.payload)),
      `${path.basename(args.payload).replace(/\.json$/, "")}_account.json`,
    );
    cred = JSON.parse(await readFile(accountPath, "utf8"));
  } catch {
    if (!args.email || !args.accountPassword) {
      log("sign-in screen but no saved credential; stopping");
      return false;
    }
    cred = { email: args.email, password: args.accountPassword };
  }
  log("signing in as", cred.email);

  // Scope to the sign-in form: a sign-up form can sit on the same screen.
  const discoverSignin = () => page.evaluate(() => {
    const heads = [...document.querySelectorAll("h1,h2,h3,legend")].filter((e) =>
      /^sign in$/i.test((e.innerText || "").trim())
    );
    let scope = null;
    for (const h of heads) {
      let n = h;
      for (let k = 0; k < 6 && n; k++) {
        n = n.parentElement;
        if (n && n.querySelector('input[type="password"]')) {
          scope = n;
          break;
        }
      }
      if (scope) break;
    }
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0;
    };
    if (!scope || !visible(scope.querySelector('input[type="password"]'))) {
      // A hidden template copy of the form can sit beside the live one; only a VISIBLE password field is real.
      const forms = [...document.querySelectorAll("form")].filter((f) => f.querySelector('input[type="password"]'));
      scope = forms.find((f) => visible(f.querySelector('input[type="password"]'))) || forms[forms.length - 1] || document;
    }
    const trap = (el) => {
      const wrap = el.closest('[data-automation-id^="formField-"]') || el.closest("label") || el.parentElement;
      const text = wrap ? (wrap.innerText || "") : "";
      return /robots? only|do not enter|for robots|honeypot|anti[- ]?spam/i.test(text) || /^(website|url|homepage|fax|honeypot|trap)$/i.test(el.name || "");
    };
    const inputs = [...scope.querySelectorAll("input")].filter((i) => !trap(i) && visible(i));
    const emailEl = inputs.find((i) => /email|username/i.test(i.name || i.id || "") || i.type === "text" || i.type === "email");
    const pwEl = inputs.find((i) => i.type === "password");
    if (emailEl) emailEl.setAttribute("data-runner-target", "li-email");
    if (pwEl) pwEl.setAttribute("data-runner-target", "li-pw");
    // Mark the form so the press can be scoped to it: the page also carries a NAV 'Sign In' button, and pressing
    // that one (the first match) does nothing at all.
    const form = (pwEl || emailEl) ? (pwEl || emailEl).closest("form") : null;
    const scopeEl = form || scope;
    if (scopeEl && scopeEl.setAttribute) scopeEl.setAttribute("data-runner-form", "signin");
    return { email: Boolean(emailEl), pw: Boolean(pwEl), scoped: scope !== document, formMarked: Boolean(scopeEl && scopeEl.setAttribute) };
  });
  let marks = await discoverSignin();
  log("sign-in form:", marks.scoped ? "scoped to its own form" : "page fallback", JSON.stringify(marks));

  const typeInto = async (tag, value) => {
    const ok = await page.evaluate((tg) => {
      const el = document.querySelector(`[data-runner-target="${tg}"]`);
      if (!el) return false;
      el.scrollIntoView({ block: "nearest" });
      el.focus();
      el.select && el.select();
      return true;
    }, tag);
    if (!ok) return false;
    await page.keyboard.press("Meta+a").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(String(value), { delay: 30 });
    // READ THE VALUE BACK (added 2026-10-07). Workday's sign-in form dropped two characters out of a 16-character
    // password: the screenshot showed 14 dots, the server answered "You may have entered the wrong email address or
    // password or your account might be locked", and the run looked like a wrong credential rather than a bad
    // keystroke. Same class as retype_all_text.mjs - never trust a type() without reading the field.
    const want = String(value);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const got = await page.evaluate((tg) => {
        const el = document.querySelector(`[data-runner-target="${tg}"]`);
        return el ? String(el.value || "") : null;
      }, tag);
      if (got === null || got === want) break;
      log(`  ${tag}: typed ${want.length} chars, field holds ${got.length} - retyping`);
      await page.evaluate((tg) => {
        const el = document.querySelector(`[data-runner-target="${tg}"]`);
        if (el) { el.focus(); el.select && el.select(); }
      }, tag);
      await page.keyboard.press("Meta+a").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await page.keyboard.type(want, { delay: 90 });
    }
    return true;
  };
  if (marks.email) await typeInto("li-email", cred.email);
  // TWO-STEP EMAIL SIGN-IN (added 2026-10-07, Workday's own tenant). Its "Sign in with email" renders an
  // EMAIL-ONLY step first and shows the password field only after that email is submitted. The single-pass
  // version above saw no visible password input at all, reported {email:false, pw:false} and stopped with
  // "control not found (sign-in submit)" - which reads like a broken form rather than a second screen.
  if (!marks.pw && marks.email) {
    const first = await pressVerified(findButton("^(continue|next|sign in|submit)$", null), "sign-in step one");
    log("sign-in step one:", JSON.stringify(first).slice(0, 160));
    await sleep(5000);
    marks = await discoverSignin();
    log("sign-in form (after step one):", JSON.stringify(marks));
    if (marks.email) await typeInto("li-email", cred.email);
  }
  if (marks.pw) await typeInto("li-pw", cred.password);

  await dismissConsent();

  // Prefer a button inside the sign-in form; fall back to the page.
  const geo = await page.evaluate(() => {
    const pw = document.querySelector('[data-runner-target="li-pw"]');
    const form = pw ? pw.closest("form") : null;
    const pools = form ? [form, document] : [document];
    for (const re of [/^sign in$/i, /^log in$/i, /^continue$/i, /^submit$/i]) {
      for (const pool of pools) {
        const b = [...pool.querySelectorAll("button")].find((x) => re.test((x.innerText || "").trim()));
        if (b) {
          b.scrollIntoView({ block: "nearest" });
          const r = b.getBoundingClientRect();
          return { label: b.innerText.trim(), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), scoped: pool !== document };
        }
      }
    }
    return null;
  });
  const pressed = await pressVerified(
    findButton("^(sign in|log in|submit)$", '[data-runner-form="signin"]'),
    "sign-in submit",
  );
  log("sign-in:", JSON.stringify(pressed).slice(0, 240));
  await sleep(9000);
  const st = await state();
  log(`after sign-in: step ${st.step} | ${page.url().slice(0, 90)}`);
  return true;
}



/**
 * Anti-bot honeypot detection.
 *
 * ATS forms commonly ship a field a human would never see or fill, and filling it marks the submission as automated
 * - after which the form refuses SILENTLY, rendering no validation message (Commerce's reset page did exactly this
 * with name="website" and the label 'This input is for robots only, do not enter if you're human').
 */
const HONEYPOT_LABEL = /robots? only|do not enter|for robots|leave (this )?(field )?(blank|empty)|honeypot|anti[- ]?spam/i;
const HONEYPOT_NAMES = /^(website|url|homepage|company_website|fax|honeypot|trap|confirm_email|email_confirm)$/i;

/** Return true when the element looks like an anti-bot trap. Runs in the page. */
function isHoneypot(el) {
  const wrap = el.closest('[data-automation-id^="formField-"]') || el.closest("label") || el.parentElement;
  const text = wrap ? (wrap.innerText || "") : "";
  if (HONEYPOT_LABEL.test(text)) return true;
  if (HONEYPOT_NAMES.test(el.name || "")) return true;
  const style = window.getComputedStyle(el);
  const hidden = style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0;
  const offscreen = el.getBoundingClientRect().width === 0;
  if ((hidden || offscreen) && (el.tabIndex < 0 || el.getAttribute("aria-hidden") === "true")) return true;
  return false;
}

/** Clear every trap field on the page so a value left by an earlier run cannot keep refusing the form. */
async function scrubHoneypots() {
  const cleared = await page.evaluate(() => {
    const out = [];
    const label = /robots? only|do not enter|for robots|leave (this )?(field )?(blank|empty)|honeypot|anti[- ]?spam/i;
    const names = /^(website|url|homepage|company_website|fax|honeypot|trap|confirm_email|email_confirm)$/i;
    for (const el of document.querySelectorAll("input, textarea")) {
      if (["hidden", "file", "submit", "button"].includes(el.type)) continue;
      const wrap = el.closest('[data-automation-id^="formField-"]') || el.closest("label") || el.parentElement;
      const text = wrap ? (wrap.innerText || "") : "";
      if (!(label.test(text) || names.test(el.name || ""))) continue;
      if ((el.value || "").trim()) {
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, "");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        out.push(`${el.name || el.id || "(unnamed)"} cleared`);
      }
    }
    return out;
  });
  if (cleared.length) log("honeypot scrubber:", JSON.stringify(cleared));
  return cleared;
}

/** A page signature used to detect that a press did something. */
async function signature() {
  return await page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, " ").trim();
    const step = (t.match(/current step (\d+) of (\d+)/i) || [])[0] || "";
    return `${location.href}||${step}||${t.length}||${t.slice(0, 160)}`;
  });
}

/**
 * Press a control and PROVE it landed.
 *
 * `find` is a function evaluated in the page returning {x, y, label} for the control (coordinates measured at that
 * moment), or null. Escalation order: real mouse press -> focus + Enter -> page-context click -> synthetic pointer
 * events. Returns { ok, label, how, changed, message }.
 */
async function pressVerified(find, what) {
  await scrubHoneypots(); // a polluted trap field refuses the form silently
  const before = await signature();

  for (const how of ["mouse", "enter", "form-submit", "js-click", "pointer-events"]) {
    const found = await page.evaluate(find);
    if (!found) return { ok: false, why: `control not found (${what})`, how };

    if (how === "mouse") {
      await page.mouse.move(found.x, found.y).catch(() => {});
      await sleep(120);
      await page.mouse.click(found.x, found.y).catch(() => {});
    } else if (how === "enter") {
      // Prefer the marked input (a password/email field), because Enter inside the field is what submits the form;
      // pressing Enter on <body> does nothing at all.
      const focused = await page.evaluate(() => {
        for (const sel of ['[data-runner-target="li-pw"]', '[data-runner-target="li-email"]', '[data-runner-target="rst-pw2"]', '[data-runner-target="rst-pw1"]', '[data-runner-target="acct-pw1"]']) {
          const el = document.querySelector(sel);
          if (el) { el.focus(); return sel; }
        }
        return null;
      });
      await page.keyboard.press("Enter").catch(() => {});
      if (!focused) log("  (no marked field to focus before Enter)");
    } else if (how === "form-submit") {
      // Ask the browser to submit the enclosing form properly (fires its submit handler, unlike raw .submit()).
      const submitted = await page.evaluate(() => {
        const marked = document.querySelector('[data-runner-target="li-pw"], [data-runner-target="rst-pw1"], [data-runner-target="acct-pw1"]');
        const form = marked ? marked.closest("form") : null;
        if (!form) return false;
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
        return true;
      });
      if (!submitted) { log("  (no form to submit for this control)"); continue; }
    } else if (how === "js-click") {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.click();
      }, found.sel || "body").catch(() => {});
    } else {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return;
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      }, found.sel || "body").catch(() => {});
    }

    await sleep(3500);
    const after = await signature();
    if (after !== before) {
      log(`pressed "${found.label}" via ${how} (${what})`);
      return { ok: true, label: found.label, how, changed: true };
    }
    log(`press "${found.label}" via ${how} did not change the page (${what}); escalating`);
  }

  const message = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[class*="error" i],[role=alert],[class*="msg" i],[class*="valid" i],[data-automation-id*="error" i]')];
    return nodes.map((n) => (n.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 4).join(" | ");
  });
  return { ok: false, why: `no press changed the page (${what})`, message };
}

/** Resolver factory: find a button whose text matches, measure it NOW, and also return a CSS path for fallbacks. */
function findButton(regexSource, scopeSelector = "") {
  return `(() => {
    const re = new RegExp(${JSON.stringify(regexSource)}, "i");
    const scope = ${scopeSelector ? `document.querySelector(${JSON.stringify(scopeSelector)}) || document` : "document"};
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      const s = window.getComputedStyle(e);
      return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0;
    };
    // ONLY visible controls. Workday renders duplicate and hidden copies of the same button (a nav 'Sign In'
    // beside the form's, a template 'Save and Continue' beside the real one), and pressing the invisible twin is
    // the single most common reason a click "does nothing".
    const els = [...scope.querySelectorAll("button, [role=button], input[type=submit], a")].filter(visible);
    const el = els.find((e) => re.test((e.innerText || e.value || "").trim()) && !e.disabled);
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    // give it a stable attribute so the escalation paths can reach the same element
    el.setAttribute("data-runner-press", "1");
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: (el.innerText || el.value || "").trim().slice(0, 40), sel: '[data-runner-press="1"]' };
  })()`;
}

/** --dump: print every control on the current page, whatever kind of page it is. */
async function dumpCurrentPage() {
  const info = await page.evaluate(() => {
    const out = { url: location.href, headings: [], fields: [], buttons: [], messages: [] };
    out.headings = [...document.querySelectorAll("h1,h2,h3,legend,label[for]")]
      .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 10);
    for (const i of document.querySelectorAll("input, textarea, select")) {
      if (["hidden"].includes(i.type)) continue;
      const w = i.closest('[data-automation-id^="formField-"]') || i.closest("label") || i.parentElement;
      out.fields.push({
        type: i.type || i.tagName.toLowerCase(),
        name: i.name || "",
        id: i.id || "",
        label: w ? (w.innerText || "").replace(/\s+/g, " ").trim().slice(0, 70) : "",
        value: (i.value || "").slice(0, 24),
      });
    }
    out.buttons = [...document.querySelectorAll("button, input[type=submit], [role=button]")]
      .map((b) => (b.innerText || b.value || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 14);
    out.messages = [...document.querySelectorAll('[class*="error" i],[role=alert],[class*="msg" i],[class*="valid" i]')]
      .map((n) => (n.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 6);
    return out;
  });
  console.log(`\n--- page dump ---`);
  console.log(`url      : ${info.url}`);
  console.log(`headings : ${JSON.stringify(info.headings)}`);
  console.log(`buttons  : ${JSON.stringify(info.buttons)}`);
  if (info.messages.length) console.log(`messages : ${JSON.stringify(info.messages)}`);
  console.log(`fields   :`);
  info.fields.forEach((f) => console.log(`   [${f.type}] name=${f.name || "-"} id=${f.id || "-"} val="${f.value}" | ${f.label}`));
  return info;
}

/** Dismiss a cookie/consent banner. A visible overlay silently swallows clicks on the control underneath it - the
 *  lesson recorded for Agave on Ashby - so this runs before every click that matters. */
async function dismissConsent() {
  const dismissed = await page.evaluate(() => {
    const re = /^(accept( all)?( cookies)?|accept cookies|i accept|allow all|necessary only|reject all|decline)$/i;
    for (const b of document.querySelectorAll("button, [role=button], a")) {
      const label = (b.innerText || "").trim();
      if (re.test(label)) {
        const r = b.getBoundingClientRect();
        if (r.width > 5 && r.height > 5) {
          b.click();
          return label;
        }
      }
    }
    return null;
  });
  if (dismissed) {
    log("dismissed consent banner:", dismissed);
    await sleep(1200);
  }
  return dismissed;
}

/** Some tenants (Commerce/BigCommerce) gate the application behind creating a Workday account. Detect that screen,
 *  create the account with the candidate's real email and a generated password, acknowledge the privacy notice,
 *  advance, and write the credential to <slug>_account.json so the user owns it. Returns true when it acted. */
/** Some tenants offer SSO first ("Sign in with Apple/Google/email") and only reveal the email+password form after the
 *  email choice is pressed, so the account detector sees no password field at all and the wizard stalls. Press it. */
async function openEmailSignInIfOffered() {
  const needsIt = await page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, " ");
    if (!/sign in with email/i.test(t)) return false;
    return document.querySelectorAll('input[type="password"]').length === 0;
  });
  if (!needsIt) return false;
  const pressed = await pressVerified(
    `(() => {
       const visible = (e) => { const r = e.getBoundingClientRect(); const s = window.getComputedStyle(e);
         return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden"; };
       const cands = [...document.querySelectorAll("button, a, [role=button]")].filter(visible)
         .filter((e) => /sign in with email|continue with email|use email/i.test((e.innerText || "").trim()));
       const el = cands[0];
       if (!el) return null;
       el.scrollIntoView({ block: "nearest" });
       const r = el.getBoundingClientRect();
       el.setAttribute("data-runner-press", "1");
       return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: (el.innerText || "").trim().slice(0, 30) };
     })()`,
    "sign in with email",
  );
  if (pressed.ok) { await sleep(3500); log("opened the email sign-in form"); }
  return pressed.ok;
}

/** The tenant may show SIGN IN first with a "Create Account" button; without a stored credential the registration form is
 *  one press away, but the account detector (two password fields) cannot see it. Press the button when nothing is stored. */
async function pressCreateAccountIfSignInOnly() {
  let hasCred = false;
  try {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const accountPath = path.join(path.dirname(path.resolve(args.payload)), `${path.basename(args.payload).replace(/\.json$/, "")}_account.json`);
    hasCred = !!JSON.parse(await readFile(accountPath, "utf8")).email;
  } catch { hasCred = false; }
  if (hasCred) return false;
  const state = await page.evaluate(() => ({
    pwFields: document.querySelectorAll('input[type="password"]').length,
    emailField: !!document.querySelector('input[type="text"][id*="email" i], input[type="email"], input[autocomplete="email"]'),
    hasCreate: /create account/i.test(document.body.innerText || ""),
  }));
  if (state.pwFields >= 2 || !state.hasCreate) return false;
  const pressed = await pressVerified(
    `(() => {
       const visible = (e) => { const r = e.getBoundingClientRect(); const s = window.getComputedStyle(e);
         return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden"; };
       const el = [...document.querySelectorAll("button, a, [role=button]")].filter(visible)
         .find((e) => /^\s*create account\s*$/i.test((e.innerText || "").trim()));
       if (!el) return null;
       el.scrollIntoView({ block: "nearest" });
       const r = el.getBoundingClientRect();
       el.setAttribute("data-runner-press", "1");
       return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: "Create Account" };
     })()`,
    "create account link",
  );
  if (pressed.ok) { await sleep(3500); log("pressed Create Account to reach registration"); }
  return pressed.ok;
}

async function createAccountIfRequired() {
  const screen = await page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, " ");
    const pw = document.querySelectorAll('input[type="password"]').length;
    const email = /email address/i.test(t);
    const privacy = /privacy notice|candidate data privacy/i.test(t);
    return { pw, email, privacy, isAccount: pw >= 2 && email };
  });
  if (!screen.isAccount) return false;

  // A recorded credential is NOT proof that the account exists - this tenant has shown the Create Account form again
  // on the application screen after a credential was already written, so the page in front of us is the authority.
  const onLoginScreen = /\/login/i.test(page.url());
  const showsCreateAccount = await page.evaluate(() => /create account/i.test(document.body.innerText || "")) && !onLoginScreen;
  if (!showsCreateAccount) {
    try {
      const { readFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const accountPath = path.join(path.dirname(path.resolve(args.payload)), `${path.basename(args.payload).replace(/\.json$/, "")}_account.json`);
      const existing = JSON.parse(await readFile(accountPath, "utf8"));
      if (existing && existing.email) {
        log(`no create-account form on screen and a credential exists for ${existing.email}; signing in instead`);
        return false;
      }
    } catch { /* nothing recorded - create */ }
  }

  if (!args.email) { log("account creation required but no --email supplied; stopping"); return false; }

  // Reuse a stored password. Generating a fresh one on each attempt silently created the account with a different
  // password than the one on file, so the later sign-in could never match.
  let password = args.accountPassword || "";
  if (!password) {
    try {
      const { readFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const accountPath = path.join(path.dirname(path.resolve(args.payload)), `${path.basename(args.payload).replace(/\.json$/, "")}_account.json`);
      const existing = JSON.parse(await readFile(accountPath, "utf8"));
      if (existing && existing.password) {
        password = existing.password;
        log("reusing the stored password from a previous attempt");
      }
    } catch { /* none stored */ }
  }
  if (!password) password = `Wdy!${Math.random().toString(36).slice(2, 10)}${Math.floor(Math.random() * 90 + 10)}`;
  log(`creating a Workday account for ${args.email} (password will be saved)`);

  // REAL KEYSTROKES, not programmatic values: Workday's model ignores the native value setter (the lesson this
  // project learned on its own tenant), which is why an earlier run filled the DOM and still saw the same screen.
  const targets = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll("input")];
    const emailEl = inputs.find((i) => /email/i.test(i.name || "") || /email/i.test(i.id || "") || i.type === "text");
    const pws = inputs.filter((i) => i.type === "password");
    const mark = (el, tag) => { if (el) el.setAttribute("data-runner-target", tag); };
    mark(emailEl, "acct-email");
    mark(pws[0], "acct-pw1");
    mark(pws[1], "acct-pw2");
    return { email: Boolean(emailEl), pw: pws.length };
  });
  const filled = [];
  const typeInto = async (tag, value) => {
    const ok = await page.evaluate((t) => {
      const el = document.querySelector(`[data-runner-target="${t}"]`);
      if (!el) return false;
      el.scrollIntoView({ block: "nearest" });
      el.focus();
      el.select && el.select();
      return true;
    }, tag);
    if (!ok) return false;
    await page.keyboard.press("Meta+a").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(String(value), { delay: 35 });
    filled.push(tag);
    return true;
  };
  if (targets.email) await typeInto("acct-email", args.email);
  await typeInto("acct-pw1", password);
  await typeInto("acct-pw2", password);
  await sleep(1200);

  // acknowledge the privacy notice - page-context label clicks are unreliable, so escalate and read back
  const privacy = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
    const target = boxes.find((c) => {
      let n = c, txt = "";
      for (let k = 0; k < 6 && n; k++) { n = n.parentElement; const s = (n && n.innerText || "").replace(/\s+/g, " ").trim(); if (s.length > 15) { txt = s; break; } }
      return /privacy|acknowledge|understand|agree/i.test(txt);
    }) || boxes[0];
    if (!target) return { ok: false, why: "no checkbox" };
    target.setAttribute("data-runner-target", "privacy");
    if (!target.checked) (target.closest("label") || target.parentElement).click();
    return { ok: target.checked, checked: target.checked };
  });
  if (privacy.ok !== true && privacy.why !== "no checkbox") {
    await page.evaluate(() => { const b = document.querySelector('[data-runner-target="privacy"]'); if (b && !b.checked) b.click(); });
    await sleep(500);
    const geo = await page.evaluate(() => {
      const b = document.querySelector('[data-runner-target="privacy"]');
      if (!b) return null;
      b.scrollIntoView({ block: "nearest" });
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + Math.min(r.width, 20) / 2), y: Math.round(r.y + r.height / 2), checked: b.checked };
    });
    if (geo && !geo.checked) await page.mouse.click(geo.x, geo.y).catch(() => {});
    await sleep(600);
  }
  const privacyNow = await page.evaluate(() => {
    const b = document.querySelector('[data-runner-target="privacy"]');
    return b ? b.checked : "?";
  });
  log("account fields:", JSON.stringify(filled), "| privacy acknowledged:", privacyNow);

  await dismissConsent();
  // a page-context click is often dropped by Workday; press the button with a real mouse event instead
  const geo = await page.evaluate(() => {
    for (const re of [/^create account$/i, /^sign up$/i, /^register$/i, /^continue$/i, /^next$/i, /^submit$/i]) {
      const b = [...document.querySelectorAll("button")].find((x) => re.test((x.innerText || "").trim()));
      if (b) {
        b.scrollIntoView({ block: "nearest" });
        const r = b.getBoundingClientRect();
        return { label: b.innerText.trim(), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
    }
    return null;
  });
  const pressed = await pressVerified(findButton("^(create account|sign up|register)$"), "account submit");
  log("account submit:", JSON.stringify(pressed).slice(0, 240));
  await sleep(9000);

  try {
    const { writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const accountPath = path.join(path.dirname(path.resolve(args.payload)), `${path.basename(args.payload).replace(/\.json$/, "")}_account.json`);
    await writeFile(accountPath, JSON.stringify({ email: args.email, password, created_at: new Date().toISOString(), note: "Workday account created for this application; change the password after signing in." }, null, 1) + "\n");
    log("credential saved to", accountPath);
  } catch (e) {
    log("could not save the credential:", String(e).slice(0, 120));
  }
  const after = await state();
  log(`after account creation: step ${after.step} errors=${JSON.stringify(after.errors).slice(0, 200)}`);
  return true;
}


/**
 * Attach the resume if the current step has a file input and nothing is attached yet.
 *
 * Called on EVERY step, because Workday asks for the file on different steps per tenant (step 1 for Trimble, step 3
 * here). It only ever calls setInputFiles - never a click on an upload control - so no native file dialog appears;
 * the page-level filechooser listener is a second guard in case a tenant's flow raises one anyway.
 */
async function attachResumeIfNeeded() {
  if (!payload.resume_path) return false;
  const state = await page.evaluate(() => {
    const inp = document.querySelector('input[type="file"]');
    if (!inp) return { has: false, attached: false };
    const attached = Boolean(inp.files && inp.files.length);
    const wrap = inp.closest('[data-automation-id^="formField-"]') || inp.parentElement;
    return { has: true, attached, label: wrap ? (wrap.innerText || "").replace(/\s+/g, " ").slice(0, 60) : "" };
  });
  if (!state.has) return false;
  if (state.attached) { log("resume already attached on this step"); return true; }
  const input = page.locator('input[type="file"]').first();
  try {
    await input.setInputFiles(payload.resume_path);
    await sleep(4000);
    const name = await page.evaluate(() => {
      const i = document.querySelector('input[type="file"]');
      return i && i.files && i.files[0] ? i.files[0].name : "(none listed)";
    });
    log("attached resume via setInputFiles:", name);
    return true;
  } catch (e) {
    log("attach failed:", String(e).slice(0, 140));
    return false;
  }
}


/** Click a step-navigation item (a real mouse press) and let the wizard load that step. */
async function gotoStep(regexSource) {
  await dismissConsent();
  const pressed = await pressVerified(
    `(() => {
       const re = new RegExp(${JSON.stringify(regexSource)}, "i");
       const visible = (e) => {
         const r = e.getBoundingClientRect();
         const s = window.getComputedStyle(e);
         return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden";
       };
       // TIGHTEST match, not first match: containers (the wrapper div and the <ol>) also contain the step text, and
       // pressing one does nothing. Fewest descendants wins, then smallest area.
       const cands = [...document.querySelectorAll("a, button, [role=button], li")]
         .filter(visible)
         .filter((e) => re.test((e.innerText || "").trim()));
       cands.sort((a, b) => (a.querySelectorAll("*").length - b.querySelectorAll("*").length)
                          || (a.getBoundingClientRect().width * a.getBoundingClientRect().height)
                           - (b.getBoundingClientRect().width * b.getBoundingClientRect().height));
       const el = cands[0];
       if (!el) return null;
       el.scrollIntoView({ block: "nearest" });
       const r = el.getBoundingClientRect();
       el.setAttribute("data-runner-press", "1");
       return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: (el.innerText || "").trim().slice(0, 40), sel: '[data-runner-press="1"]' };
     })()`,
    `goto ${regexSource}`,
  );
  log("goto:", JSON.stringify(pressed).slice(0, 200));
  await sleep(4000);
  return pressed.ok;
}

/** step 1: upload the tailored PDF and advance so Workday parses it */
async function doAutofillStep() {
  const onStep1 = await page.evaluate(() => /autofillWithResume/i.test(location.href));
  if (!onStep1) {
    // reach it: the posting offers Apply -> Autofill with Resume
    await page.evaluate(() => {
      const apply = [...document.querySelectorAll("a,button")].find((e) => /^apply$/i.test((e.innerText || "").trim()));
      if (apply) apply.click();
    });
    await sleep(7000);
    // SIGNED IN? REUSE THE LAST APPLICATION (added 2026-10-07). "Autofill with Resume" is the right entry when
    // there is no account; once THIS tenant has an account with a previous application, "Use My Last Application"
    // brings the whole form back - including the education rows that twenty rounds went into filling - and it is the
    // path the page offers first when it is available. Ask for it, fall back to Autofill when it is not there.
    const reused = await page.evaluate(() => {
      const opt = [...document.querySelectorAll("a,button")].find((e) => /use my last application/i.test((e.innerText || "").trim()));
      if (!opt) return false;
      opt.click();
      return true;
    }).catch(() => false);
    if (reused) {
      log("reusing the last application for this account");
      await sleep(9000);
    } else {
      await page.evaluate(() => {
        const opt = [...document.querySelectorAll("a,button")].find((e) => /autofill with resume/i.test((e.innerText || "").trim()));
        if (opt) opt.click();
      });
      await sleep(8000);
    }
  }
  // NEVER click the upload control. A real click raises the operating system's file chooser; setInputFiles writes
  // the file straight onto the input and opens nothing, which is how the settled drivers have always behaved.
  // A filechooser listener is installed on the page as a belt-and-braces guard: even if some flow triggers a
  // chooser, Playwright answers it with the file instead of letting a dialog reach the desktop.
  if (payload.resume_path) {
    const input = page.locator('input[type="file"]').first();
    if (await input.count()) {
      await input.setInputFiles(payload.resume_path).catch((e) => log("upload failed:", String(e).slice(0, 120)));
      const name = await page.evaluate(() => {
        const i = document.querySelector('input[type="file"]');
        return i && i.files && i.files[0] ? i.files[0].name : "(none listed)";
      });
      log("uploaded via setInputFiles:", name);
    } else {
      log("no file input on step 1 (nothing was clicked, so no file dialog was raised)");
    }
  }
  await sleep(2500);
  log("advancing from step 1:", (await advance()) ? "ok" : "no Next/Continue button");
}

/** step 3: hand off to the settled helper */
async function doExperienceStep() {
  try {
    const helper = await import("./workday_experience_helper.mjs");
    const tab = { playwright: page };
    if (typeof page.domSnapshot !== "function") {
      const { makeWorkdayTab } = await import("./workday_playwright_adapter.mjs");
      const wrapped = makeWorkdayTab(page);
      await helper.fillMyExperiencePage(wrapped, payload);
    } else {
      await helper.fillMyExperiencePage(tab, payload);
    }
    log("experience step: helper completed");
  } catch (e) {
    // 200 characters cut the locator CHAIN off mid-name, which is the one part that says WHERE it failed: the
    // education rows failed for three rounds on "getByRole('group', { name: /^(?:Educ" and nothing else. Print the
    // whole message, and the first stack line, so the failing call is named rather than inferred.
    log("experience helper problem:", String(e).slice(0, 1500));
    if (e && e.stack) log("  at", String(e.stack).split("\n")[1]?.trim().slice(0, 200));
    log("  - continuing; rows will be verified on Review");
  }
}

/** apply the answer plan for the given step */
async function applyPlan(stepNo) {
  const p = plan[String(stepNo)];
  if (!p) return [];
  const results = [];
  for (const [name, value] of Object.entries(p.texts || {})) results.push({ kind: "text", ...(await setText(name, value)) });
  for (const s of p.selects || []) results.push({ kind: "select", ...(await chooseSelect(s.q, s.option, s.index || 0)) });
  for (const r of p.radios || []) results.push({ kind: "radio", ...(await chooseRadio(r.q, r.option)) });
  for (const m of p.multiSelects || []) results.push({ kind: "multiselect", ...(await chooseMultiSelect(m.q, m.option, m.index || 0)) });
  for (const [q, v] of Object.entries(p.textsByLabel || {})) results.push({ kind: "textByLabel", ...(await setTextByLabel(q, v)) });
  for (const one of p.checkOne || []) results.push({ kind: "checkOne", ...(await checkOneOption(one.q, one.option)) });
  for (const c of p.checks || []) results.push({ kind: "check", ...(await tickCheckbox(c)) });

  for (const l of p.links || []) {
    const clicked = await page.evaluate((re) => {
      const rx = new RegExp(re, "i");
      // Real anchors first: the validation message repeats the agreement's name inside a button that comes earlier in
      // document order, and clicking that never registers the review.
      const anchors = [...document.querySelectorAll("a[href]")].filter((e) => rx.test((e.innerText || "").trim()));
      const el = anchors[0] || [...document.querySelectorAll("button, [role=link], [role=button]")]
        .filter((e) => rx.test((e.innerText || "").trim()))
        .filter((e) => !/^error/i.test((e.innerText || "").trim()))[0];
      if (!el) return null;
      el.scrollIntoView({ block: "nearest" });
      // NEVER let the anchor navigate: a plain el.click() on an href opened the PDF in a new tab and raised the browser.
      // preventDefault stops only the default navigation; the page's own click handler still runs and marks it reviewed.
      el.addEventListener("click", (ev) => ev.preventDefault(), { once: true });
      el.click();
      return (el.innerText || "").trim().slice(0, 50);
    }, l.q).catch(() => null);
    results.push({ kind: "link", q: l.q, ok: !!clicked, clicked });
  }
  return results;
}

// ---------------------------------------------------------------- main loop
let s = await state();
let sticky = null; // {step, sig} - detects a step that refuses to advance with the same errors twice running
log(`starting at step ${s.step}/${s.total} (${page.url().slice(-40)})`);

if (args.dump) { await dumpCurrentPage(); process.exit(0); }
if (args.goto) { await gotoStep(args.goto); s = await state(); log(`now at step ${s.step}`); }

// --back N: press the wizard's Back button N times. Workday's step-navigation items carry text like "completed step 3 of
// 7\nMy Experience", so --goto cannot reliably reach them; Back carries a stable label.
for (let b = 0; b < (args.back || 0); b++) {
  const before = page.url();
  const pressed = await pressVerified(
    `(() => {
       const visible = (e) => { const r = e.getBoundingClientRect(); const st = window.getComputedStyle(e);
         return r.width > 2 && r.height > 2 && st.display !== "none" && st.visibility !== "hidden"; };
       const el = [...document.querySelectorAll("button, a, [role=button]")].filter(visible)
         .find((e) => /^\s*back\s*$/i.test((e.innerText || "").trim()));
       if (!el) return null;
       el.scrollIntoView({ block: "nearest" });
       const r = el.getBoundingClientRect();
       el.setAttribute("data-runner-press", "1");
       return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: "Back" };
     })()`,
    `back ${b + 1}`,
  );
  await sleep(3000);
  log(`back ${b + 1}:`, JSON.stringify(pressed).slice(0, 120), before === page.url() ? "(url unchanged)" : "(moved)");
}
s = await state();
log(`now at step ${s.step}/${s.total}`);

await openEmailSignInIfOffered();
await pressCreateAccountIfSignInOnly();
const accounted = await createAccountIfRequired();
if (accounted) s = await state();
const activated = await activateAccountIfRequired();
if (activated) s = await state();
const redirected = await followPostActivationRedirect();
if (redirected) s = await state();
const reset = await resetPasswordIfRequested();
if (reset) s = await state();
const signedIn = await signInIfRequired();
if (signedIn) s = await state();

if (args.discover) {
  if (!accounted && !signedIn && !activated && !reset && s.step <= 1) await doAutofillStep();
  for (let i = 0; i < args.maxSteps; i++) {
    const st = await state();
    if (!st.step) break;
    await discoverStep();
    if (st.step >= st.total) break;
    if (!(await advance())) break;
    const after = await state();
    if (after.step === st.step) { console.log('  (step did not advance; stopping discovery)'); break; }
  }
  process.exit(0);
}

if (!accounted && !signedIn && s.step <= 1) await doAutofillStep();

for (let i = 0; i < args.maxSteps; i++) {
  s = await state();
  if (!s.step) { log("could not read the step bar; stopping"); break; }
  if (s.step >= s.total) {
    log(`reached the final step (${s.step}); errors=${JSON.stringify(s.errors)}`);
    break;
  }
  log(`step ${s.step}: ${s.errors.length ? "errors=" + JSON.stringify(s.errors) : "clean"}`);

  await attachResumeIfNeeded();

  // step 3 uses the settled experience helper AND may still need plan entries (e.g. the Degree dropdown on each
  // education block, which the resume parse leaves empty)
  // The experience step is NOT always number 3 (Commerce uploads at 3 and asks for experience later), so decide from
  // the page: fill whenever the wizard shows the work-experience section or its section heading.
  const showsExperience = await page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, " ");
    return /Work Experience|jobTitle|Role Description/i.test(t);
  });
  if (s.step === 3 || showsExperience) await doExperienceStep();
  const applied = await applyPlan(s.step);
  if (applied.length) log(`step ${s.step} plan:`, JSON.stringify(applied).slice(0, 2400));
  else if (s.step !== 1 && s.step !== 3) log(`step ${s.step}: no plan entries (set them in --answers)`);

  const moved = await advance();
  const after = await state();
  if (!moved) { log("no forward control found; stopping"); break; }
  if (after.step === s.step) {
    const sig = JSON.stringify(after.errors);
    if (sticky && sticky.step === after.step && sticky.sig === sig) {
      log(`step ${after.step} refused twice with the same errors; stopping so the plan can be extended`);
      log("  errors:", sig);
      break;
    }
    sticky = { step: after.step, sig };
    log(`step ${s.step} did not advance; errors=`, JSON.stringify(after.errors));
    if (!after.errors.length) break;
  } else {
    sticky = null;
  }
}

s = await state();
log(`final: step ${s.step}/${s.total} errors=${JSON.stringify(s.errors)}`);

if (args.submit && s.step >= s.total) {
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /^submit$/i.test((b.innerText || "").trim()));
    if (btn) { btn.scrollIntoView({ block: "nearest" }); btn.click(); return true; }
    return false;
  });
  await sleep(12000);
  const done = await page.evaluate(() => ({
    url: location.href,
    submitted: /jobTasks\/completed|\/completed\/application/i.test(location.href) || /thank you|received your application|application has been submitted/i.test(document.body.innerText),
  }));
  log("submit clicked:", clicked, "| confirmed:", JSON.stringify(done).slice(0, 240));
  recordLedger(SUBMIT, {
    slug: args.payload ? String(args.payload).split("/").pop().replace(/\.json$/, "") : undefined,
    url: done.url, platform: "workday",
    outcome: done.submitted ? "confirmed" : (clicked ? "not_confirmed" : "no_submit_button"),
    detail: { clicked, final_step: s.step, errors: s.errors?.slice?.(0, 5) ?? s.errors },
  });
}
process.exit(0);
