#!/usr/bin/env node
/**
 * Open ONE page target through raw CDP, for the case where Playwright cannot connect at all.
 *
 * Why this exists: with ZERO page targets, `chromium.connectOverCDP()` fails with
 * `Browser.setDownloadBehavior: Browser context management is not supported`, so cdp_tabs.mjs
 * cannot be used to restore a tab - a circular dependency. The documented alternative,
 * `PUT /json/new?<url>`, is forbidden because it ACTIVATES the tab and raises the Chrome window.
 *
 * This script talks to the browser-level WebSocket directly and calls `Target.createTarget`
 * with `background: true`, so the tab appears without stealing the user's focus. Once one page
 * target exists, the normal Playwright helpers (cdp_tabs.mjs and friends) work again.
 *
 * Usage: node src/forms/cdp_open_target.mjs [url] [--cdp http://127.0.0.1:9223]
 */
const argv = process.argv.slice(2);
let url = "about:blank";
let cdp = "http://127.0.0.1:9223";
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--cdp") { cdp = argv[i + 1]; i += 1; }
  else if (!argv[i].startsWith("--")) url = argv[i];
}

const versionRes = await fetch(`${cdp}/json/version`);
if (!versionRes.ok) {
  console.error(`cannot reach ${cdp}/json/version (HTTP ${versionRes.status}) - is the project CDP browser running?`);
  process.exit(1);
}
const { webSocketDebuggerUrl } = await versionRes.json();

const ws = new WebSocket(webSocketDebuggerUrl);
const send = (id, method, params) => ws.send(JSON.stringify({ id, method, params }));

const done = new Promise((resolve, reject) => {
  ws.addEventListener("open", () => {
    send(1, "Target.createTarget", { url, background: true });   // focus-ok: background: true
  });
  ws.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.id === 1) {
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  ws.addEventListener("error", (e) => reject(new Error(`websocket error: ${e.message || e.type}`)));
  setTimeout(() => reject(new Error("timeout waiting for Target.createTarget")), 15000);
});

try {
  const result = await done;
  const list = await (await fetch(`${cdp}/json/list`)).json();
  const pages = list.filter((t) => t.type === "page");
  console.log(`opened background target ${result.targetId} -> ${url}`);
  console.log(`page targets now: ${pages.length} (${pages.map((p) => p.url.slice(0, 40)).join(", ")})`);
  process.exit(0);
} catch (err) {
  console.error(`failed: ${err.message}`);
  process.exit(1);
} finally {
  try { ws.close(); } catch { /* ignore */ }
}
