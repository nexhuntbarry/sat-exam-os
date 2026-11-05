import type { Metadata } from "next";
import LegalDoc from "@/components/LegalDoc";

export const metadata: Metadata = { title: "Terms of Service · SAT Exam OS" };

export default function Page() {
  return <LegalDoc slug="terms" />;
}
