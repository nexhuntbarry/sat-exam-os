// Centralised date/time formatting locked to the school's timezone.
//
// Vercel server clock runs UTC; without an explicit timeZone every
// server-rendered timestamp lands ~4-5h off for staff in New York.
// Use these helpers everywhere a human-readable date or time is shown.
// The `Date#toLocale*` calls scattered across the codebase before this
// file silently drifted with each server boundary.

const NY_ZONE = "America/New_York";

const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const DATE_TIME_SECONDS = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

const DATE_ONLY = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

const TIME_ONLY = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_ZONE,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function asDate(input: string | number | Date | null | undefined): Date | null {
  if (input == null || input === "") return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(input: string | number | Date | null | undefined): string {
  const d = asDate(input);
  return d ? DATE_TIME.format(d) : "—";
}

export function formatDateTimeSeconds(input: string | number | Date | null | undefined): string {
  const d = asDate(input);
  return d ? DATE_TIME_SECONDS.format(d) : "—";
}

export function formatDate(input: string | number | Date | null | undefined): string {
  const d = asDate(input);
  return d ? DATE_ONLY.format(d) : "—";
}

export function formatTime(input: string | number | Date | null | undefined): string {
  const d = asDate(input);
  return d ? TIME_ONLY.format(d) : "—";
}

// Short forms for dense tables: the year is dropped when the date falls in
// the current New York year ("10/30 4:55 PM"), kept otherwise
// ("10/30/2025 4:55 PM"). `now` is injectable for tests.
const NY_YEAR = new Intl.DateTimeFormat("en-US", { timeZone: NY_ZONE, year: "numeric" });

const SHORT_DATE_NO_YEAR = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_ZONE,
  month: "numeric",
  day: "numeric",
});

export function formatShortDate(
  input: string | number | Date | null | undefined,
  now: Date = new Date(),
): string {
  const d = asDate(input);
  if (!d) return "—";
  return NY_YEAR.format(d) === NY_YEAR.format(now)
    ? SHORT_DATE_NO_YEAR.format(d)
    : DATE_ONLY.format(d);
}

export function formatShortDateTime(
  input: string | number | Date | null | undefined,
  now: Date = new Date(),
): string {
  const d = asDate(input);
  if (!d) return "—";
  return `${formatShortDate(d, now)} ${TIME_ONLY.format(d)}`;
}
