#!/usr/bin/env node
// .omc/devlog/log.mjs — write an entry to the /admin/reports dev log. Prints the id.
//
//   node .omc/devlog/log.mjs change --type bug|feature|data|bank --source "<text>" [--ticket <support id>]
//        [--roles student,teacher,admin] [--verified "ID1,ID2" | --code-only] [--commit <sha>]
//        --title "..." --body "..." [--date YYYY-MM-DD]
//   node .omc/devlog/log.mjs bank --title "..." --body "..." [--rescored N] [--ticket <id>] [--date YYYY-MM-DD]
//   node .omc/devlog/log.mjs qa --date YYYY-MM-DD --passed N --total N [--failed-json '<json array>']
//        [--report-url <url>] [--notes "..."]
//        failed item: {"id":"BANK-IMG","title":"...","result":"FAIL","details":"...","action":"what was done"}
//   node .omc/devlog/log.mjs qa-action <YYYY-MM-DD> <check id> "<what was done>"
//   node .omc/devlog/log.mjs open --title "..." --body "..." [--waiting barry|admin] [--ticket <id>]
//   node .omc/devlog/log.mjs resolve <id>
//
// Dates default to today in New York. Writes are refused until .omc/devlog/enabled exists (see lib.mjs).
import { parseArgs } from "node:util";
import { findQaRun, nyToday, sourceKind, updateEntry, writeEntry, writeQaRun } from "./lib.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const { values: v, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    type: { type: "string" }, source: { type: "string" }, ticket: { type: "string" },
    roles: { type: "string" }, verified: { type: "string" }, "code-only": { type: "boolean" },
    commit: { type: "string" }, title: { type: "string" }, body: { type: "string" },
    date: { type: "string" }, rescored: { type: "string" }, passed: { type: "string" },
    total: { type: "string" }, "failed-json": { type: "string" }, "report-url": { type: "string" },
    notes: { type: "string" }, waiting: { type: "string" },
  },
});

function die(msg) {
  console.error(msg);
  process.exit(1);
}
const need = (...keys) => keys.forEach((k) => { if (!v[k]?.trim()) die(`--${k} is required`); });
const date = v.date ?? nyToday();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) die("--date must be YYYY-MM-DD");
const list = (s) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const int = (s, name) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) die(`--${name} must be a whole number`);
  return n;
};

let id;
switch (cmd) {
  case "change": {
    need("type", "source", "title");
    if (!["bug", "feature", "data", "bank"].includes(v.type)) die("--type must be bug|feature|data|bank");
    if (!v.verified && !v["code-only"]) die("pass --verified \"<check ids>\" or --code-only");
    const roles = list(v.roles);
    if (roles.some((r) => !["student", "teacher", "admin"].includes(r))) die("--roles: student,teacher,admin");
    id = await writeEntry({
      kind: "change", date, type: v.type, title: v.title.trim(), body: (v.body ?? "").trim(),
      source: v.source.trim(), source_kind: sourceKind(v.source, v.ticket), ticket_id: v.ticket ?? null,
      commit: v.commit ?? null, roles, verified: v["code-only"] ? [] : list(v.verified),
    });
    break;
  }
  case "bank":
    need("title");
    id = await writeEntry({
      kind: "bank_change", date, title: v.title.trim(), body: (v.body ?? "").trim(),
      rescored: v.rescored ? int(v.rescored, "rescored") : 0, ticket_id: v.ticket ?? null,
    });
    break;
  case "qa": {
    need("passed", "total");
    let failed = [];
    if (v["failed-json"]) {
      try { failed = JSON.parse(v["failed-json"]); } catch (e) { die(`--failed-json: ${e.message}`); }
      if (!Array.isArray(failed)) die("--failed-json must be a JSON array");
    }
    id = await writeQaRun({
      date, passed: int(v.passed, "passed"), total: int(v.total, "total"),
      failed: failed.map((f) => ({ result: "FAIL", ...f })), report_url: v["report-url"] ?? null, notes: v.notes ?? null,
    });
    break;
  }
  case "qa-action": {
    const [day, checkId, text] = positionals;
    if (!day || !checkId || !text?.trim()) die('usage: qa-action <YYYY-MM-DD> <check id> "<what was done>"');
    const run = await findQaRun(day);
    if (!run) die(`no QA run logged for ${day}`);
    if (!run.payload.failed.some((f) => f.id === checkId)) die(`${checkId} did not fail on ${day}`);
    id = await updateEntry(run.id, {
      failed: run.payload.failed.map((f) => (f.id === checkId ? { ...f, action: text.trim() } : f)),
    });
    break;
  }
  case "open":
    need("title");
    if (v.waiting && !["barry", "admin"].includes(v.waiting)) die("--waiting must be barry|admin");
    id = await writeEntry({
      kind: "open_item", date, title: v.title.trim(), body: (v.body ?? "").trim(),
      waiting: v.waiting ?? "barry", ticket_id: v.ticket ?? null, resolved_at: null,
    });
    break;
  case "resolve":
    if (!positionals[0]) die("usage: resolve <id>");
    id = await updateEntry(positionals[0], { resolved_at: new Date().toISOString() });
    break;
  default:
    die("usage: log.mjs change|bank|qa|qa-action|open|resolve ... (see header of this file)");
}
console.log(id);
