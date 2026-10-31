import type { ReactNode } from "react";
import { cn } from "./cn";

/** Single line of text that truncates with "…" and shows the full text on
 *  hover. Pass `title` when children is not a plain string. */
export function TruncatedText({
  children,
  title,
  className,
}: {
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  const hover = title ?? (typeof children === "string" || typeof children === "number" ? String(children) : undefined);
  return (
    <span className={cn("block min-w-0 truncate", className)} title={hover}>
      {children}
    </span>
  );
}

/** Main content (names, titles) that must stay complete: wraps onto at most
 *  two lines instead of truncating; anything longer is clamped with the full
 *  text on hover. */
export function ClampText({
  children,
  title,
  className,
}: {
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  const hover = title ?? (typeof children === "string" || typeof children === "number" ? String(children) : undefined);
  return (
    <span className={cn("block min-w-0 line-clamp-2 whitespace-normal break-words", className)} title={hover}>
      {children}
    </span>
  );
}

/** Two-line cell: main value on top, small muted detail below. Both lines
 *  truncate, unless `wrapMain`: then a name/title wraps onto up to two lines
 *  and stays complete (rule 3), and only the detail truncates. Wrap it in a
 *  Link yourself if the row should navigate. */
export function TwoLineCell({
  main,
  detail,
  mainTitle,
  detailTitle,
  className,
  mainClassName,
  wrapMain = false,
}: {
  main: ReactNode;
  detail?: ReactNode;
  /** Hover text when `main` is not a plain string. */
  mainTitle?: string;
  /** Hover text when `detail` is not a plain string. */
  detailTitle?: string;
  className?: string;
  mainClassName?: string;
  /** Main is a name/title: wrap instead of truncating. */
  wrapMain?: boolean;
}) {
  const Main = wrapMain ? ClampText : TruncatedText;
  return (
    <span className={cn("block min-w-0", className)}>
      <Main title={mainTitle} className={cn("text-charcoal", mainClassName)}>
        {main}
      </Main>
      {detail != null && detail !== "" && (
        <TruncatedText title={detailTitle} className="text-xs text-soft-mute">
          {detail}
        </TruncatedText>
      )}
    </span>
  );
}
