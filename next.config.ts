import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  // pdfjs-dist + @napi-rs/canvas + sharp ship native bindings that must be
  // resolved at runtime, not bundled by Turbopack/Webpack.
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas", "sharp"],
  async headers() {
    // CSP allowlist:
    // - 'self'                  → same-origin scripts/styles/img/connect.
    // - 'unsafe-inline'/'eval' on script-src is required by Next.js
    //   App Router (RSC payload + framework runtime) and KaTeX/MathJax.
    // - Clerk + blob.vercel-storage.com for sign-in widgets and PDFs.
    // - blob: / data: on img-src for inline KaTeX glyphs + image previews.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://*.blob.vercel-storage.com https://blob.vercel-storage.com https://*.public.blob.vercel-storage.com https://*.clerk.com https://img.clerk.com",
      // Vercel Blob direct-upload PUTs can hit either the apex
      // (blob.vercel-storage.com) or per-store subdomains
      // (<id>.public.blob.vercel-storage.com / <id>.blob.vercel-storage.com).
      // A wildcard with one label doesn't cover the apex, so list both
      // explicitly. Without these, /admin/modules/new uploads hang at 0%
      // because the browser PUT is blocked by CSP. api.vercel.com is the
      // SDK's control plane for token generation in some flows.
      // vercel.com/api/blob is the @vercel/blob SDK's default control
      // plane (see node_modules/@vercel/blob/dist/chunk-*.cjs:
      // `defaultVercelBlobApiUrl = "https://vercel.com/api/blob"`). The
      // browser hits it during client uploads to coordinate PUTs; if
      // CSP blocks it the SDK silently retries until our 240s frontend
      // timeout fires with "Upload hung at 0%".
      "connect-src 'self' https://*.supabase.co https://*.clerk.accounts.dev https://*.clerk.com https://api.anthropic.com https://*.blob.vercel-storage.com https://blob.vercel-storage.com https://*.public.blob.vercel-storage.com https://api.vercel.com https://vercel.com",
      // Desmos calculator is embedded as an iframe during Math tests.
      // CSP blocked it → broken-image icon in the calculator panel.
      "frame-src 'self' https://*.clerk.accounts.dev https://challenges.cloudflare.com https://www.desmos.com https://*.desmos.com",
      // PDF viewer (/admin/modules/[id]/review) embeds /api/admin/modules/[id]/pdf
      // in an iframe. `frame-ancestors 'none'` blocks all framing —
      // including same-origin — so the PDF panel shows a broken icon.
      // `'self'` allows our own pages to frame our own routes while
      // still blocking third-party clickjacking.
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: csp },
          // SAMEORIGIN (not DENY) so the PDF preview iframe works.
          // CSP's frame-ancestors 'self' already provides the modern
          // clickjacking gate; this legacy header backs it up.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
