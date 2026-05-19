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
