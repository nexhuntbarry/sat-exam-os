import type { Metadata } from "next";
import LegalDoc from "@/components/LegalDoc";

export const metadata: Metadata = { title: "Disclaimer · SAT Exam OS" };

export default function Page() {
  return <LegalDoc slug="disclaimer" />;
}
