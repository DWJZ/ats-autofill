#!/usr/bin/env node
/**
 * cdp_tabs.mjs — open/close tabs in the CDP browser WITHOUT stealing the user's focus.
 *
 * Why: `PUT /json/new?<url>` activates the new tab and raises the Chrome window, which interrupts
 * whatever the user is doing. `Target.createTarget` with `background: true` opens the tab silently.
 *
 * Usage:
 *   node src/forms/cdp_tabs.mjs open  <url> [--foreground]   # prints the new target id
 *   node src/forms/cdp_tabs.mjs close <url-substring>        # closes every matching page
 *   node src/forms/cdp_tabs.mjs console <url> [--grep P] [--wait ms] [--keep]
 *                                                            # BACKGROup tab, read its console, close it.
 *                                                            # Use this instead of Playwright's
 *                                                            # context.newPage(), which ACTIVATES the tab
 *                                                            # and steals the user's focus (forbidden).
 *   node src/forms/cdp_tabs.mjs list
 *   node src/forms/cdp_tabs.mjs eval <url-substring> "<js expression>"
 *                                                            # read live page state without touching
 *                                                            # focus or navigating anything
 *   node src/forms/cdp_tabs.mjs prune-mail [--max-age 1800]  # closes only *fresh* mailbox tabs that
 *                                                            # a killed helper left behind (never the
 *                                                            # user's own, which is hours old)
 */
import { chromium } from "playwright-core";

const [cmd, arg] = process.argv.slice(2);
const foreground = process.argv.includes("--foreground");
const cdpIndex = process.argv.indexOf("--cdp");
const cdp = cdpIndex >= 0 ? process.argv[cdpIndex + 1] : "http://127.0.0.1:9223";

const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0];

if (cmd === "list") {
  for (const p of context.pages()) console.log(p.url());
  process.exit(0);
}

if (cmd === "open") {
  if (!arg) { console.error("usage: open <url>"); process.exit(1); }
  const session = await browser.newBrowserCDPSession();
  const { targetId } = await session.send("Target.createTarget", {   // focus-ok: background: !foreground
    url: arg,
    background: !foreground,   // the whole point: do not activate the tab
  });
  await session.detach().catch(() => {});
  console.log(targetId);
  process.exit(0);
}

// `dedupe <url>` — absorb open_form.mjs (retired 2026-10-07). ONE way to start work on an application form:
// close every tab already pointing at this posting, then open exactly one, in the background.
//
// WHY IT IS NOT JUST `close` + `open`. Four times in one session (Benchling, Cohere, Factory, Firetiger) two tabs
// pointed at the same application url; the filler wrote to one while the readers read the other, so an audit
// reported a form full of blanks that was really a second, untouched tab, and two rounds went to diagnosing a form
// that was never broken. The remedy was a manual list-close-open dance. `open_form.mjs` made it one call and was
// used 64 times; its posting-key derivation and its "--keep" escape hatch are the parts worth keeping, so they are
// here rather than in a fourth tool.
if (cmd === "dedupe") {
  if (!arg) { console.error("usage: dedupe <url> [--keep] [--cdp <endpoint>]"); process.exit(1); }
  const keep = process.argv.includes("--keep");
  // The key that identifies a posting, per ATS. Falls back to the first two path segments, which is right for
  // Lever/SmartRecruiters/Phenom and stable enough for anything else.
  const postingKey = (u) => {
    const ashby = u.match(/jobs\.ashbyhq\.com\/[^/]+\/([0-9a-f-]{8,})/i);
    if (ashby) return ashby[1];
    const token = u.match(/[?&]token=(\d+)/);
    if (token) return `token=${token[1]}`;
    const gh = u.match(/\/(?:jobs|job_app)\/(\d{3,})/);
    if (gh) return gh[1];
    try { const p = new URL(u); return p.pathname.split("/").filter(Boolean).slice(0, 2).join("/"); }
    catch { return u; }
  };
  const session = await browser.newBrowserCDPSession();
  const { targetInfos } = await session.send("Target.getTargets");
  const key = postingKey(arg);
  const matching = targetInfos.filter((t) => t.type === "page" && (t.url.includes(key) || t.url === arg));
  if (!keep) {
    for (const t of matching) {
      await session.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    }
  }
  const { targetId } = await session.send("Target.createTarget", { url: arg, background: true });   // focus-ok: background: true
  await session.detach().catch(() => {});
  console.log(`${keep ? "kept" : "closed"} ${matching.length} matching tab(s); opened ${targetId}`);

  // WAIT FOR THE FORM TO ACTUALLY RENDER, which is half of what open_form.mjs did and the half that caught the
  // blank-tab failures. Two instances in one session (Graphite, then Forus): the tab existed and the filler printed
  // nothing, and only reopening the same url made it render. A plain `open` returns as soon as the tab exists, so
  // it cannot tell "ready" from "still blank".
  const flagValue = (flag, dflt) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
  };
  const expectControls = Number(flagValue("--expect-controls", "1"));
  const timeoutMs = Number(flagValue("--timeout-ms", "25000"));
  const ctx = context;
  let page = null;
  const attachDeadline = Date.now() + 15000;
  while (Date.now() < attachDeadline && !page) {
    page = (ctx.pages() || []).find((x) => (x.url() || "").includes(key)) || null;
    if (!page) await new Promise((r) => setTimeout(r, 600));
  }
  if (!page) { console.log("no tab appeared for this posting"); process.exit(3); }
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    count = await page.evaluate(() => document.querySelectorAll("input,textarea,select").length).catch(() => 0);
    if (count >= expectControls) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  const ready = count >= expectControls;
  console.log(`${ready ? "ready" : "NOT READY"}: ${count} control(s), wanted ${expectControls}`);
  process.exit(ready ? 0 : 3);
}

