import assert from "node:assert/strict";
import { test } from "node:test";
import {
  spokenAccessCode,
  spokenBookingSummary,
  spokenDate,
  spokenDuration,
  spokenHourRange,
  spokenRange,
} from "../lib/channels/voice-speech";

const now = new Date("2026-12-31T13:30:00Z"); // Already January 1 in Sydney.

test("relative booking dates follow Sydney's calendar across the new year", () => {
  assert.equal(spokenDate("2027-01-01", now), "today");
  assert.equal(spokenDate("2027-01-02", now), "tomorrow");
  assert.equal(spokenDate("2027-01-03", now), "the day after tomorrow");
  assert.equal(spokenDate("2027-01-05", now), "5 January");
  assert.equal(spokenDate("2028-01-05", now), "5 January 2028");
  // Keep the relative wording even when tomorrow is in a different year.
  assert.equal(
    spokenDate("2027-01-01", new Date("2026-12-31T00:00:00Z")),
    "tomorrow",
  );
});

test("a booking says its date once and uses ordinary afternoon hours and duration", () => {
  const summary = spokenBookingSummary(
    {
      courtId: 1,
      startsAt: "2027-01-01T04:00:00Z",
      endsAt: "2027-01-01T06:00:00Z",
      durationHours: 2,
    },
    now,
  );
  assert.equal(summary, "today, 3 to 5 pm Sydney time, Court 1, 2 hours.");
  assert.doesNotMatch(summary, /\d{2}:\d{2}|2027-|[\p{Script=Han}]/u);
});

test("midnight, noon, and bookings crossing midnight have unambiguous local endpoints", () => {
  assert.equal(
    spokenRange("2026-11-12T01:00:00Z", "2026-11-12T03:00:00Z"),
    "noon to 2 pm",
  );
  assert.equal(
    spokenRange("2026-11-12T13:00:00Z", "2026-11-12T15:00:00Z"),
    "midnight to 2 am",
  );
  assert.equal(
    spokenRange("2026-11-12T12:00:00Z", "2026-11-12T14:00:00Z"),
    "11 pm to 1 am the next day",
  );
});

test("DST summaries derive local endpoints from real instants and keep actual booked duration", () => {
  const spring = spokenBookingSummary(
    {
      courtId: 2,
      startsAt: "2027-10-02T15:00:00Z", // 01:00 AEST, just before the skipped hour.
      endsAt: "2027-10-02T17:00:00Z", // 04:00 AEDT, two real hours later.
      durationHours: 2,
    },
    now,
  );
  assert.match(spring, /1 to 4 am Sydney time, Court 2, 2 hours/);
  const autumn = spokenBookingSummary(
    {
      courtId: 1,
      startsAt: "2027-04-03T13:00:00Z", // 00:00 AEDT, before the repeated hour.
      endsAt: "2027-04-03T17:00:00Z", // 03:00 AEST, four real hours later.
      durationHours: 4,
    },
    now,
  );
  assert.match(autumn, /midnight to 3 am Sydney time, Court 1, 4 hours/);
});

test("credentials retain leading zeroes in short English digit groups", () => {
  assert.equal(
    spokenAccessCode("0123456789"),
    "zero one two three, four five six seven, eight nine",
  );
  assert.equal(
    spokenAccessCode("01234567"),
    "zero one two three, four five six seven",
  );
  assert.equal(
    spokenAccessCode("+61400123456"),
    "plus six one four zero, zero one two three, four five six",
  );
});

test("availability ranges and durations use ordinary English", () => {
  assert.equal(spokenHourRange(15, 17), "3 to 5 pm");
  assert.equal(spokenHourRange(11, 14), "11 am to 2 pm");
  assert.equal(spokenHourRange(0), "midnight");
  assert.equal(spokenHourRange(12), "noon");
  assert.equal(spokenDuration(1), "1 hour");
  assert.equal(spokenDuration(8), "8 hours");
});

test("minute precision and a next-day midnight endpoint remain explicit", () => {
  assert.equal(
    spokenRange("2026-11-12T04:30:00Z", "2026-11-12T06:30:00Z"),
    "3:30 to 5:30 pm",
  );
  assert.equal(
    spokenRange("2026-12-31T12:00:00Z", "2026-12-31T13:00:00Z"),
    "11 pm to midnight the next day",
  );
});
