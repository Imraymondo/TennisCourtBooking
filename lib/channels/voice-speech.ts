import { Temporal } from "@js-temporal/polyfill";
import type { Booking } from "@/lib/domain";
import { TIME_ZONE } from "@/lib/domain";

const DIGITS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Read credentials once, in short groups, without treating them as integers. */
export function spokenAccessCode(value: string): string {
  const compact = value.replace(/\s/g, "");
  const groups =
    compact
      .replace(/^\+/, "")
      .match(/.{1,4}/g)
      ?.map((group) =>
        [...group]
          .map((character) =>
            /^\d$/.test(character) ? DIGITS[Number(character)] : character,
          )
          .join(" "),
      )
      .join(", ") || "";
  return `${compact.startsWith("+") ? "plus " : ""}${groups}`;
}

export function spokenDate(value: string, now: Date = new Date()): string {
  const date = Temporal.PlainDate.from(value);
  const today = Temporal.Instant.from(now.toISOString())
    .toZonedDateTimeISO(TIME_ZONE)
    .toPlainDate();
  const days = today.until(date).days;
  if (days >= 0 && days <= 2)
    return ["today", "tomorrow", "the day after tomorrow"][days];
  const year = date.year === today.year ? "" : ` ${date.year}`;
  return `${date.day} ${MONTHS[date.month - 1]}${year}`;
}

function period(hour: number): string {
  return hour < 12 ? "am" : "pm";
}

function clock(hour: number, minute = 0, includePeriod = true): string {
  if (minute === 0 && hour === 0) return "midnight";
  if (minute === 0 && hour === 12) return "noon";
  const shortHour = hour % 12 || 12;
  const minutes = minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`;
  return `${shortHour}${minutes}${includePeriod ? ` ${period(hour)}` : ""}`;
}

export function spokenHourRange(start: number, end = start): string {
  return start === end
    ? clock(start)
    : `${clock(start, 0, period(start) !== period(end))} to ${clock(end)}`;
}

/** Convert each stored instant separately so midnight and DST stay correct. */
export function spokenRange(startsAt: string, endsAt: string): string {
  const start = Temporal.Instant.from(startsAt).toZonedDateTimeISO(TIME_ZONE);
  const end = Temporal.Instant.from(endsAt).toZonedDateTimeISO(TIME_ZONE);
  const days = start.toPlainDate().until(end.toPlainDate()).days;
  const endDate =
    days === 0
      ? ""
      : days === 1
        ? " the next day"
        : ` on ${end.day} ${MONTHS[end.month - 1]}${end.year !== start.year ? ` ${end.year}` : ""}`;
  const includeStartPeriod =
    days !== 0 || period(start.hour) !== period(end.hour);
  return `${clock(start.hour, start.minute, includeStartPeriod)} to ${clock(end.hour, end.minute)}${endDate}`;
}

export function spokenDuration(hours: number): string {
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function spokenBookingSummary(
  booking: Pick<Booking, "courtId" | "startsAt" | "endsAt" | "durationHours">,
  now: Date = new Date(),
): string {
  const date = Temporal.Instant.from(booking.startsAt)
    .toZonedDateTimeISO(TIME_ZONE)
    .toPlainDate()
    .toString();
  return `${spokenDate(date, now)}, ${spokenRange(booking.startsAt, booking.endsAt)} Sydney time, Court ${booking.courtId}, ${spokenDuration(booking.durationHours)}.`;
}