// `dedupe-tabs <frag>` — absorb dedupe_tabs.mjs (retired 2026-10-08). Reports what is actually inside every tab
// matching a posting and closes the blank ones; NOT the same operation as `dedupe` above, which clears the field
// and opens one tab. This one looks before it closes.
//
// WHY IT EXISTS. Two identical Benchling application tabs were open at once: apply_form_spec filled one while the
// readers read the other, so an audit reported a form full of blanks that was really a second, untouched tab, and
// the screenshot showed the truth in one look. Rather than guess which tab is which, inspect each one's name field.
// Used 15 times, so it is ported here rather than dropped.
if (cmd === "dedupe-tabs") {
  if (!arg) { console.error("usage: dedupe-tabs <url-substring> [--close-blank] [--keep-most-essays]"); process.exit(2); }
  const closeBlank = process.argv.includes("--close-blank");
  const pages = (context.pages() || []).filter((p) => (p.url() || "").includes(arg));
  console.log(`${pages.length} tab(s) matching ${JSON.stringify(arg)}`);
  const report = [];
  for (const p of pages) {
    const info = await p.evaluate(() => {
      const name = document.getElementById("_systemfield_name");
      const email = document.getElementById("_systemfield_email");
      const files = [...document.querySelectorAll('input[type="file"]')].map((f) => f.files && f.files.length).filter(Boolean).length;
      const essays = [...document.querySelectorAll("textarea")].map((t) => (t.value || "").length).filter((n) => n > 0);
      const text = (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 90);
      return {
        name: name ? name.value : "(no name field)",
        email: email ? email.value : "(no email field)",
        attached: files,
        essayChars: essays,
        text,
      };
    }).catch(() => ({ name: "(unevaluable)", email: "", attached: 0, essayChars: [], text: "" }));
    report.push({ page: p, ...info });
    console.log(`   name=${JSON.stringify(info.name.slice(0, 30))} email=${JSON.stringify(info.email.slice(0, 30))} files=${info.attached} essays=${JSON.stringify(info.essayChars)}`);
  }
  const filled = report.filter((r) => r.name && !/^\(/.test(r.name) && r.name.trim());
  const blank = report.filter((r) => !(r.name && r.name.trim()));

  // --keep-most-essays: keep the tab holding the most essay text and close the rest. Two tabs with identical urls
  // cannot be told apart by url, and "the blank one" may be the one holding the required essays.
  if (process.argv.includes("--keep-most-essays")) {
    const scored = report.map((r) => ({ r, chars: (r.essayChars || []).reduce((a, b) => a + b, 0) }));
    scored.sort((a, b) => b.chars - a.chars);
    const top = scored[0];
    console.log(`\nkeeping the tab with ${top.chars} essay chars; closing ${scored.length - 1} other(s)`);
    for (const s of scored.slice(1)) { await s.r.page.close().catch(() => {}); console.log("   closed a tab with", s.chars, "essay chars"); }
    process.exit(0);
  }
  if (blank.length && filled.length) {
    console.log(`\nKEEPING ${filled.length} filled tab(s); ${blank.length} blank tab(s) ${closeBlank ? "will be closed" : "COULD be closed with --close-blank"}`);
    if (closeBlank) {
      for (const r of blank) { await r.page.close().catch(() => {}); console.log("   closed a blank tab"); }
    }
  } else if (blank.length && !filled.length) {
    console.log("\nALL tabs look blank - nothing to dedupe against.");
  } else if (filled.length > 1) {
    console.log(`\n${filled.length} FILLED tabs - close the stale one by hand before submitting, or state will diverge.`);
  } else {
    console.log("\nsingle meaningful tab.");
  }
  process.exit(0);
}

if (cmd === "close") {
  if (!arg) { console.error("usage: close <url-substring>"); process.exit(1); }
  const session = await browser.newBrowserCDPSession();
  const { targetInfos } = await session.send("Target.getTargets");
  let closed = 0;
  for (const t of targetInfos) {
    if (t.type !== "page" || !t.url.includes(arg)) continue;
    await session.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    closed += 1;
  }
  await session.detach().catch(() => {});
  console.log(`closed ${closed}`);
  process.exit(0);
}

if (cmd === "reload") {
  // Reload a tab in place. Workday's wizard can land on "Something went wrong. Please refresh the page and then try
  // again." with no action buttons rendered at all; closing the tab would lose the wizard and opening a new tab is not a
  // reload, so this exists to recover that state without touching the user's focus.
  const frag = arg || "";
  if (!frag) { console.log("usage: cdp_tabs.mjs reload <url-substring> [--wait <ms>]"); process.exit(2); }
  const p = context.pages().find((x) => (x.url() || "").includes(frag));
  if (!p) { console.log("no tab matching", frag); process.exit(2); }
  const waitArg = process.argv.indexOf("--wait");
  const wait = waitArg > 0 ? Number(process.argv[waitArg + 1]) || 8000 : 8000;
  await p.reload({ waitUntil: "domcontentloaded" }).catch((e) => console.log("reload error:", String(e).slice(0, 120)));
  await p.waitForTimeout(wait);
  const after = await p.evaluate(() => ({
    url: location.href,
    title: document.title,
    step: (document.body.innerText.match(/current step \d of \d/) || [""])[0],
    problem: /something went wrong|please refresh/i.test(document.body.innerText || ""),
  }));
  console.log(JSON.stringify(after, null, 1));
  process.exit(0);
}

if (cmd === "text") {
  // Read a tab's rendered text, its title, its visible buttons and its control count. Never touches focus.
  const frag = arg || "";
  const max = Number((process.argv[3] && /^\d+$/.test(process.argv[3])) ? process.argv[3] : 4000);
  if (!frag) { console.log("usage: cdp_tabs.mjs text <url-substring> [maxChars]"); process.exit(2); }
  const p = context.pages().find((x) => (x.url() || "").includes(frag));
  if (!p) { console.log("no tab matching", frag); process.exit(2); }
  const out = await p.evaluate((n) => ({
    url: location.href,
    title: document.title,
    text: (document.body.innerText || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, n),
    buttons: [...document.querySelectorAll("a,button,input[type=submit]")]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.innerText || e.value || "").replace(/\s+/g, " ").trim())
      .filter((t) => t && t.length < 44)
      .slice(0, 20),
    forms: document.querySelectorAll("form").length,
    controls: document.querySelectorAll("input,textarea,select").length,
    links: [...document.querySelectorAll("a[href]")]
      .filter((e) => e.offsetParent !== null && /pid=|\/job\//.test(e.getAttribute("href") || ""))
      .map((e) => ({ text: (e.innerText || "").replace(/\s+/g, " ").trim(), href: e.href }))
      .filter((l, i, arr) => l.text && arr.findIndex((x) => x.href === l.href) === i)
      .slice(0, 30),
  }), max);
  console.log("URL:", out.url);
  console.log("TITLE:", out.title);
  console.log("forms:", out.forms, "| controls:", out.controls);
  console.log("BUTTONS:", JSON.stringify(out.buttons));
  if (out.links.length) {
    console.log("LINKS:");
    for (const l of out.links) console.log("  ", l.text.slice(0, 66), "->", l.href.slice(0, 120));
  }
  console.log("--- TEXT ---");
  console.log(out.text);
  process.exit(0);
}

