// scripts/repair-currency-and-blind-images.ts
//
// Backfill script that runs the new post-parse-cleanup steps
// (patchCurrencyDollars + resolveBlindImages) against every existing
// module, without re-running the full parse. The same logic ships
// automatically for new parses via runPostParseCleanup, but rows that
// were ingested before this fix landed are stuck — the bus rental
// question that renders "950forthefirst3hoursandanadditional" and
// the Q10 March 2024 B SAT Math Module 2 "Demoted by post-parse-cleanup:
// failed checks → blind-image" both need this one-shot pass.
//
// Usage:
//   npx tsx scripts/repair-currency-and-blind-images.ts            # dry-run
//   npx tsx scripts/repair-currency-and-blind-images.ts --apply
//   npx tsx scripts/repair-currency-and-blind-images.ts --apply --module=<uuid>
//
// --module limits to a single module so you can ship the fix for one
// failing question without paying the Claude vision cost on every
// module in the table.

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { runPostParseCleanup } from "../lib/post-parse-cleanup";

function loadEnv(file: string, overwrite: boolean) {
  try {
    const body = readFileSync(resolve(process.cwd(), file), "utf8");
    for (const line of body.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      if (overwrite || !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* ignore */
  }
}
loadEnv(".env.local", true);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey || !process.env.ANTHROPIC_API_KEY) {
  console.error("Missing env (Supabase or ANTHROPIC_API_KEY).");
  process.exit(1);
}

const apply = process.argv.includes("--apply");
const moduleArg = process.argv.find((a) => a.startsWith("--module="));
const onlyModuleId = moduleArg ? moduleArg.split("=")[1] : null;

const sb = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

async function main() {
  if (!apply) {
    console.log(
      "DRY-RUN: append --apply to actually mutate rows. Listing modules that would run.",
    );
  }
  let modules: Array<{ id: string; module_name: string | null }>;
  if (onlyModuleId) {
    const { data, error } = await sb
      .from("modules")
      .select("id, module_name")
      .eq("id", onlyModuleId);
    if (error) throw new Error(error.message);
    modules = data ?? [];
  } else {
    const { data, error } = await sb
      .from("modules")
      .select("id, module_name")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    modules = data ?? [];
  }
  if (modules.length === 0) {
    console.error("No modules matched.");
    process.exit(1);
  }
  console.log(`Targeting ${modules.length} module(s).`);
  if (!apply) {
    for (const m of modules) console.log(`  · ${m.id} — ${m.module_name ?? "?"}`);
    return;
  }
  let totalCurrency = 0;
  let totalNumWrap = 0;
  let totalBlindResolved = 0;
  let totalDemoted = 0;
  const errors: string[] = [];
  for (const m of modules) {
    process.stdout.write(`Running cleanup on ${m.module_name ?? m.id}… `);
    try {
      const summary = await runPostParseCleanup(m.id, sb);
      totalCurrency += summary.currencyDollarsEscaped;
      totalNumWrap += summary.pureNumericMathUnwrapped;
      totalBlindResolved += summary.blindImagesResolved;
      totalDemoted += summary.anomaliesDemoted;
      console.log(
        `currency=${summary.currencyDollarsEscaped} bsDigit=${summary.backslashDigitsStripped} dblEsc=${summary.doublyEscapedMathFixed} numWrap=${summary.pureNumericMathUnwrapped} ansNorm=${summary.answerLetterNormalizations} blindImg=${summary.blindImagesResolved} demoted=${summary.anomaliesDemoted} repro=${summary.rowsRepromoted}`,
      );
      if (summary.errors.length > 0) {
        errors.push(...summary.errors.map((e) => `${m.id}: ${e}`));
      }
    } catch (e) {
      console.log("FAILED");
      errors.push(`${m.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(
    `\nDone. currency-escaped=${totalCurrency} numeric-math-unwrapped=${totalNumWrap} blind-image-resolved=${totalBlindResolved} demoted=${totalDemoted} errors=${errors.length}`,
  );
  if (errors.length > 0) {
    console.log("\nErrors:");
    for (const line of errors) console.log(`  · ${line}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
