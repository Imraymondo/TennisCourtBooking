import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import type { BookingInput } from "../lib/domain";

let store: typeof import("../lib/store");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "courtside-store-test-"));
const databasePath = join(temporaryDirectory, "bookings.sqlite");

before(async () => {
  process.env.BOOKING_DB_PATH = databasePath;
  store = await import("../lib/store");
});

after(() => {
  store.closeDatabase();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function input(startLocal: string, courtId = 1): BookingInput {
  return {
    courtId,
    startLocal,
    customerName: "测试球友",
    email: "player@example.com",
    phone: "+61412345678",
    source: "web",
  };
}

function throwsStatus(operation: () => unknown, status: number) {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok("status" in error);
    assert.equal(error.status, status, error.message);
    return true;
  });
}

test("both courts offer 24 hourly starts, including overnight starts", () => {
  const availability = store.getAvailability("2030-01-06");
  assert.equal(availability.timeZone, "Australia/Sydney");
  assert.equal(availability.durationHours, 2);
  assert.deepEqual(
    availability.courts.map((court) => court.id),
    [1, 2],
  );
  assert.equal(availability.slots.length, 48);
  for (const courtId of [1, 2]) {
    const slots = availability.slots.filter((slot) => slot.courtId === courtId);
    assert.equal(slots.length, 24);
    assert.ok(slots.every((slot) => slot.available));
    const overnight = slots.find((slot) => slot.startLocal.endsWith("T23:00"));
    assert.ok(overnight?.startsAt && overnight.endsAt);
    assert.equal(
      Date.parse(overnight.endsAt) - Date.parse(overnight.startsAt),
      2 * 60 * 60 * 1000,
    );
  }
});

test("creation defaults to two hours and returns a private management code", () => {
  const { booking, accessCode } = store.createBooking(
    input("2030-01-07T10:00"),
  );
  assert.match(booking.id, /^\d{8}$/);
  assert.match(accessCode, /^\d{10}$/);
  assert.equal(booking.durationHours, 2);
  assert.equal(booking.status, "confirmed");
  assert.equal(booking.source, "web");
  assert.equal(
    Date.parse(booking.endsAt) - Date.parse(booking.startsAt),
    7_200_000,
  );
  assert.equal(
    store.getBooking(booking.id, accessCode).customerName,
    "测试球友",
  );
  assert.equal(
    store.listBookings("2030-01-07").filter((row) => row.id === booking.id)
      .length,
    1,
  );
});

test("overlap is rejected for one court while adjacent and other-court bookings work", () => {
  store.createBooking(input("2030-01-08T10:00"));
  throwsStatus(() => store.createBooking(input("2030-01-08T11:00")), 409);
  throwsStatus(
    () =>
      store.createBooking({ ...input("2030-01-08T09:00"), durationHours: 4 }),
    409,
  );
  assert.equal(
    store.createBooking(input("2030-01-08T12:00")).booking.status,
    "confirmed",
  );
  assert.equal(
    store.createBooking(input("2030-01-08T10:00", 2)).booking.status,
    "confirmed",
  );
});

test("cross-midnight bookings block the following day and appear in its schedule", () => {
  const { booking } = store.createBooking(input("2030-01-09T23:00"));
  throwsStatus(() => store.createBooking(input("2030-01-10T00:00")), 409);
  const nextDay = store.getAvailability("2030-01-10");
  assert.ok(nextDay.courts[0].bookings.some((row) => row.id === booking.id));
  assert.equal(
    nextDay.slots.find(
      (slot) => slot.courtId === 1 && slot.startLocal.endsWith("T00:00"),
    )?.available,
    false,
  );
  assert.equal(
    nextDay.slots.find(
      (slot) => slot.courtId === 1 && slot.startLocal.endsWith("T01:00"),
    )?.available,
    true,
  );
});

test("only a management code or staff authorization can reveal a booking", () => {
  const created = store.createBooking(input("2030-01-11T08:00"));
  throwsStatus(() => store.getBooking(created.booking.id), 404);
  throwsStatus(() => store.getBooking(created.booking.id, "0000000000"), 404);
  assert.equal(
    store.getBooking(created.booking.id, undefined, true).email,
    "player@example.com",
  );
  throwsStatus(() => store.getBooking("99999999", "0000000000"), 404);
});

test("updates move a booking atomically and stale edits cannot overwrite it", () => {
  const { booking, accessCode } = store.createBooking(
    input("2030-01-12T10:00"),
  );
  const updated = store.updateBooking(
    booking.id,
    { ...input("2030-01-12T14:00", 2), version: booking.version },
    accessCode,
  );
  assert.equal(updated.courtId, 2);
  assert.equal(updated.version, booking.version + 1);
  throwsStatus(
    () =>
      store.updateBooking(
        booking.id,
        { ...input("2030-01-12T16:00"), version: booking.version },
        accessCode,
      ),
    409,
  );
  assert.equal(
    store.getBooking(booking.id, accessCode).startsAt,
    updated.startsAt,
  );
  store.createBooking(input("2030-01-12T10:00"));
  throwsStatus(
    () =>
      store.updateBooking(
        booking.id,
        { ...input("2030-01-12T10:00"), version: updated.version },
        accessCode,
      ),
    409,
  );
  assert.equal(
    store.getBooking(booking.id, accessCode).startsAt,
    updated.startsAt,
    "failed edits must preserve the original slot",
  );
});

