// Short-lived signed ticket that lets the server's own headless Chromium
// open /print/results/… for a PDF download without a Clerk session. Minted
// only by /api/print/results/…/pdf after it has authenticated the viewer;
// bound to that viewer, test, attempts and options; expires in 2 minutes.
// The print page re-checks the viewer's access with it (loadResultPrintouts).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrintOptions, Viewer } from "@/lib/result-printout";

export interface PrintTicket {
  viewer: Viewer;
  testId: string;
  subs: string[];
  opts: PrintOptions;
  /** false = no watermark (an admin turned it off); absent = on. */
  wm?: boolean;
  exp: number;
}

function secret(): string {
  // Dedicated secret in production; the Clerk key fallback is for local dev only.
  const s = process.env.PRINT_TOKEN_SECRET || (process.env.NODE_ENV !== "production" ? process.env.CLERK_SECRET_KEY : undefined);
  if (!s) throw new Error("PRINT_TOKEN_SECRET not set");
  return `print-ticket:${s}`;
}

const sign = (body: string) => createHmac("sha256", secret()).update(body).digest("base64url");

export function mintPrintTicket(t: Omit<PrintTicket, "exp">, ttlMs = 120_000): string {
  const body = Buffer.from(JSON.stringify({ ...t, exp: Date.now() + ttlMs })).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** The signed body of a ticket, or null when it is forged, malformed or expired. */
function verified(token: string | null | undefined): (Record<string, unknown> & { exp: number }) | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
    return t && typeof t.exp === "number" && t.exp > Date.now() ? t : null;
  } catch {
    return null;
  }
}

/** The ticket, or null when it is forged, malformed or expired (or a report ticket). */
export function readPrintTicket(token: string | null | undefined): PrintTicket | null {
  const t = verified(token);
  return t && t.kind === undefined ? (t as unknown as PrintTicket) : null;
}

// The one-page parent report (/print/students/<id>/report) gets its own
// kind of ticket, minted by /api/print/students/<id>/report/pdf after the
// access check, bound to the viewer, student, language and watermark.
export interface ReportTicket {
  kind: "student-report";
  viewer: Viewer;
  studentId: string;
  lang: "en" | "zh";
  /** false = no watermark (an admin turned it off). */
  wm: boolean;
  exp: number;
}

export function mintReportTicket(t: Omit<ReportTicket, "exp" | "kind">, ttlMs = 120_000): string {
  const body = Buffer.from(JSON.stringify({ ...t, kind: "student-report", exp: Date.now() + ttlMs })).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** The report ticket, or null when it is forged, malformed, expired or another kind. */
export function readReportTicket(token: string | null | undefined): ReportTicket | null {
  const t = verified(token);
  return t && t.kind === "student-report" ? (t as unknown as ReportTicket) : null;
}
