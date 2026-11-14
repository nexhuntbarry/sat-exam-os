import { BADGE_PATH, BADGE_VIEWBOX, BRAND, WORDMARK_PATH, WORDMARK_VIEWBOX } from "@/lib/brand";

// Premier marks as inline SVG in one colour (currentColor by default).
// On light backgrounds use the dark gold (BRAND.darkGold) or charcoal: the
// brand gold (#ebca93) is 1.6:1 on white and is for dark backgrounds only.

interface MarkProps {
  /** Rendered height in px; width follows the mark's aspect ratio. */
  height: number;
  color?: string;
  className?: string;
  /** Accessible name; omit when the mark sits next to its name in text. */
  title?: string;
}

function Mark({ d, vb, height, color = "currentColor", className, title }: MarkProps & { d: string; vb: { width: number; height: number } }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${vb.width} ${vb.height}`}
      height={height}
      width={(height * vb.width) / vb.height}
      className={className}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
    >
      <path fill={color} d={d} />
    </svg>
  );
}

export function PremierBadge(props: MarkProps) {
  return <Mark d={BADGE_PATH} vb={BADGE_VIEWBOX} {...props} />;
}

export function PremierWordmark(props: MarkProps) {
  return <Mark d={WORDMARK_PATH} vb={WORDMARK_VIEWBOX} {...props} />;
}

/** Sign-in / sign-up: badge over the wordmark, centred, product name below. */
export function PremierLockup({ product = "SAT Exam OS", heading = false }: { product?: string; heading?: boolean }) {
  // The product name is the page's <h1> unless the page has a title of its own.
  const Product = heading ? "h1" : "p";
  return (
    <div className="flex flex-col items-center gap-2.5" data-brand="premier">
      <PremierBadge height={64} color={BRAND.darkGold} />
      <PremierWordmark height={20} color={BRAND.darkGold} title="Premier" />
      <Product className={heading ? "mt-1 text-lg font-semibold text-charcoal" : "mt-0.5 text-sm font-medium text-mid-gray"}>{product}</Product>
    </div>
  );
}

/**
 * App header (top left): badge + wordmark, "SAT Exam OS · <role>" underneath.
 * Below `sm` only the badge and the role: the rest doesn't fit beside the
 * header controls on a phone.
 */
export function PremierHeaderMark({ role }: { role?: string }) {
  return (
    <div className="flex items-center gap-2 sm:gap-2.5 min-w-0" data-brand="premier">
      <PremierBadge height={34} color={BRAND.darkGold} className="shrink-0 h-[30px] w-auto sm:h-[34px]" title="Premier" />
      <div className="flex flex-col justify-center gap-1 min-w-0">
        <PremierWordmark height={13} color={BRAND.darkGold} className="hidden sm:block shrink-0" />
        <span className="text-[10.5px] leading-none font-medium text-soft-mute whitespace-nowrap truncate">
          {role ? (
            <>
              <span className="hidden sm:inline">SAT Exam OS · </span>
              {role}
            </>
          ) : (
            "SAT Exam OS"
          )}
        </span>
      </div>
    </div>
  );
}
