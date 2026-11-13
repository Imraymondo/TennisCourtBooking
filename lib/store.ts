import { DatabaseSync } from "node:sqlite";
import { randomInt, createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { attendanceRecipient, type AttendanceCallStatus } from "./attendance";
import {
  COURTS,
  TIME_ZONE,
  type Availability,
  type Booking,
  type BookingInput,
  type Channel,
} from "./domain";
import {
  AppError,
  bookingTimes,
  dayBounds,
  validateDate,
  validateDuration,
} from "./time";

export { AppError } from "./time";

let database: DatabaseSync | undefined;
let databasePath: string | undefined;
let transactionDepth = 0;
let savepointNumber = 0;

export function closeDatabase() {
  database?.close();
  database = undefined;
  databasePath = undefined;
}

export function getDatabase(): DatabaseSync {
  const filename =
    process.env.BOOKING_DB_PATH ||
    path.join(process.cwd(), ".data", "bookings.sqlite");
  if (database && filename === databasePath) return database;
  if (database) database.close();
  if (filename !== ":memory:")
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  database = new DatabaseSync(filename);
  if (filename !== ":memory:") chmodSync(filename, 0o600);
  databasePath = filename;
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      court_id INTEGER NOT NULL CHECK (court_id IN (1, 2)),
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      duration_hours INTEGER NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
      access_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS booking_overlap ON bookings(court_id, status, starts_at, ends_at);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS phone_booking_sms_outbox (
      id TEXT PRIMARY KEY,
      call_sid TEXT NOT NULL,
      booking_id TEXT NOT NULL REFERENCES bookings(id),
      booking_snapshot TEXT NOT NULL,
      access_code TEXT NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'submitted', 'failed', 'unknown')),
      message_sid TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS phone_booking_sms_call ON phone_booking_sms_outbox(call_sid, booking_id);
    CREATE TABLE IF NOT EXISTS attendance_calls (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id),
      booking_version INTEGER NOT NULL,
      booking_snapshot TEXT NOT NULL,
      account_sid TEXT NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      callback_origin TEXT NOT NULL,
      submission_status TEXT NOT NULL CHECK (submission_status IN ('pending', 'processing', 'submitted', 'failed', 'unknown')),
      status TEXT NOT NULL,
      call_sid TEXT UNIQUE,
      phase TEXT NOT NULL CHECK (phase IN ('initial', 'attendance', 'confirm', 'done')),
      turn TEXT,
      unclear_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attendance_booking ON attendance_calls(booking_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS attendance_call_requests (
      request_id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      booking_version INTEGER NOT NULL,
      attempt_id TEXT NOT NULL REFERENCES attendance_calls(id)
    );
  `);
  return database;
}

function transaction<T>(work: (db: DatabaseSync) => T): T {
  const db = getDatabase();
  const nested = transactionDepth > 0;
  const savepoint = `nested_${++savepointNumber}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  transactionDepth += 1;
  try {
    const value = work(db);
    db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return value;
  } catch (error) {
    db.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : "ROLLBACK");
    if (nested) db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  } finally {
    transactionDepth -= 1;
  }
}

type Row = Record<string, string | number | bigint | Uint8Array | null>;

