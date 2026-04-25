import { redirect } from "next/navigation";

// Permanent fix: redirect to Clerk's hosted Account Portal for sign-up.
// Embedded <SignUp /> does not mount when a Clerk dev instance (pk_test_*)
// is served from a production custom domain — the __clerk_db_jwt handshake
// cookie cannot be set on arbitrary hosts. The hosted portal lives on
// Clerk's own domain and works regardless of dev/prod instance.
//
// After sign-up, Clerk redirects back to /register/profile where the
// authenticated user completes their student profile (grade, school, etc).
const PORTAL_BASE = "https://prompt-satyr-3.accounts.dev";
const APP_ORIGIN = "https://sat.nexhunt.xyz";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string }>;
}) {
  const params = await searchParams;
  const returnTo = params.redirect_url ?? `${APP_ORIGIN}/register/profile`;
  redirect(`${PORTAL_BASE}/sign-up?redirect_url=${encodeURIComponent(returnTo)}`);
}
