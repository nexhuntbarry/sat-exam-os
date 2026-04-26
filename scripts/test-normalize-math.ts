// Inline sanity test for normalizeMath.
//   npx tsx scripts/test-normalize-math.ts
import { normalizeMath } from "../lib/math/normalize-math";

interface Case {
  name: string;
  input: string;
  expected: string;
}

const cases: Case[] = [
  {
    name: "wraps bare \\frac{1}{7}",
    input: "the slope is \\frac{1}{7}",
    expected: "the slope is $\\frac{1}{7}$",
  },
  {
    name: "leaves already-wrapped math alone",
    input: "already $\\frac{1}{2}$ done",
    expected: "already $\\frac{1}{2}$ done",
  },
  {
    name: "wraps standalone fraction 1/7",
    input: "the slope is 1/7 here",
    expected: "the slope is $1/7$ here",
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = normalizeMath(c.input);
  const ok = got === c.expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!ok) {
    console.log(`  input:    ${JSON.stringify(c.input)}`);
    console.log(`  expected: ${JSON.stringify(c.expected)}`);
    console.log(`  got:      ${JSON.stringify(got)}`);
  }
  if (ok) pass++;
  else fail++;
}
console.log(`\n[normalizeMath] ${pass}/${cases.length} passed`);
if (fail > 0) process.exit(1);
