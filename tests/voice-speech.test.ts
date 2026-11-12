import assert from "node:assert/strict";
import { test } from "node:test";
import {
  spokenAccessCode,
  spokenBookingSummary,
  spokenDate,
  spokenRange,
} from "../lib/channels/voice-speech";

const now = new Date("2026-12-31T13:30:00Z"); // Already January 1 in Sydney.

test("relative booking dates follow Sydney's calendar across the new year", () => {
  assert.equal(spokenDate("2027-01-01", now), "今天");
  assert.equal(spokenDate("2027-01-02", now), "明天");
  assert.equal(spokenDate("2027-01-03", now), "后天");
  assert.equal(spokenDate("2027-01-05", now), "一月五日");
  assert.equal(spokenDate("2028-01-05", now), "二零二八年一月五日");
  // Keep the relative wording even when tomorrow is in a different year.
  assert.equal(
    spokenDate("2027-01-01", new Date("2026-12-31T00:00:00Z")),
    "明天",
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
  assert.equal(summary, "今天悉尼时间下午三点到五点，1号场，两小时。");
  assert.doesNotMatch(summary, /\d{2}:\d{2}|2027-|开始|结束/);
});

test("midnight, noon, and bookings crossing midnight have unambiguous local endpoints", () => {
  assert.equal(
    spokenRange("2026-11-12T01:00:00Z", "2026-11-12T03:00:00Z"),
    "中午十二点到下午两点",
  );
  assert.equal(
    spokenRange("2026-11-12T13:00:00Z", "2026-11-12T15:00:00Z"),
    "凌晨零点到两点",
  );
  assert.equal(
    spokenRange("2026-11-12T12:00:00Z", "2026-11-12T14:00:00Z"),
    "晚上十一点到第二天凌晨一点",
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
  assert.match(spring, /凌晨一点到四点，2号场，两小时/);
  const autumn = spokenBookingSummary(
    {
      courtId: 1,
      startsAt: "2027-04-03T13:00:00Z", // 00:00 AEDT, before the repeated hour.
      endsAt: "2027-04-03T17:00:00Z", // 03:00 AEST, four real hours later.
      durationHours: 4,
    },
    now,
  );
  assert.match(autumn, /凌晨零点到三点，1号场，四小时/);
});

test("credentials retain leading zeroes in short Chinese digit groups", () => {
  assert.equal(spokenAccessCode("0123456789"), "零一二三，四五六七，八九");
  assert.equal(spokenAccessCode("01234567"), "零一二三，四五六七");
  assert.equal(
    spokenAccessCode("+61400123456"),
    "加六一四零，零一二三，四五六",
  );
});
