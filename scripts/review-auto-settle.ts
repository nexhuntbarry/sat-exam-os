// scripts/review-auto-settle.ts
//
// Let the system settle what it can in the Review Queue and Draft
// (lib/review-auto.ts): approve rows where every check passes, set the key
// where the code solve and the second solve agree in a module with no answer
// key (no real student answers; explanation written + checked in the same
// write), move ownerless Drafts into the queue. Dry run by default; uses the
// checks already stored in the notes — the only AI calls are one explanation
// per key change on --apply. Idempotent: a settled row is no longer Needs
// Review / Draft. Live-test ([live-fix]) rows are never touched.
//
//   npx tsx --env-file=.env.prod scripts/review-auto-settle.ts            # dry run
//   npx tsx --env-file=.env.prod scripts/review-auto-settle.ts --apply [--module <id>] [--max <key changes>]
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { settleQueue } from "../lib/review-auto";
import { DECIDE_SELECT } from "../lib/review-decide";
import { fetchAllRows } from "../lib/fetch-all-rows";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const MODULES = args.flatMap((a, i) => (a === "--module" && args[i + 1] ? [args[i + 1]] : []));
// At most this many key changes (one explanation AI call each) per run.
const MAX = args.includes("--max") ? Number(args[args.indexOf("--max") + 1]) : undefined;
if (MAX !== undefined && !(Number.isInteger(MAX) && MAX >= 0)) throw new Error("--max needs a whole number");

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const { data: mods } = await db.from("modules").select("id, module_name");
  const name = new Map((mods ?? []).map((m) => [m.id as string, m.module_name as string]));
  if (APPLY) {
    // Every row, paged (a plain select stops at 1000).
    const { data, error } = await fetchAllRows<Record<string, unknown>>((from, to) =>
      db.from("questions").select(DECIDE_SELECT).in("parsing_status", ["Needs Review", "Draft"]).order("id").range(from, to),
    );
    if (error) throw new Error(`backup read failed: ${JSON.stringify(error)}`);
    const backup = path.join(process.cwd(), ".omc", "backups", `review-auto-settle-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, JSON.stringify(data ?? [], null, 2));
    console.log(`backup: ${backup}`);
  }
  const { outcomes, paused } = await settleQueue(db, { apply: APPLY, moduleIds: MODULES.length ? MODULES : undefined, maxKeyChanges: MAX });
  console.log(`${APPLY ? "APPLY" : "DRY RUN"}${paused ? " (auto-approval PAUSED by the spot-check)" : ""}: ${outcomes.length} Needs Review / Draft rows\n`);
  const count = new Map<string, number>();
  for (const o of outcomes) count.set(`${o.status_before} → ${o.action}`, (count.get(`${o.status_before} → ${o.action}`) ?? 0) + 1);
  for (const [k, v] of [...count.entries()].sort()) console.log(`  ${k}: ${v}`);
  console.log("");
  for (const o of outcomes.filter((x) => x.action !== "none")) {
    console.log(`${o.action.padEnd(16)} ${name.get(o.module_id ?? "") ?? o.module_id} Q${o.number} [${o.status_before}]: ${o.detail}`);
  }
  const why = new Map<string, number>();
  for (const o of outcomes.filter((x) => x.action === "none")) {
    const k = o.detail.replace(/\(.*$/, "").slice(0, 70);
    why.set(k, (why.get(k) ?? 0) + 1);
  }
  console.log("\nStill waiting for a person, by first reason:");
  for (const [k, v] of [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${v}  ${k}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
