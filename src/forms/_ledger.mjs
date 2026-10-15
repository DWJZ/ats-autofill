/**
 * _ledger.mjs — the Node side of the application ledger.
 *
 * Same file, same schema and same rules as `src/metrics/ledger.py`; the two exist because the form
 * drivers are Node and the pipeline is Python, and a subprocess hop per event would be worse than
 * thirty duplicated lines. If the schema changes, change both — `src/metrics/test_ledger.py` pins the
 * shape, and `src/metrics/ledger_report.py` reads what either one writes.
 *
 * It MUST NOT break a submission: `recordLedger` swallows every error and returns null on failure.
 * A telemetry bug that fails a submit is worse than no telemetry.
 *
 * Usage:  import { recordLedger, SUBMIT } from "./_ledger.mjs";
 *         recordLedger(SUBMIT, { slug, url, outcome: "refused", detail: { reason } });
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LEDGER = join(ROOT, "output", "metrics", "ledger.jsonl");

// Keep these in step with ledger.py.
// PREFLIGHT is historical: the `preflight` subcommand was removed on 2026-10-06, so nothing should emit this
// event. The name stays because older ledgers hold its lines and a test pins these two vocabularies together.
export const PREFLIGHT = "preflight";
export const PREPARE = "prepare";
export const SUBMIT = "submit";
export const CLOSED = "closed";
export const HANDOVER = "handover";
export const BLOCKED = "blocked";

// Why a handover happened; keep in step with ledger.py, which is where the vocabulary is declared. The
// CLI's `--class` choices come from that tuple, so a class added here alone is not recordable.
export const HANDOVER_CLASSES = [
  "captcha",            // an image challenge the drivers cannot solve
  "login",              // a password, 2FA or expired third-party session the saved profile cannot satisfy
  "email_code",         // a code sent to a mailbox that cannot be read
  "user_content",       // only the user can author it: an anecdote, a video, a signature
  "no_truthful_option", // a required control whose honest answer the form will not accept
  "tooling_gap",        // a control the settled tools cannot drive
  "platform_blocked",   // the tenant itself refuses: an impossible error, a spam flag
  "duplicate",          // already applied to this requisition
  "other",
];

/**
 * Append one event. Returns the line written, or null if anything at all went wrong.
 * @param {string} event - one of the exported event names.
 * @param {object} fields - slug, url, company, platform, outcome, detail, ...
 */
export function recordLedger(event, fields = {}, ledger = LEDGER) {
  try {
    const line = { at: Date.now(), event, ...stripUndefined(fields) };
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(ledger, JSON.stringify(line) + "\n", "utf8");
    return line;
  } catch {
    return null;
  }
}

function stripUndefined(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}
