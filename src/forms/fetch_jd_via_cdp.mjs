#!/usr/bin/env node
/**
 * fetch_jd_via_cdp.mjs — extract a posting's job description through the project browser.
 *
 * WHY: some tenants answer 403 to their JSON API and serve a JavaScript shell to curl, so neither transport can
 * read the posting. The project already has a browser attached at 9223, and the rendered page always contains the
 * description - so this opens the URL in a BACKGROUND tab, extracts the text plus the facts the pre-filter needs
 * (location, and the authorisation/sponsorship sentences), prints them, and closes the tab.
 *
 * FOCUS RULE (cdp-browser skill, hard rule #3): tabs are opened in the BACKGROUND only. This script creates each
 * target with a browser-level CDP session and Target.createTarget({ background: true }) - never ctx.newPage(),
 * which activates the tab and takes the user's focus.
 *
 * USAGE
 *   node tmp/fetch_jd_via_cdp.mjs <url> [<url> ...] [--keep] [--out <file>]
 *
 * Output per URL: title, location, length, the first ~600 characters, and every sentence mentioning sponsor /
 * visa / citizen / clearance / authorization / years-of-experience. Everything is data; nothing is executed from
 * the page.
 */
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const outIdx = args.indexOf("--out");
const outFile = outIdx >= 0 ? args[outIdx + 1] : "";
const urls = args.filter((a, i) => !a.startsWith("--") && i !== outIdx + 1);
if (!urls.length) {
  console.error("usage: fetch_jd_via_cdp.mjs <url> [...] [--keep]");
  process.exit(2);
}

const CDP = "http://127.0.0.1:9223";
const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];

const AUTH = /sponsor|visa|citizen|clearance|itar|authoriz|eligible to work|work permit|years? of experience|\b\d+\+? years\b/i;

/** Open a BACKGROUND tab and return its Playwright page (never ctx.newPage, which steals focus). */
async function openBackgroundPage(url) {
  const session = await browser.newBrowserCDPSession();
  const { targetId } = await session.send("Target.createTarget", { url: "about:blank", background: true });
  await session.detach().catch(() => {});
  // the new target shows up as a page; match it by following the navigation we are about to perform
  for (let i = 0; i < 40; i++) {
    const pages = ctx.pages();
    const fresh = pages.filter((p) => p.url() === "about:blank" || p.url() === "");
    if (fresh.length) {
      const page = fresh[fresh.length - 1];
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return { page, targetId };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("background target did not appear as a page");
}

for (const url of urls) {
  let page = null;
  let targetId = "";
  try {
    const opened = await openBackgroundPage(url);
    page = opened.page;
    targetId = opened.targetId;
    await page.waitForTimeout(2000);
    await page.waitForTimeout(6000);
    // give client-rendered shells a chance to mount
    for (let i = 0; i < 3; i++) {
      const n = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim().length);
      if (n > 800) break;
      await page.waitForTimeout(4000);
    }
    const data = await page.evaluate(() => {
      // prefer the rendered job-description container; fall back to the whole body
      const descEl = document.querySelector('[data-automation-id="jobPostingDescription"]')
        || document.querySelector('[data-automation-id="jobDescription"]')
        || document.querySelector('main');
      const text = ((descEl && descEl.innerText) || document.body.innerText).replace(/\s+/g, " ").trim();
      const h1 = document.querySelector("h1, [data-automation-id='jobPostingHeader']");
      const loc = document.querySelector("[data-automation-id='locations'], [data-automation-id='location']");
      const meta = document.querySelector('meta[property="og:title"]');
      return {
        url: location.href,
        title: (h1 && h1.innerText.trim()) || (meta && meta.content) || document.title || "?",
        location: loc ? loc.innerText.replace(/\s+/g, " ").trim().slice(0, 80) : "",
        text,
      };
    });
    const sentences = data.text.split(/(?<=[.!?])\s+/);
    const auth = [...new Set(sentences.filter((s) => AUTH.test(s) && s.length < 400))].slice(0, 8);
    console.log(`\n=== ${data.title}`);
    console.log(`    url      : ${data.url}`);
    if (data.location) console.log(`    location : ${data.location}`);
    console.log(`    length   : ${data.text.length} chars`);
    console.log(`    head     : ${data.text.slice(0, 600)}`);
    if (outFile) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outFile, `# ${data.title}\n${data.url}\n\n${data.text}\n`, "utf8");
      console.log(`    saved to : ${outFile}`);
    }
    if (auth.length) {
      console.log("    facts:");
      auth.forEach((s) => console.log("      - " + s.trim().slice(0, 260)));
    }
  } catch (e) {
    console.log(`\n=== FAILED ${url}\n    ${String(e).slice(0, 160)}`);
  } finally {
    if (!keep && targetId) {
      const s = await browser.newBrowserCDPSession().catch(() => null);
      if (s) {
        await s.send("Target.closeTarget", { targetId }).catch(() => {});
        await s.detach().catch(() => {});
      }
    } else if (!keep && page) {
      await page.close().catch(() => {});
    }
  }
}
process.exit(0);
