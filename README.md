# SAT Exam OS

**Upload. Parse. Assign. Analyze.**

AI-powered SAT test management for tutoring centers.

---

## Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 App Router (TypeScript strict) |
| Auth | Clerk (`@clerk/nextjs`) |
| Database | Supabase (PostgreSQL, service_role) |
| AI | Anthropic Claude via `@ai-sdk/anthropic` |
| File Storage | Vercel Blob |
| Email | Resend |
| i18n | next-intl (zh default, en) |
| Styling | Tailwind v4 + Plus Jakarta Sans |
| Charts | Recharts |

---

## Phase 1 Scope

- Project scaffold: Next.js 16 + Clerk + Supabase + next-intl
- Dark-first brand system (deep-navy / electric-blue / lime-green palette)
- Landing page with hero, features, bilingual support
- Clerk auth: Sign In / Sign Up / Student Register routes
- i18n: zh + en, cookie-based locale switching
- Database schema: 11 tables covering users, modules, questions, tests, submissions, analytics
- Seed: SAT domain reference data (8 domains across Math + Reading & Writing)
- Legal docs: disclaimer, terms, privacy

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in all values in `.env.local`:
- **Clerk**: Create an app at [clerk.com](https://clerk.com) — copy publishable key + secret key
- **Supabase**: Create a project at [supabase.com](https://supabase.com) — copy URL + anon key + service role key
- **Anthropic**: Get an API key at [console.anthropic.com](https://console.anthropic.com)
- **Resend**: Get an API key at [resend.com](https://resend.com)
- **Vercel Blob**: Provision via Vercel dashboard or `vercel env pull`

### 3. Run database migrations

```bash
# Using Supabase CLI
supabase db push

# Or apply manually in Supabase SQL editor:
# supabase/migrations/0001_init_schema.sql
# supabase/migrations/0002_init_seed.sql
```

### 4. Run development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Deploy to Vercel

```bash
npm i -g vercel
vercel link
vercel env pull   # pulls env vars from Vercel project
vercel --prod
```

Or connect the GitHub repo in the Vercel dashboard for automatic deployments.

---

## Project Structure

```
sat-exam-os/
├── app/
│   ├── layout.tsx          # Root layout: Clerk + NextIntl + font
│   ├── page.tsx            # Landing page
│   ├── globals.css         # Tailwind v4 theme + Clerk dark overrides
│   ├── sign-in/            # Clerk SignIn component
│   ├── sign-up/            # Clerk SignUp component
│   └── register/           # Student self-registration
├── components/
│   ├── Logo.tsx            # SVG logo with brand gradient
│   └── LanguageSwitcher.tsx
├── i18n/
│   ├── config.ts           # Locale config (zh, en)
│   └── request.ts          # Cookie → Accept-Language → default
├── lib/
│   ├── supabase.ts         # getServiceClient() + getAnonClient()
│   ├── clerk-helpers.ts    # Role checking helpers
│   ├── auth.ts             # getCurrentUser() (Clerk + Supabase merge)
│   └── rbac.ts             # requireRole() / requireAnyRole()
├── messages/
│   ├── zh.json
│   └── en.json
├── supabase/migrations/
│   ├── 0001_init_schema.sql
│   └── 0002_init_seed.sql
├── docs/LEGAL/
│   ├── disclaimer.md
│   ├── terms.md
│   └── privacy.md
├── public/logo.svg
├── proxy.ts                # Clerk auth proxy (Next.js 16)
├── next.config.ts
└── .env.example
```

---

## Legal

SAT is a registered trademark of College Board. SAT Exam OS is not affiliated with or endorsed by College Board.

See [docs/LEGAL/disclaimer.md](./docs/LEGAL/disclaimer.md) for full disclaimer.
