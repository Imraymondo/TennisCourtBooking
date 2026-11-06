import { DatabaseSync } from "node:sqlite";
import { randomInt, createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
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
    throw new AppError("预约编号或管理码不正确", 404);
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
    throw new AppError("预约编号或管理码不正确", 404);
  }
  return row;
}

function validatedInput(input: BookingInput) {
  if (!input || typeof input !== "object") throw new AppError("预约信息无效");
  if (input.courtId !== 1 && input.courtId !== 2)
    throw new AppError("请选择一号或二号球场");
  if (
    typeof input.customerName !== "string" ||
    !input.customerName.trim() ||
    input.customerName.trim().length > 80 ||
    /[\x00-\x1f]/.test(input.customerName)
  ) {
    throw new AppError("姓名需要为 1 至 80 个字符");
  }
  if (input.email !== undefined && typeof input.email !== "string")
    throw new AppError("邮箱格式不正确");
  if (input.phone !== undefined && typeof input.phone !== "string")
    throw new AppError("电话格式不正确");
  const email = (input.email || "").trim();
  const phone = (input.phone || "").trim();
  if (
    email.length > 254 ||
    (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  )
    throw new AppError("邮箱格式不正确");
  if (
    phone.length > 32 ||
    (phone &&
      (!/^\+?[\d ()-]{6,32}$/.test(phone) ||
        phone.replace(/\D/g, "").length < 6))
  )
    throw new AppError("电话格式不正确");
  if (!phone && !email) throw new AppError("请至少填写电话或邮箱");
  const source = input.source ?? "web";
  if (!["web", "phone", "sms", "email", "staff"].includes(source))
    throw new AppError("预约来源无效");
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
  if (conflict)
    throw new AppError("该场地时间段已被预约，请选择其他时间或球场", 409);
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
    throw new AppError("预约版本无效，请刷新后重试");
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
      throw new AppError("已取消的预约无法修改", 409);
    if (Number(old.version) !== input.version)
      throw new AppError("预约已被更新，请刷新后重试", 409);
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
      throw new AppError("预约已被更新，请刷新后重试", 409);
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
  const active = (
    getDatabase()
      .prepare(
        "SELECT * FROM bookings WHERE status = 'confirmed' AND starts_at < ? AND ends_at > ? ORDER BY starts_at",
      )
      .all(bounds.endsAt, bounds.startsAt) as Row[]
  ).map(toBooking);
  const slots = COURTS.flatMap((court) =>
    Array.from({ length: 24 }, (_, hour) => {
      const startLocal = `${date}T${String(hour).padStart(2, "0")}:00`;
      try {
        const times = bookingTimes(startLocal, durationHours, false);
        const past = Date.parse(times.startsAt) <= Date.now();
        // Query beyond the displayed day too: a 23:00 start may overlap tomorrow.
        const conflict = getDatabase()
          .prepare(
            "SELECT id FROM bookings WHERE court_id = ? AND status = 'confirmed' AND starts_at < ? AND ends_at > ? LIMIT 1",
          )
          .get(court.id, times.endsAt, times.startsAt);
        return {
          courtId: court.id,
          startLocal,
          startsAt: times.startsAt,
          endsAt: times.endsAt,
          available: !past && !conflict,
          reason: past ? "已过去" : conflict ? "已有预约" : undefined,
        };
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return {
          courtId: court.id,
          startLocal,
          available: false,
          reason: "夏令时无效或重复整点",
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
        throw new AppError("操作过于频繁，请稍后再试", 429);
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