test("canceling frees a slot, preserves the record, and prevents later edits", () => {
  const { booking, accessCode } = store.createBooking(
    input("2030-01-13T10:00"),
  );
  throwsStatus(
    () => store.cancelBooking(booking.id, booking.version, "0000000000"),
    404,
  );
  const cancelled = store.cancelBooking(
    booking.id,
    booking.version,
    accessCode,
  );
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.version, booking.version + 1);
  assert.equal(store.getBooking(booking.id, accessCode).status, "cancelled");
  assert.ok(
    store
      .listBookings("2030-01-13")
      .some((row) => row.id === booking.id && row.status === "cancelled"),
  );
  assert.ok(
    !store
      .getAvailability("2030-01-13")
      .courts[0].bookings.some((row) => row.id === booking.id),
  );
  assert.equal(
    store.createBooking(input("2030-01-13T10:00")).booking.status,
    "confirmed",
  );
  throwsStatus(
    () =>
      store.updateBooking(
        booking.id,
        { ...input("2030-01-13T14:00"), version: cancelled.version },
        accessCode,
      ),
    409,
  );
});

test("public schedules include customer names without exposing contact or secret fields", () => {
  const { booking, accessCode } = store.createBooking(
    input("2030-01-14T10:00"),
  );
  const publicBooking = store
    .getAvailability("2030-01-14")
    .courts[0].bookings.find((row) => row.id === booking.id);
  assert.ok(publicBooking);
  assert.equal(publicBooking.customerName, "测试球友");
  assert.deepEqual(
    Object.keys(publicBooking).sort(),
    ["courtId", "customerName", "endsAt", "id", "startsAt"].sort(),
  );
  const payload = JSON.stringify(store.getAvailability("2030-01-14"));
  assert.ok(!payload.includes("player@example.com"));
  assert.ok(!payload.includes("+61412345678"));
  assert.ok(!payload.includes(accessCode));
});

test("invalid courts, names, contacts, dates, past starts and durations are rejected", () => {
  const base = input("2030-01-15T10:00");
  const invalid: BookingInput[] = [
    { ...base, courtId: 3 },
    { ...base, courtId: 0 },
    { ...base, customerName: " " },
    { ...base, customerName: "长".repeat(81) },
    { ...base, email: "", phone: "" },
    { ...base, email: "invalid", phone: "" },
    { ...base, email: "", phone: "abc" },
    { ...base, email: "", phone: "------" },
    { ...base, durationHours: 0 },
    { ...base, durationHours: 9 },
    { ...base, durationHours: 1.5 },
    { ...base, startLocal: "2030-02-30T10:00" },
    { ...base, startLocal: "2030-01-15T10:30" },
    { ...base, startLocal: "invalid" },
    { ...base, startLocal: "2020-01-15T10:00" },
  ];
  for (const value of invalid)
    throwsStatus(() => store.createBooking(value), 400);
  throwsStatus(() => store.getAvailability("2030-02-30"), 400);
  throwsStatus(() => store.getAvailability("2030-01-15", 0), 400);
});

test("Sydney DST gaps and repeated local hours are rejected instead of guessing", () => {
  throwsStatus(() => store.createBooking(input("2030-10-06T02:00")), 400);
  throwsStatus(() => store.createBooking(input("2030-04-07T02:00")), 400);
  for (const date of ["2030-10-06", "2030-04-07"]) {
    const availability = store.getAvailability(date);
    for (const courtId of [1, 2]) {
      const ambiguousOrMissing = availability.slots.find(
        (slot) =>
          slot.courtId === courtId && slot.startLocal.endsWith("T02:00"),
      );
      assert.equal(ambiguousOrMissing?.available, false);
      assert.ok(ambiguousOrMissing?.reason);
    }
  }
});

test("committed bookings are visible to a fresh process using the same database", () => {
  const { booking } = store.createBooking(input("2030-01-16T10:00"));
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      "const { listBookings } = require('./lib/store.ts'); console.log(JSON.stringify(listBookings('2030-01-16')));",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, BOOKING_DB_PATH: databasePath },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const persisted = JSON.parse(output) as { id: string; status: string }[];
  assert.ok(
    persisted.some(
      (row) => row.id === booking.id && row.status === "confirmed",
    ),
  );
});

test("simultaneous processes cannot reserve the same court and time twice", async () => {
  const run = promisify(execFile);
  const command = `
    const { createBooking } = require('./lib/store.ts');
    try {
      createBooking(${JSON.stringify(input("2030-01-17T10:00"))});
      console.log(JSON.stringify({ status: 201 }));
    } catch (error) {
      if (error.status !== 409) throw error;
      console.log(JSON.stringify({ status: error.status }));
    }
  `;
  const results = await Promise.all(
    [1, 2].map(() =>
      run(process.execPath, ["--import", "tsx", "--eval", command], {
        cwd: process.cwd(),
        env: { ...process.env, BOOKING_DB_PATH: databasePath },
        encoding: "utf8",
      }),
    ),
  );
  const statuses = results
    .map(({ stdout }) => (JSON.parse(stdout) as { status: number }).status)
    .sort();
  assert.deepEqual(statuses, [201, 409]);
  assert.equal(store.listBookings("2030-01-17").length, 1);
});
