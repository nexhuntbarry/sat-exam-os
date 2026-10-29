// .omc/devlog/lib.mjs — write entries to the /admin/reports dev log.
// Each entry is a `notifications` row with type "dev_log" (payload shapes in
// lib/devlog.ts). user_id is NOT NULL, so rows are owned by the super admin;
// read_at is set, and the bell APIs exclude the type.
//
// Safety switch: nothing is written until `.omc/devlog/enabled` exists. Create
// it (touch .omc/devlog/enabled) once the app build that filters dev_log out of
// the bell is live; before that the rows would show up in the super admin's bell.
import { existsSync } from "node:fs";
import { db } from "../qa/harness/lib.mjs";

export const DEVLOG_TYPE = "dev_log";
export { db };

export const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
export const enabled = () => existsSync(new URL("./enabled", import.meta.url).pathname);

function guard() {
  if (!enabled()) {
    throw new Error("dev log disabled: touch .omc/devlog/enabled once the build that hides dev_log from the bell is live");
  }
}

let ownerId;
async function owner() {
  if (ownerId) return ownerId;
  const { data, error } = await db.from("users").select("id")
    .eq("is_super_admin", true).not("email", "ilike", "qa-test-%")
    .order("created_at", { ascending: true }).limit(1);
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("no super admin user found");
  return (ownerId = data[0].id);
}

/** Insert one entry; returns its id. */
export async function writeEntry(payload) {
  guard();
  const { data, error } = await db.from("notifications")
    .insert({ user_id: await owner(), type: DEVLOG_TYPE, payload, read_at: new Date().toISOString() })
    .select("id").single();
  if (error) throw new Error(error.message);
  return data.id;
}

/** Merge fields into an existing entry's payload. */
export async function updateEntry(id, patch) {
  guard();
  const { data: row, error } = await db.from("notifications").select("payload")
    .eq("id", id).eq("type", DEVLOG_TYPE).single();
  if (error) throw new Error(error.message);
  const up = await db.from("notifications").update({ payload: { ...row.payload, ...patch } }).eq("id", id);
  if (up.error) throw new Error(up.error.message);
  return id;
}

/** The qa_run entry for a date, if any (one per night). */
export async function findQaRun(date) {
  const { data, error } = await db.from("notifications").select("id, payload")
    .eq("type", DEVLOG_TYPE).eq("payload->>kind", "qa_run").eq("payload->>date", date).limit(1);
  if (error) throw new Error(error.message);
  return data?.[0] ?? null;
}

/**
 * Write (or replace) the QA run for a date. Re-running the same night updates
 * the existing entry and keeps any "what was done" notes already recorded.
 */
export async function writeQaRun({ date, passed, total, failed = [], checks, report_url = null, notes = null }) {
  guard();
  const existing = await findQaRun(date);
  const prev = existing?.payload ?? {};
  const prevActions = Object.fromEntries((prev.failed ?? []).filter((f) => f.action).map((f) => [f.id, f.action]));
  const payload = {
    kind: "qa_run", date, passed, total,
    failed: failed.map((f) => ({ ...f, action: f.action ?? prevActions[f.id] })),
    ...(checks ? { checks } : prev.checks ? { checks: prev.checks } : {}),
    report_url: report_url ?? prev.report_url ?? null,
    notes: notes ?? prev.notes ?? null,
  };
  if (existing) {
    const up = await db.from("notifications").update({ payload }).eq("id", existing.id);
    if (up.error) throw new Error(up.error.message);
    return existing.id;
  }
  return writeEntry(payload);
}

/** qa_run fields from a nightly result file (.omc/qa/nightly/<date>.json). */
export function qaRunFromNightly(run) {
  const all = run.checks ?? [];
  const failed = all.filter((c) => c.result !== "PASS").map((c) => ({
    id: c.id, title: c.title_zh, result: c.result, details: String(c.details ?? "").slice(0, 300),
  }));
  const checks = all.map((c) => ({ id: c.id, title: c.title_zh, result: c.result }));
  return { date: run.date, passed: all.length - failed.length, total: all.length, failed, checks };
}

/** Classify a free-text source for the page's Source filter. */
export function sourceKind(source, ticket) {
  if (ticket) return "ticket";
  const s = String(source ?? "");
  if (/bug.?report/i.test(s)) return "bug_report";
  if (/barry/i.test(s)) return "barry";
  if (/ticket|report a problem/i.test(s)) return "ticket";
  if (/\bqa\b|finding|\b[A-Z]{1,8}-\d/i.test(s)) return "qa";
  return "other";
}
