import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { AvailabilitySlot, BookingInput } from "../lib/domain";
import {
  AppError,
  cancelBooking,
  closeDatabase,
  createBooking,
  getAvailability,
  listBookings,
  updateBooking,
} from "../lib/store";

const date = "2031-02-01";
const originalDatabasePath = process.env.BOOKING_DB_PATH;

beforeEach(() => {
  closeDatabase();
  process.env.BOOKING_DB_PATH = ":memory:";
});

after(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete process.env.BOOKING_DB_PATH;
  else process.env.BOOKING_DB_PATH = originalDatabasePath;
});

function input(startLocal: string, durationHours?: number): BookingInput {
  return {
    courtId: 1,
    startLocal,
    customerName: "时段测试球友",
    email: "hourly-player@example.com",
    durationHours,
  };
}

function hour(
  hourNumber: number,
  durationHours = 2,
  selectedDate = date,
  courtId = 1,
): AvailabilitySlot {
  const slot = getAvailability(selectedDate, durationHours).slots.find(
    (candidate) =>
      candidate.courtId === courtId &&
      candidate.startLocal ===
        `${selectedDate}T${String(hourNumber).padStart(2, "0")}:00`,
  );
  assert.ok(
    slot,
    "the hourly schedule must retain every local clock-hour entry",
  );
  return slot;
}

test("a free hour before a booking remains unoccupied even when two hours will not fit", () => {
  createBooking(input(`${date}T08:00`));

  const seven = hour(7);
  assert.equal(seven.occupied, false);
  assert.equal(seven.maxDurationHours, 1);
  assert.equal(seven.available, false);
  assert.ok(seven.reason, "a short free window needs an explanatory reason");

  for (const hourNumber of [8, 9]) {
    const booked = hour(hourNumber);
    assert.equal(booked.occupied, true);
    assert.equal(booked.maxDurationHours, 0);
    assert.equal(booked.available, false);
    assert.ok(booked.reason);
    assert.notEqual(seven.reason, booked.reason);
  }

  for (const hourNumber of [6, 10]) {
    const free = hour(hourNumber);
    assert.equal(free.occupied, false);
    assert.ok(free.maxDurationHours >= 2);
    assert.equal(free.available, true);
  }
});

test("selected duration changes bookability without changing actual hourly occupancy", () => {
  createBooking(input(`${date}T08:00`));

  const oneHour = hour(7, 1);
  const twoHours = hour(7, 2);
  assert.equal(oneHour.available, true);
  assert.equal(twoHours.available, false);
  assert.equal(oneHour.occupied, false);
  assert.equal(twoHours.occupied, false);
  assert.equal(oneHour.maxDurationHours, 1);
  assert.equal(twoHours.maxDurationHours, 1);

  const six = hour(6, 3);
  assert.equal(six.occupied, false);
  assert.equal(six.maxDurationHours, 2);
  assert.equal(six.available, false);
  assert.equal(hour(6, 2).available, true);
});

test("a one-hour reservation fits before the existing booking while two hours conflict", () => {
  createBooking(input(`${date}T08:00`));
  assert.throws(
    () => createBooking(input(`${date}T07:00`, 2)),
    (error: unknown) => error instanceof AppError && error.status === 409,
  );
  const shortBooking = createBooking(input(`${date}T07:00`, 1));
  assert.equal(shortBooking.booking.durationHours, 1);
  assert.equal(shortBooking.booking.status, "confirmed");
  assert.equal(hour(7, 1).occupied, true);
  assert.equal(hour(7, 1).maxDurationHours, 0);
});

test("one court's booking does not occupy the other court and free windows are capped at eight hours", () => {
  createBooking(input(`${date}T08:00`));

  for (const hourNumber of [7, 8, 9]) {
    const otherCourt = hour(hourNumber, 2, date, 2);
    assert.equal(otherCourt.occupied, false);
    assert.equal(otherCourt.available, true);
    assert.equal(otherCourt.maxDurationHours, 8);
  }
  for (const hourNumber of [10, 20, 23]) {
    assert.equal(hour(hourNumber).maxDurationHours, 8);
  }
});

test("a following-day booking limits a free hour before midnight without marking it occupied", () => {
  createBooking(input("2031-02-02T00:00"));

  const lastHour = hour(23);
  assert.equal(lastHour.occupied, false);
  assert.equal(lastHour.maxDurationHours, 1);
  assert.equal(lastHour.available, false);
  assert.equal(hour(23, 1).available, true);
  assert.equal(hour(22).maxDurationHours, 2);
  assert.equal(hour(22).available, true);
  assert.equal(hour(0, 2, "2031-02-02").occupied, true);

  assert.equal(
    createBooking(input(`${date}T23:00`, 1)).booking.status,
    "confirmed",
  );
});

test("canceling a booking immediately restores its hours and the preceding free window", () => {
  const { booking, accessCode } = createBooking(input(`${date}T08:00`));
  assert.equal(hour(7).maxDurationHours, 1);
  assert.equal(hour(8).occupied, true);

  cancelBooking(booking.id, booking.version, accessCode);

  for (const hourNumber of [7, 8, 9]) {
    const released = hour(hourNumber);
    assert.equal(released.occupied, false);
    assert.equal(released.maxDurationHours, 8);
    assert.equal(released.available, true);
  }
  assert.equal(listBookings(date)[0].status, "cancelled");
});

test("moving a booking recalculates both its old and new neighboring windows immediately", () => {
  const { booking, accessCode } = createBooking(input(`${date}T08:00`));
  assert.equal(hour(7).maxDurationHours, 1);

  updateBooking(
    booking.id,
    { ...input(`${date}T14:00`), version: booking.version },
    accessCode,
  );

  assert.equal(hour(7).maxDurationHours, 7);
  assert.equal(hour(7).available, true);
  assert.equal(hour(8).occupied, false);
  assert.equal(hour(8).maxDurationHours, 6);
  assert.equal(hour(13).occupied, false);
  assert.equal(hour(13).maxDurationHours, 1);
  assert.equal(hour(13).available, false);
  assert.equal(hour(14).occupied, true);
  assert.equal(hour(14).maxDurationHours, 0);
  assert.equal(hour(14, 2, date, 2).maxDurationHours, 8);
});

test("past hours retain their reason and cannot offer any reservable duration", () => {
  const availability = getAvailability("2020-02-01");
  assert.equal(availability.slots.length, 48);
  for (const slot of availability.slots) {
    assert.equal(slot.available, false);
    assert.equal(slot.maxDurationHours, 0);
    assert.ok(slot.reason);
  }
});

test("missing or repeated Sydney daylight-saving hours offer no reservable duration", () => {
  for (const selectedDate of ["2031-04-06", "2031-10-05"]) {
    for (const courtId of [1, 2]) {
      const invalidHour = hour(2, 2, selectedDate, courtId);
      assert.equal(invalidHour.available, false);
      assert.equal(invalidHour.maxDurationHours, 0);
      assert.ok(invalidHour.reason);
    }
  }
});
