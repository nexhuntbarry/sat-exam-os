import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "SAT Exam OS",
    template: "%s | SAT Exam OS",
  },
  description:
    "Upload. Parse. Assign. Analyze. — AI-powered SAT test management for tutoring centers.",
  keywords: [
    "SAT Exam OS",
    "SAT test management",
    "AI education",
    "tutoring center",
    "SAT preparation",
    "補習班",
    "SAT 測驗管理",
  ],
  openGraph: {
    title: "SAT Exam OS",
    description: "Upload. Parse. Assign. Analyze.",
    type: "website",
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();
  const htmlLang = locale === "en" ? "en" : "zh-TW";

  return (
    <ClerkProvider afterSignOutUrl="/">
      <html lang={htmlLang} className={inter.variable}>
        <body className="font-sans antialiased bg-cream text-charcoal">
          <NextIntlClientProvider locale={locale} messages={messages}>
            {children}
          </NextIntlClientProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
