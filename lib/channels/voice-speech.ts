import { Temporal } from "@js-temporal/polyfill";
import type { Booking } from "@/lib/domain";
import { TIME_ZONE } from "@/lib/domain";

const DIGITS = "零一二三四五六七八九";

function number(value: number): string {
  if (value < 10) return DIGITS[value];
  if (value < 20) return `十${value % 10 ? DIGITS[value % 10] : ""}`;
  return `${DIGITS[Math.floor(value / 10)]}十${value % 10 ? DIGITS[value % 10] : ""}`;
}

/** Read credentials once, in short groups, without treating them as integers. */
export function spokenAccessCode(value: string): string {
  const compact = value.replace(/\s/g, "");
  const groups =
    compact
      .replace(/^\+/, "")
      .match(/.{1,4}/g)
      ?.map((group) => group.replace(/\d/g, (digit) => DIGITS[Number(digit)]))
      .join("，") || "";
  return `${compact.startsWith("+") ? "加" : ""}${groups}`;
}

export function spokenDate(value: string, now: Date = new Date()): string {
  const date = Temporal.PlainDate.from(value);
  const today = Temporal.Instant.from(now.toISOString())
    .toZonedDateTimeISO(TIME_ZONE)
    .toPlainDate();
  const days = today.until(date).days;
  if (days >= 0 && days <= 2) return ["今天", "明天", "后天"][days];
  const year =
    date.year === today.year
      ? ""
      : `${String(date.year).replace(/\d/g, (digit) => DIGITS[Number(digit)])}年`;
  return `${year}${number(date.month)}月${number(date.day)}日`;
}

function period(hour: number): string {
  if (hour < 6) return "凌晨";
  if (hour < 12) return "上午";
  if (hour === 12) return "中午";
  if (hour < 18) return "下午";
  return "晚上";
}

function clock(hour: number, minute = 0, includePeriod = true): string {
  const shortHour = hour > 12 ? hour - 12 : hour;
  const label = shortHour === 2 ? "两" : number(shortHour);
  const minutes =
    minute === 0
      ? ""
      : minute === 30
        ? "半"
        : `${minute < 10 ? "零" : ""}${number(minute)}分`;
  return `${includePeriod ? period(hour) : ""}${label}点${minutes}`;
}

export function spokenHourRange(start: number, end = start): string {
  return start === end
    ? clock(start)
    : `${clock(start)}到${clock(end, 0, period(start) !== period(end))}`;
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
        ? "第二天"
        : `${number(end.month)}月${number(end.day)}日`;
  const includeEndPeriod =
    days !== 0 || period(start.hour) !== period(end.hour);
  return `${clock(start.hour, start.minute)}到${endDate}${clock(end.hour, end.minute, includeEndPeriod)}`;
}

export function spokenDuration(hours: number): string {
  return `${hours === 2 ? "两" : number(hours)}小时`;
}

export function spokenBookingSummary(
  booking: Pick<Booking, "courtId" | "startsAt" | "endsAt" | "durationHours">,
  now: Date = new Date(),
): string {
  const date = Temporal.Instant.from(booking.startsAt)
    .toZonedDateTimeISO(TIME_ZONE)
    .toPlainDate()
    .toString();
  return `${spokenDate(date, now)}悉尼时间${spokenRange(booking.startsAt, booking.endsAt)}，${booking.courtId}号场，${spokenDuration(booking.durationHours)}。`;
}
