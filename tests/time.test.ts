import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AppError,
  bookingTimes,
  dayBounds,
  instantToLocal,
  localToInstant,
  todayLocal,
  validateDate,
  validateDuration,
} from "../lib/time";

function rejects(operation: () => unknown) {
  assert.throws(
    operation,
    (error: unknown) => error instanceof AppError && error.status === 400,
  );
}

test("calendar validation accepts leap days and rejects impossible or malformed dates", () => {
  assert.equal(validateDate("2032-02-29"), "2032-02-29");
  for (const value of [
    "2030-02-29",
    "2030-02-30",
    "2030-13-01",
    "2030-2-01",
    "2030-01-01T00:00",
    "",
    undefined,
  ]) {
    rejects(() => validateDate(value));
  }
});

test("duration defaults to two hours and permits only whole hours from one through eight", () => {
  assert.equal(validateDuration(), 2);
  assert.equal(validateDuration(1), 1);
  assert.equal(validateDuration(8), 8);
  for (const value of [0, -1, 9, 1.5, NaN, Infinity, "2", null])
    rejects(() => validateDuration(value));
});

test("local start times resolve with Sydney summer and winter offsets", () => {
  assert.equal(
    localToInstant("2030-01-07T10:00").toString(),
    "2030-01-06T23:00:00Z",
  );
  assert.equal(
    localToInstant("2030-07-07T10:00").toString(),
    "2030-07-07T00:00:00Z",
  );
  assert.equal(instantToLocal("2030-01-06T23:00:00Z"), "2030-01-07T10:00");
  assert.equal(instantToLocal("2030-07-07T00:00:00Z"), "2030-07-07T10:00");
});

test("start times must be valid hourly local values without offsets or seconds", () => {
  for (const value of [
    "2030-01-07T10:30",
    "2030-01-07T10:00:00",
    "2030-01-07T10:00Z",
    "2030-01-07T24:00",
    "2030-02-30T10:00",
    "2030-01-07",
    null,
  ]) {
    rejects(() => localToInstant(value));
  }
});

test("nonexistent and repeated Sydney DST hours are rejected explicitly", () => {
  rejects(() => localToInstant("2030-10-06T02:00"));
  rejects(() => localToInstant("2030-04-07T02:00"));
  assert.ok(localToInstant("2030-10-06T01:00"));
  assert.ok(localToInstant("2030-10-06T03:00"));
  assert.ok(localToInstant("2030-04-07T01:00"));
  assert.ok(localToInstant("2030-04-07T03:00"));
});

test("two-hour reservations cross midnight without truncation", () => {
  const booking = bookingTimes("2030-01-07T23:00");
  assert.equal(booking.durationHours, 2);
  assert.equal(instantToLocal(booking.startsAt), "2030-01-07T23:00");
  assert.equal(instantToLocal(booking.endsAt), "2030-01-08T01:00");
  assert.equal(
    Date.parse(booking.endsAt) - Date.parse(booking.startsAt),
    7_200_000,
  );
});

test("duration means elapsed hours across a daylight-saving change", () => {
  const spring = bookingTimes("2030-10-06T01:00", 2);
  assert.equal(instantToLocal(spring.endsAt), "2030-10-06T04:00");
  assert.equal(
    Date.parse(spring.endsAt) - Date.parse(spring.startsAt),
    7_200_000,
  );
  const autumn = bookingTimes("2030-04-07T01:00", 2);
  assert.equal(instantToLocal(autumn.endsAt), "2030-04-07T02:00");
  assert.equal(
    Date.parse(autumn.endsAt) - Date.parse(autumn.startsAt),
    7_200_000,
  );
});

test("Sydney calendar-day bounds include 23-hour and 25-hour DST days", () => {
  const normal = dayBounds("2030-01-07");
  assert.equal(
    Date.parse(normal.endsAt) - Date.parse(normal.startsAt),
    86_400_000,
  );
  const spring = dayBounds("2030-10-06");
  assert.equal(
    Date.parse(spring.endsAt) - Date.parse(spring.startsAt),
    23 * 3_600_000,
  );
  const autumn = dayBounds("2030-04-07");
  assert.equal(
    Date.parse(autumn.endsAt) - Date.parse(autumn.startsAt),
    25 * 3_600_000,
  );
  assert.equal(instantToLocal(spring.startsAt), "2030-10-06T00:00");
  assert.equal(instantToLocal(spring.endsAt), "2030-10-07T00:00");
});

test("past reservations are rejected unless deliberately inspecting historical time bounds", () => {
  rejects(() => bookingTimes("2020-01-07T10:00"));
  assert.equal(bookingTimes("2020-01-07T10:00", 2, false).durationHours, 2);
});

test("today is derived in the club timezone instead of the execution host timezone", () => {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = ["year", "month", "day"]
    .map((kind) => parts.find((part) => part.type === kind)?.value)
    .join("-");
  assert.equal(todayLocal(), value);
});
