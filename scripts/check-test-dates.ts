// Read-only: list real (non-QA) tests whose open/due dates were probably
// shifted by the H-17 create-page bug.
//
// Before the fix, /admin/tests/new sent the raw <input type="datetime-local">
// value ("2026-10-27T10:00", no timezone) and Postgres stored it as UTC. So
// an admin in New York who picked 10:00 got 10:00Z = 06:00 EDT. For each
// test we print the stored value, how it displays in New York today, and
// what the admin most likely meant (the stored UTC wall-clock read as New
// York time). The Edit modal converts correctly, but re-saving a shifted
// test keeps the shifted instant, so edited tests are listed too — flagged
// separately because they may already have been corrected by hand.
//
// Usage: npx tsx scripts/check-test-dates.ts
// Writes nothing.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const envText = readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const TZ = "America/New_York";

function nyWall(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// The stored UTC wall-clock ("10:00Z") is what the admin typed.
function intendedNy(iso: string): string {
  const d = new Date(iso);
  return new Date(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(),
  ).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }) + " (as typed)";
}

async function main() {
  const { data: qaUsers, error: qaErr } = await db
    .from("users")
    .select("id")
    .ilike("email", "qa-test-%");
  if (qaErr) throw qaErr;
  const qaIds = new Set((qaUsers ?? []).map((u) => u.id as string));

  const { data: tests, error } = await db
    .from("tests")
    .select("id, test_name, status, open_date, due_date, created_by, created_at, updated_at")
    .or("open_date.not.is.null,due_date.not.is.null")
    .order("created_at", { ascending: false });
  if (error) throw error;

  const real = (tests ?? []).filter((t) => !t.created_by || !qaIds.has(t.created_by));
  if (real.length === 0) {
    console.log("No real tests with open/due dates.");
    return;
  }

  console.log(`${real.length} real test(s) with an open or due date.\n`);
  for (const t of real) {
    const edited =
      t.updated_at && Math.abs(new Date(t.updated_at).getTime() - new Date(t.created_at).getTime()) > 5_000;
    console.log(`${t.test_name}  [${t.status}]  id=${t.id}`);
    console.log(`  created ${nyWall(t.created_at)}${edited ? `  · edited ${nyWall(t.updated_at)} (may already be fixed)` : ""}`);
    for (const [label, v] of [["open", t.open_date], ["due ", t.due_date]] as const) {
      if (!v) continue;
      console.log(`  ${label}: stored ${v}  shows ${nyWall(v)} NY  · likely intended ${intendedNy(v)} NY`);
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