if (cmd === "eval") {
  // Read the live state of a page without touching focus, navigation or any control. Added because diagnosing the
  // remote-backed school picker needed exactly one fact - what the element holds WHILE a key is delivered - and no
  // tool could report it. Earlier hypotheses in that investigation were each disproved by measurement and recorded;
  // this closes the last one.
  const frag = arg || "";
  // argv is [node, script, eval, <fragment>, <expression>], so the expression is argv[4]; reading argv[3] fed the
  // fragment to the evaluator and produced "ReferenceError: affirm is not defined".
  const expr = process.argv[4] || "";
  if (!frag || !expr) { console.log("usage: cdp_tabs.mjs eval <url-substring> \"<js expression>\""); process.exit(2); }
  const p = context.pages().find((x) => (x.url() || "").includes(frag));
  if (!p) { console.log("no tab matching", frag); process.exit(2); }
  try {
    const value = await p.evaluate(expr);
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 1));
  } catch (e) {
    console.log("eval failed:", e.message);
    process.exit(1);
  }
  process.exit(0);
}

if (cmd === "prune-mail") {
  // A mailbox helper (tidy / verification-code reader) that is killed before its cleanup can leave
  // a background copy of the inbox behind. The user's own tab has been open for hours; an agent-made
  // copy is seconds old, and `performance.timeOrigin` tells them apart reliably. Only fresh tabs are
  // closed, so the user's session is never touched. `--max-age <seconds>` overrides the 30 min cutoff.
  const ageIndex = process.argv.indexOf("--max-age");
  const maxAgeMs = (ageIndex >= 0 ? Number(process.argv[ageIndex + 1]) : 1800) * 1000;
  let closed = 0;
  for (const p of context.pages()) {
    if (!/outlook\.|mail\.google\.com|mail\.microsoft/.test(p.url())) continue;
    const origin = await p.evaluate(() => Math.round(performance.timeOrigin)).catch(() => 0);
    const ageSeconds = Math.round((Date.now() - origin) / 1000);
    if (!origin || Date.now() - origin > maxAgeMs) {
      console.log(`kept   mailbox tab (${ageSeconds}s old)`);
      continue;
    }
    const session = await p.context().newCDPSession(p);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.send("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => {});
    await session.detach().catch(() => {});
    console.log(`closed mailbox tab (${ageSeconds}s old)`);
    closed += 1;
  }
  console.log(`closed ${closed}`);
  process.exit(0);
}

if (cmd === "console") {
  // Read a page's CONSOLE output without ever activating a tab. This exists because the obvious way to
  // do it - Playwright's `context.newPage()` - ACTIVATES the new tab and steals the user's focus, which
  // is a standing rule violation. `Target.createTarget { background: true }` opens it silently, and the
  // tab is closed again unless --keep is passed.
  //
  //   node src/forms/cdp_tabs.mjs console <url> [--grep <prefix>] [--wait 4000] [--keep]
  if (!arg) { console.error("usage: console <url> [--grep <prefix>] [--wait <ms>] [--keep]"); process.exit(1); }
  const grepIndex = process.argv.indexOf("--grep");
  const grep = grepIndex >= 0 ? process.argv[grepIndex + 1] : "";
  const waitIndex = process.argv.indexOf("--wait");
  const waitMs = waitIndex >= 0 ? Number(process.argv[waitIndex + 1]) : 4000;
  const keep = process.argv.includes("--keep");

  const session = await browser.newBrowserCDPSession();
  const { targetId } = await session.send("Target.createTarget", { url: arg, background: true });   // focus-ok: background: true
  await session.detach().catch(() => {});

  // wait for the Page object to appear, then attach the listener BEFORE the page can finish loading
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    page = context.pages().find((p) => p.url().includes(arg.replace(/^https?:\/\//, "").slice(0, 40)));
    if (!page) await new Promise((r) => setTimeout(r, 150));
  }
  if (!page) { console.error("tab did not appear"); process.exit(1); }

  const lines = [];
  page.on("console", (m) => {
    const text = m.text() || "";
    if (!grep || text.startsWith(grep)) lines.push(text);
  });
  await page.reload({ waitUntil: "networkidle" }).catch(() => {});
  await new Promise((r) => setTimeout(r, waitMs));

  for (const l of lines) console.log(l);
  console.log(`-- ${lines.length} console line(s)${grep ? ` matching ${JSON.stringify(grep)}` : ""}`);

  if (!keep) {
    const s2 = await browser.newBrowserCDPSession();
    await s2.send("Target.closeTarget", { targetId }).catch(() => {});
    await s2.detach().catch(() => {});
  }
  process.exit(0);
}

console.error("usage: cdp_tabs.mjs open <url> | close <url-substring> | reload <url-substring> | list | console <url> [--grep <prefix>] | prune-mail [--max-age 1800]");
process.exit(1);
