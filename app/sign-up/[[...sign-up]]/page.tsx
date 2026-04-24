'use client';

import { SignUp } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import Logo from "@/components/Logo";

export default function SignUpPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-24 bg-deep-navy">
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full opacity-10 blur-3xl bg-lime-green pointer-events-none" />

      <div className="relative z-10 flex flex-col items-center gap-8 w-full max-w-md">
        <div className="flex flex-col items-center gap-3">
          <Logo size={48} />
          <h1 className="text-xl font-semibold text-white">SAT Exam OS</h1>
        </div>

        <SignUp
          appearance={{
            baseTheme: dark,
            variables: {
              colorPrimary: "#2563EB",
              colorBackground: "#0F1A3A",
              colorText: "#F1F5F9",
              colorTextSecondary: "#CBD5E1",
              colorInputBackground: "#0A1330",
              colorInputText: "#F8FAFC",
              colorNeutral: "#F1F5F9",
              borderRadius: "0.75rem",
              fontFamily: "var(--font-plus-jakarta-sans), system-ui, sans-serif",
            },
            elements: {
              rootBox: "w-full",
              card: "bg-[#0F1A3A] border border-white/10 shadow-xl shadow-black/40 rounded-2xl",
              headerTitle: "text-white font-bold text-xl",
              headerSubtitle: "text-slate-300",
              socialButtonsBlockButton:
                "bg-white/5 border border-white/15 text-white hover:bg-white/10",
              socialButtonsBlockButtonText: "text-white font-medium",
              dividerLine: "bg-white/15",
              dividerText: "text-slate-300",
              formFieldLabel: "text-slate-200 font-medium",
              formFieldInput:
                "bg-[#0A1330] border border-white/15 text-white placeholder:text-slate-500",
              formButtonPrimary:
                "bg-electric-blue hover:bg-electric-blue/90 text-white font-semibold",
              footer: "bg-transparent",
              footerAction__signUp: "text-slate-300",
              footerActionText: "text-slate-300",
              footerActionLink: "text-electric-blue hover:text-lime-green font-semibold",
              footerPages: "text-slate-400",
              footerPagesLink: "text-slate-400 hover:text-slate-200",
              identityPreviewText: "text-white",
              identityPreviewEditButton: "text-electric-blue",
              alertText: "text-slate-200",
              formResendCodeLink: "text-electric-blue",
            },
          }}
        />
      </div>
    </main>
  );
}
