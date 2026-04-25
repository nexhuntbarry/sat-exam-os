import { redirect } from "next/navigation";

// Permanent fix: redirect to Clerk's hosted Account Portal.
// See app/sign-in/[[...sign-in]]/page.tsx for the rationale.
const PORTAL_BASE = "https://prompt-satyr-3.accounts.dev";
const APP_ORIGIN = "https://sat.nexhunt.xyz";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string }>;
}) {
  const params = await searchParams;
  const returnTo = params.redirect_url ?? `${APP_ORIGIN}/dashboard`;
  redirect(`${PORTAL_BASE}/sign-up?redirect_url=${encodeURIComponent(returnTo)}`);
}