function toBooking(row: Row): Booking {
  return {
    id: String(row.id),
    courtId: Number(row.court_id),
    customerName: String(row.customer_name),
    email: String(row.email),
    phone: String(row.phone),
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    durationHours: Number(row.duration_hours),
    source: row.source as Channel,
    status: row.status as Booking["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
  };
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function authorizedRow(id: string, accessCode?: string, admin = false): Row {
  if (typeof id !== "string" || !/^\d{8}$/.test(id))
    throw new AppError("Incorrect booking number or access code.", 404);
  const row = getDatabase()
    .prepare("SELECT * FROM bookings WHERE id = ?")
    .get(id) as Row | undefined;
  if (
    !row ||
    (!admin &&
      (typeof accessCode !== "string" ||
        !/^\d{10}$/.test(accessCode) ||
        !safeEqual(String(row.access_hash), hash(accessCode))))
  ) {
    throw new AppError("Incorrect booking number or access code.", 404);
  }
  return row;
}

function validatedInput(input: BookingInput) {
  if (!input || typeof input !== "object")
    throw new AppError("Invalid booking details.");
  if (input.courtId !== 1 && input.courtId !== 2)
    throw new AppError("Please select Court 1 or Court 2.");
  if (
    typeof input.customerName !== "string" ||
    !input.customerName.trim() ||
    input.customerName.trim().length > 80 ||
    /[\x00-\x1f]/.test(input.customerName)
  ) {
    throw new AppError("Name must be 1 to 80 characters.");
  }
  if (input.email !== undefined && typeof input.email !== "string")
    throw new AppError("Invalid email address.");
  if (input.phone !== undefined && typeof input.phone !== "string")
    throw new AppError("Invalid phone number.");
  const email = (input.email || "").trim();
  const phone = (input.phone || "").trim();
  if (
    email.length > 254 ||
    (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  )
    throw new AppError("Invalid email address.");
  if (
    phone.length > 32 ||
    (phone &&
      (!/^\+?[\d ()-]{6,32}$/.test(phone) ||
        phone.replace(/\D/g, "").length < 6))
  )
    throw new AppError("Invalid phone number.");
  if (!phone && !email)
    throw new AppError("Please provide a phone number or email address.");
  const source = input.source ?? "web";
  if (!["web", "phone", "sms", "email", "staff"].includes(source))
    throw new AppError("Invalid booking source.");
  return {
    courtId: input.courtId,
    customerName: input.customerName.trim(),
    email,
    phone,
    source,
    ...bookingTimes(input.startLocal, input.durationHours),
  };
}

function assertNoOverlap(
  db: DatabaseSync,
  courtId: number,
  startsAt: string,
  endsAt: string,
  excluding = "",
) {
  const conflict = db
    .prepare(
      "SELECT id FROM bookings WHERE court_id = ? AND status = 'confirmed' AND starts_at < ? AND ends_at > ? AND id != ? LIMIT 1",
    )
    .get(courtId, endsAt, startsAt, excluding);
  if (conflict) throw new AppError("That time slot is already booked.", 409);
}

export function createBooking(input: BookingInput): {
  booking: Booking;
  accessCode: string;
} {
  const value = validatedInput(input);
  return transaction((db) => {
    assertNoOverlap(db, value.courtId, value.startsAt, value.endsAt);
    let id: string;
    do {
      id = String(randomInt(10_000_000, 100_000_000));
    } while (db.prepare("SELECT id FROM bookings WHERE id = ?").get(id));
    const accessCode = String(randomInt(0, 10_000_000_000)).padStart(10, "0");
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO bookings (id, court_id, customer_name, email, phone, starts_at, ends_at, duration_hours, source, status, access_hash, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, 1)",
    ).run(
      id,
      value.courtId,
      value.customerName,
      value.email,
      value.phone,
      value.startsAt,
      value.endsAt,
      value.durationHours,
      value.source,
      hash(accessCode),
      now,
      now,
    );
    return {
      booking: toBooking(
        db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as Row,
      ),
      accessCode,
    };
  });
}

export function getBooking(
  id: string,
  accessCode?: string,
  admin = false,
): Booking {
  return toBooking(authorizedRow(id, accessCode, admin));
}

function validateVersion(version: unknown) {
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1)
    throw new AppError(
      "Invalid booking version. Please refresh and try again.",
    );
}

export function updateBooking(
  id: string,
  input: BookingInput & { version: number },
  accessCode?: string,
  admin = false,
): Booking {
  const value = validatedInput(input);
  validateVersion(input.version);
  return transaction((db) => {
    const old = authorizedRow(id, accessCode, admin);
    if (old.status === "cancelled")
      throw new AppError("Cancelled bookings cannot be changed.", 409);
    if (Number(old.version) !== input.version)
      throw new AppError(
        "This booking has been updated. Please refresh and try again.",
        409,
      );
    assertNoOverlap(db, value.courtId, value.startsAt, value.endsAt, id);
    db.prepare(
      "UPDATE bookings SET court_id = ?, customer_name = ?, email = ?, phone = ?, starts_at = ?, ends_at = ?, duration_hours = ?, updated_at = ?, version = version + 1 WHERE id = ?",
    ).run(
      value.courtId,
      value.customerName,
      value.email,
      value.phone,
      value.startsAt,
      value.endsAt,
      value.durationHours,
      new Date().toISOString(),
      id,
    );
    return toBooking(
      db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as Row,
    );
  });
}

export function cancelBooking(
  id: string,
  version: number,
  accessCode?: string,
  admin = false,
): Booking {
  validateVersion(version);
  return transaction((db) => {
    const old = authorizedRow(id, accessCode, admin);
    if (old.status === "cancelled") return toBooking(old);
    if (Number(old.version) !== version)
      throw new AppError(
        "This booking has been updated. Please refresh and try again.",
        409,
      );
    db.prepare(
      "UPDATE bookings SET status = 'cancelled', updated_at = ?, version = version + 1 WHERE id = ?",
    ).run(new Date().toISOString(), id);
    return toBooking(
      db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as Row,
    );
  });
}

export function listBookings(date?: string): Booking[] {
  const db = getDatabase();
  if (date) {
    const bounds = dayBounds(date);
    return (
      db
        .prepare(
          "SELECT * FROM bookings WHERE starts_at < ? AND ends_at > ? ORDER BY starts_at, court_id",
        )
        .all(bounds.endsAt, bounds.startsAt) as Row[]
    ).map(toBooking);
  }
  return (
    db
      .prepare("SELECT * FROM bookings ORDER BY starts_at DESC LIMIT 1000")
      .all() as Row[]
  ).map(toBooking);
}

export function getAvailability(
  dateValue: string,
  durationHours = 2,
): Availability {
  const date = validateDate(dateValue);
  validateDuration(durationHours);
  const bounds = dayBounds(date);
  const dayStart = Date.parse(bounds.startsAt);
  const dayEnd = Date.parse(bounds.endsAt);
  // A late-night start can run into tomorrow. Load the full supported eight-hour
  // horizon once so both occupancy and duration checks use the same snapshot.
  const horizon = new Date(dayEnd + 8 * 3_600_000).toISOString();
  const nearby = (
    getDatabase()
      .prepare(
        "SELECT * FROM bookings WHERE status = 'confirmed' AND starts_at < ? AND ends_at > ? ORDER BY starts_at",
      )
      .all(horizon, bounds.startsAt) as Row[]
  ).map(toBooking);
  const active = nearby.filter(
    (booking) =>
      Date.parse(booking.startsAt) < dayEnd &&
      Date.parse(booking.endsAt) > dayStart,
  );
  const now = Date.now();
  const slots = COURTS.flatMap((court) =>
    Array.from({ length: 24 }, (_, hour) => {
      const startLocal = `${date}T${String(hour).padStart(2, "0")}:00`;
      try {
        const times = bookingTimes(startLocal, durationHours, false);
        const startsAt = Date.parse(times.startsAt);
        const past = startsAt <= now;
        const overlaps = (hours: number) => {
          const endsAt = startsAt + hours * 3_600_000;
          return nearby.some(
            (booking) =>
              booking.courtId === court.id &&
              Date.parse(booking.startsAt) < endsAt &&
              Date.parse(booking.endsAt) > startsAt,
          );
        };
        // Occupancy describes this hour itself, independently of the duration
        // selected in the booking form. Intervals remain half-open [start, end).
        const occupied = overlaps(1);
        let maxDurationHours = 0;
        if (!past) {
          for (let hours = 1; hours <= 8; hours++) {
            if (overlaps(hours)) break;
            maxDurationHours = hours;
          }
        }
        const available = !past && maxDurationHours >= durationHours;
        return {
          courtId: court.id,
          startLocal,
          startsAt: times.startsAt,
          endsAt: times.endsAt,
          available,
          occupied,
          maxDurationHours,
          reason: past
            ? "Past time"
            : occupied
              ? "Booked"
              : !available
                ? `Less than ${durationHours} hours available`
                : undefined,
        };
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return {
          courtId: court.id,
          startLocal,
          available: false,
          occupied: false,
          maxDurationHours: 0,
          reason: "Hour missing or repeated due to daylight saving",
        };
      }
    }),
  );
  return {
    date,
    timeZone: TIME_ZONE,
    durationHours,
    courts: COURTS.map((court) => ({
      id: court.id,
      name: court.name,
      bookings: active
        .filter((b) => b.courtId === court.id)
        .map(({ id, courtId, startsAt, endsAt, customerName }) => ({
          id,
          courtId,
          startsAt,
          endsAt,
          customerName,
        })),
    })),
    slots,
  };
}

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  transaction((db) => {
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?").run(
      now - Math.max(windowMs, 86_400_000),
    );
    const row = db
      .prepare("SELECT window_start, count FROM rate_limits WHERE key = ?")
      .get(key) as Row | undefined;
    if (!row || Number(row.window_start) <= now - windowMs) {
      db.prepare(
        "INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)",
      ).run(key, now);
    } else {
      if (Number(row.count) >= limit)
        throw new AppError("Too many requests. Please try again later.", 429);
      db.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").run(
        key,
      );
    }
  });
}

