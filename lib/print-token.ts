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

/** The ticket, or null when it is forged, malformed or expired. */
export function readPrintTicket(token: string | null | undefined): PrintTicket | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as PrintTicket;
    return typeof t.exp === "number" && t.exp > Date.now() ? t : null;
  } catch {
    return null;
  }
}
