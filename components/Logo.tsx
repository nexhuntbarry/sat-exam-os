import { PremierBadge } from "@/components/brand/Premier";
import { BRAND } from "@/lib/brand";

interface LogoProps {
  size?: number;
  className?: string;
}

// The Premier laurel "P" badge (dark gold: these spots are all on light backgrounds).
export default function Logo({ size = 40, className = "" }: LogoProps) {
  return <PremierBadge height={size} color={BRAND.darkGold} className={className} title="Premier – SAT Exam OS" />;
}