export function getChannelEvent(id: string): string | null {
  const row = getDatabase()
    .prepare("SELECT payload FROM channel_events WHERE id = ?")
    .get(id);
  return row ? String(row.payload) : null;
}

export function saveChannelEvent(id: string, payload: string): void {
  getDatabase()
    .prepare(
      "INSERT OR IGNORE INTO channel_events (id, payload, created_at) VALUES (?, ?, ?)",
    )
    .run(id, payload, Date.now());
}

export function runChannelEvent<T>(key: string, operation: () => T): T {
  return transaction(() => {
    const old = getChannelEvent(key);
    if (old !== null) return JSON.parse(old) as T;
    const value = operation();
    saveChannelEvent(key, JSON.stringify(value));
    return value;
  });
}

export function getChannelState(key: string): string | null {
  const row = getDatabase()
    .prepare("SELECT value FROM channel_state WHERE key = ? AND expires_at > ?")
    .get(key, Date.now());
  return row ? String(row.value) : null;
}

export function setChannelState(
  key: string,
  value: string | null,
  ttlMs = 60 * 60 * 1000,
): void {
  const db = getDatabase();
  db.prepare("DELETE FROM channel_state WHERE expires_at <= ?").run(Date.now());
  if (value === null)
    db.prepare("DELETE FROM channel_state WHERE key = ?").run(key);
  else
    db.prepare(
      "INSERT OR REPLACE INTO channel_state (key, value, expires_at) VALUES (?, ?, ?)",
    ).run(key, value, Date.now() + ttlMs);
}

