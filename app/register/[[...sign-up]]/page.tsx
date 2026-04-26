'use client';

import { SignUp } from "@clerk/nextjs";
import Logo from "@/components/Logo";

export default function StudentRegisterPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-24 bg-cream">
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full opacity-15 blur-3xl bg-warm-coral pointer-events-none" />

      <div className="relative z-10 flex flex-col items-center gap-8 w-full max-w-md">
        <div className="flex flex-col items-center gap-3">
          <Logo size={48} />
          <h1 className="text-xl font-semibold text-charcoal">Student Registration</h1>
          <p className="text-mid-gray text-sm">SAT Exam OS</p>
        </div>

        <SignUp
          signInUrl="/sign-in"
          forceRedirectUrl="/register/profile"
          appearance={{
            variables: {
              colorPrimary: "#F0523D",
              colorBackground: "#FFFFFF",
              colorText: "#1F1F1F",
              colorTextSecondary: "#3E3E3E",
              colorInputBackground: "#FFFFFF",
              colorInputText: "#1F1F1F",
              colorNeutral: "#1F1F1F",
              borderRadius: "0.75rem",
              fontFamily: "var(--font-inter), Inter, system-ui, sans-serif",
            },
            elements: {
              rootBox: "w-full",
              card: "bg-surface border border-divider shadow-lg shadow-black/5 rounded-2xl",
              headerTitle: "text-charcoal font-bold text-xl",
              headerSubtitle: "text-mid-gray",
              socialButtonsBlockButton:
                "bg-surface border border-divider text-charcoal hover:bg-light-bg",
              socialButtonsBlockButtonText: "text-charcoal font-medium",
              dividerLine: "bg-divider",
              dividerText: "text-soft-mute",
              formFieldLabel: "text-charcoal font-medium",
              formFieldInput:
                "bg-surface border border-divider text-charcoal placeholder:text-soft-mute",
              formButtonPrimary:
                "bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold",
              footer: "bg-transparent",
              footerActionText: "text-mid-gray",
              footerActionLink: "text-warm-coral hover:text-warm-coral-dark font-semibold",
            },
          }}
        />
      </div>
    </main>
  );
}