export function claimChannelState(
  key: string,
  value: string,
  ttlMs: number,
): boolean {
  const now = Date.now();
  const result = getDatabase()
    .prepare(
      "INSERT INTO channel_state (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at WHERE channel_state.expires_at <= ?",
    )
    .run(key, value, now + ttlMs, now);
  return Number(result.changes) > 0;
}

export type PhoneBookingSmsStatus =
  | "pending"
  | "processing"
  | "submitted"
  | "failed"
  | "unknown";

export type PhoneBookingSmsOutbox = {
  id: string;
  callSid: string;
  booking: Booking;
  accessCode: string;
  sender: string;
  recipient: string;
  body: string;
  status: PhoneBookingSmsStatus;
  messageSid: string | null;
  createdAt: number;
  updatedAt: number;
};

function toPhoneBookingSms(row: Row): PhoneBookingSmsOutbox {
  return {
    id: String(row.id),
    callSid: String(row.call_sid),
    booking: JSON.parse(String(row.booking_snapshot)) as Booking,
    accessCode: String(row.access_code),
    sender: String(row.sender),
    recipient: String(row.recipient),
    body: String(row.body),
    status: row.status as PhoneBookingSmsStatus,
    messageSid: row.message_sid === null ? null : String(row.message_sid),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// Called synchronously alongside booking creation, so an enclosing channel-event
// transaction commits (or rolls back) both the booking and its private receipt.
export function savePhoneBookingSmsOutbox(
  value: Pick<
    PhoneBookingSmsOutbox,
    "callSid" | "booking" | "accessCode" | "sender" | "recipient" | "body"
  >,
): boolean {
  const id = `phone-booking:${value.booking.id}:created`;
  const now = Date.now();
  const db = getDatabase();
  db.prepare(
    "INSERT OR IGNORE INTO phone_booking_sms_outbox (id, call_sid, booking_id, booking_snapshot, access_code, sender, recipient, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
  ).run(
    id,
    value.callSid,
    value.booking.id,
    JSON.stringify(value.booking),
    value.accessCode,
    value.sender,
    value.recipient,
    value.body,
    now,
    now,
  );
  const row = db
    .prepare("SELECT call_sid FROM phone_booking_sms_outbox WHERE id = ?")
    .get(id);
  return row?.call_sid === value.callSid;
}

export function getPhoneBookingSmsOutbox(
  callSid: string,
  bookingId: string,
): PhoneBookingSmsOutbox | null {
  const row = getDatabase()
    .prepare(
      "SELECT * FROM phone_booking_sms_outbox WHERE call_sid = ? AND booking_id = ?",
    )
    .get(callSid, bookingId) as Row | undefined;
  return row ? toPhoneBookingSms(row) : null;
}

// A persistent, atomic claim prevents another process from submitting the same
// receipt. Processing rows are never returned to pending after an uncertain send.
export function claimPhoneBookingSmsOutbox(id: string): boolean {
  const result = getDatabase()
    .prepare(
      "UPDATE phone_booking_sms_outbox SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'",
    )
    .run(Date.now(), id);
  return Number(result.changes) === 1;
}

export function finishPhoneBookingSmsOutbox(
  id: string,
  status: "submitted" | "failed" | "unknown",
  messageSid: string | null = null,
): void {
  getDatabase()
    .prepare(
      "UPDATE phone_booking_sms_outbox SET status = ?, message_sid = ?, updated_at = ? WHERE id = ? AND status = 'processing'",
    )
    .run(status, messageSid, Date.now(), id);
}

export function expirePhoneBookingSmsOutbox(id: string, before: number): void {
  getDatabase()
    .prepare(
      "UPDATE phone_booking_sms_outbox SET status = 'unknown', updated_at = ? WHERE id = ? AND status = 'processing' AND updated_at <= ?",
    )
    .run(Date.now(), id, before);
}

export type AttendanceCall = {
  id: string;
  bookingId: string;
  bookingVersion: number;
  booking: Booking;
  accountSid: string;
  sender: string;
  recipient: string;
  callbackOrigin: string;
  submissionStatus:
    | "pending"
    | "processing"
    | "submitted"
    | "failed"
    | "unknown";
  status: AttendanceCallStatus;
  callSid: string | null;
  phase: "initial" | "attendance" | "confirm" | "done";
  turn: string | null;
  unclearCount: number;
  createdAt: number;
  updatedAt: number;
};

function toAttendanceCall(row: Row): AttendanceCall {
  return {
    id: String(row.id),
    bookingId: String(row.booking_id),
    bookingVersion: Number(row.booking_version),
    booking: JSON.parse(String(row.booking_snapshot)) as Booking,
    accountSid: String(row.account_sid),
    sender: String(row.sender),
    recipient: String(row.recipient),
    callbackOrigin: String(row.callback_origin),
    submissionStatus:
      row.submission_status as AttendanceCall["submissionStatus"],
    status: row.status as AttendanceCallStatus,
    callSid: row.call_sid === null ? null : String(row.call_sid),
    phase: row.phase as AttendanceCall["phase"],
    turn: row.turn === null ? null : String(row.turn),
    unclearCount: Number(row.unclear_count),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function getAttendanceCall(id: string): AttendanceCall | null {
  const row = getDatabase()
    .prepare("SELECT * FROM attendance_calls WHERE id = ?")
    .get(id) as Row | undefined;
  return row ? toAttendanceCall(row) : null;
}

export function getAttendanceCallByRequest(
  requestId: string,
): AttendanceCall | null {
  const row = getDatabase()
    .prepare(
      "SELECT a.* FROM attendance_calls a JOIN attendance_call_requests r ON r.attempt_id = a.id WHERE r.request_id = ?",
    )
    .get(requestId) as Row | undefined;
  return row ? toAttendanceCall(row) : null;
}

export function getLatestAttendanceCall(
  bookingId: string,
): AttendanceCall | null {
  const row = getDatabase()
    .prepare(
      "SELECT * FROM attendance_calls WHERE booking_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(bookingId) as Row | undefined;
  return row ? toAttendanceCall(row) : null;
}

export function attendanceBookingMatches(
  value: AttendanceCall,
  booking: Booking,
): boolean {
  return (
    booking.status === "confirmed" &&
    booking.version === value.bookingVersion &&
    booking.phone === value.booking.phone &&
    attendanceRecipient(booking.phone) === value.recipient &&
    booking.startsAt === value.booking.startsAt &&
    booking.endsAt === value.booking.endsAt &&
    booking.courtId === value.booking.courtId &&
    Date.parse(booking.startsAt) > Date.now()
  );
}

// Unknown submissions can still ring. A new request must not submit a second
// call until the first one is known to have finished, including after an edit.
export function attendanceCallBlocksRetry(value: AttendanceCall): boolean {
  return (
    value.submissionStatus === "pending" ||
    value.submissionStatus === "processing" ||
    value.submissionStatus === "unknown" ||
    ["requesting", "queued", "ringing", "in-progress", "unknown"].includes(
      value.status,
    )
  );
}

export function reserveAttendanceCall(value: {
  id: string;
  requestId: string;
  bookingId: string;
  bookingVersion: number;
  accountSid: string;
  sender: string;
  callbackOrigin: string;
}): AttendanceCall {
  validateVersion(value.bookingVersion);
  return transaction((db) => {
    const replay = db
      .prepare("SELECT * FROM attendance_call_requests WHERE request_id = ?")
      .get(value.requestId) as Row | undefined;
    if (replay) {
      if (
        replay.booking_id !== value.bookingId ||
        Number(replay.booking_version) !== value.bookingVersion
      )
        throw new AppError(
          "This request ID has been used for another booking. Please refresh and try again.",
          409,
        );
      return getAttendanceCall(String(replay.attempt_id))!;
    }
    const booking = getBooking(value.bookingId, undefined, true);
    if (booking.version !== value.bookingVersion)
      throw new AppError(
        "This booking has been updated. Please refresh and try again.",
        409,
      );
    if (
      booking.status !== "confirmed" ||
      Date.parse(booking.startsAt) <= Date.now()
    )
      throw new AppError(
        "Attendance calls require a confirmed booking that has not started.",
        409,
      );
    const recipient = attendanceRecipient(booking.phone);
    if (!recipient)
      throw new AppError(
        "This booking phone number cannot be called. Please provide an international number or Australian mobile number.",
        400,
      );
    const latest = getLatestAttendanceCall(booking.id);
    const existing =
      latest &&
      (attendanceCallBlocksRetry(latest) ||
        (latest.status === "attending" &&
          latest.bookingVersion === booking.version));
    const id = existing ? latest.id : value.id;
    if (!existing) {
      const now = Date.now();
      db.prepare(
        "INSERT INTO attendance_calls (id, booking_id, booking_version, booking_snapshot, account_sid, sender, recipient, callback_origin, submission_status, status, phase, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'requesting', 'initial', ?, ?)",
      ).run(
        id,
        booking.id,
        booking.version,
        JSON.stringify(booking),
        value.accountSid,
        value.sender,
        recipient,
        value.callbackOrigin,
        now,
        now,
      );
    }
    db.prepare(
      "INSERT INTO attendance_call_requests (request_id, booking_id, booking_version, attempt_id) VALUES (?, ?, ?, ?)",
    ).run(value.requestId, value.bookingId, value.bookingVersion, id);
    return getAttendanceCall(id)!;
  });
}

export function claimAttendanceCall(id: string): boolean {
  return transaction((db) => {
    const value = getAttendanceCall(id);
    if (!value || value.submissionStatus !== "pending") return false;
    const booking = getBooking(value.bookingId, undefined, true);
    if (!attendanceBookingMatches(value, booking)) {
      db.prepare(
        "UPDATE attendance_calls SET submission_status = 'failed', status = 'stale', phase = 'done', updated_at = ? WHERE id = ?",
      ).run(Date.now(), id);
      return false;
    }
    return (
      Number(
        db
          .prepare(
            "UPDATE attendance_calls SET submission_status = 'processing', updated_at = ? WHERE id = ? AND submission_status = 'pending'",
          )
          .run(Date.now(), id).changes,
      ) === 1
    );
  });
}

export function finishAttendanceCallSubmission(
  id: string,
  status: "submitted" | "failed" | "unknown",
  callSid: string | null = null,
): void {
  transaction((db) => {
    const value = getAttendanceCall(id);
    if (!value) return;
    // A verified callback is stronger evidence than a late HTTP timeout or
    // rejection, and may already have recorded the customer's final answer.
    if (value.callSid) {
      if (callSid && value.callSid !== callSid) {
        db.prepare(
          "UPDATE attendance_calls SET status = 'unknown', phase = 'done', updated_at = ? WHERE id = ?",
        ).run(Date.now(), id);
      }
      return;
    }
    if (value.submissionStatus !== "processing") return;
    db.prepare(
      "UPDATE attendance_calls SET submission_status = ?, status = ?, call_sid = ?, phase = ?, updated_at = ? WHERE id = ?",
    ).run(
      status,
      status === "submitted" ? "queued" : status,
      callSid,
      status === "failed" ? "done" : value.phase,
      Date.now(),
      id,
    );
  });
}

export function updateAttendanceCall(
  id: string,
  value: Pick<AttendanceCall, "status" | "phase" | "turn" | "unclearCount">,
): void {
  getDatabase()
    .prepare(
      "UPDATE attendance_calls SET status = ?, phase = ?, turn = ?, unclear_count = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      value.status,
      value.phase,
      value.turn,
      value.unclearCount,
      Date.now(),
      id,
    );
}

export function expireAttendanceCalls(bookingId: string): void {
  const now = Date.now();
  getDatabase()
    .prepare(
      "UPDATE attendance_calls SET submission_status = 'unknown', status = 'unknown', updated_at = ? WHERE booking_id = ? AND submission_status = 'processing' AND call_sid IS NULL AND updated_at < ?",
    )
    .run(now, bookingId, now - 30_000);
  getDatabase()
    .prepare(
      "UPDATE attendance_calls SET status = 'unknown', phase = 'done', updated_at = ? WHERE booking_id = ? AND status IN ('queued', 'ringing', 'in-progress') AND updated_at < ?",
    )
    .run(now, bookingId, now - 30 * 60_000);
}

// Identity is checked before reading the event cache, so a replay cannot use
// another call's previously cached result. The first signed callback may bind
// its SID before the Calls API acknowledgement has arrived.
export function runAttendanceCallEvent(
  id: string,
  eventKey: string,
  identity: {
    callSid: string;
    accountSid: string;
    sender: string;
    recipient: string;
  },
  operation: (value: AttendanceCall) => string,
): string {
  return transaction((db) => {
    let value = getAttendanceCall(id);
    if (!value) throw new AppError("Attendance call record not found.", 404);
    if (
      identity.accountSid !== value.accountSid ||
      identity.sender !== value.sender ||
      identity.recipient !== value.recipient ||
      !/^CA[a-fA-F0-9]{32}$/.test(identity.callSid) ||
      (value.callSid !== null && identity.callSid !== value.callSid)
    )
      throw new AppError("Attendance call identity does not match.", 403);
    if (!value.callSid) {
      if (!["processing", "unknown"].includes(value.submissionStatus))
        throw new AppError("The attendance call has not been submitted.", 409);
      const used = db
        .prepare("SELECT id FROM attendance_calls WHERE call_sid = ?")
        .get(identity.callSid);
      if (used) throw new AppError("This call ID has already been used.", 403);
      db.prepare(
        "UPDATE attendance_calls SET call_sid = ?, submission_status = 'submitted', updated_at = ? WHERE id = ? AND call_sid IS NULL",
      ).run(identity.callSid, Date.now(), id);
      value = getAttendanceCall(id)!;
    }
    return runChannelEvent(`attendance:${id}:${eventKey}`, () =>
      operation(value!),
    );
  });
}
