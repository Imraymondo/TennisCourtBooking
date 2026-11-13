import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Availability, Booking, BookingInput } from "../lib/domain";

type CreatedBooking = { booking: Booking; accessCode: string };
type BookingResponse = { booking: Booking };
type RequestOptions = {
  method?: string;
  body?: unknown;
  cookie?: string;
  origin?: string;
};

let server: ChildProcess | undefined;
let serverStopped: Promise<void> | undefined;
let directory: string | undefined;
let baseUrl: string;
let adminPassword: string;
let startupFailed = false;

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  assert.ok(
    address && typeof address !== "string",
    "a local test port is required",
  );
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function stopServer() {
  if (!server || !serverStopped) return;
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    await Promise.race([
      serverStopped,
      delay(3_000, undefined, { ref: false }),
    ]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
      await Promise.race([
        serverStopped,
        delay(3_000, undefined, { ref: false }),
      ]);
    }
  }
}

before(
  async () => {
    directory = await mkdtemp(join(tmpdir(), "courtside-http-test-"));
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    adminPassword = randomBytes(24).toString("base64url");
    const childEnvironment = { ...process.env };
    // Integration tests never inherit working message providers or send messages.
    for (const name of Object.keys(childEnvironment)) {
      if (
        name.startsWith("TWILIO_") ||
        name.startsWith("POSTMARK_") ||
        name === "APP_BASE_URL"
      ) {
        childEnvironment[name] = "";
      }
    }
    for (const name of [
      "APP_BASE_URL",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_PHONE_NUMBER",
      "POSTMARK_INBOUND_SECRET",
      "POSTMARK_SERVER_TOKEN",
      "POSTMARK_FROM_EMAIL",
      "POSTMARK_INBOUND_EMAIL",
    ]) {
      childEnvironment[name] = "";
    }
    server = spawn(
      process.execPath,
      [
        join(process.cwd(), "node_modules", "next", "dist", "bin", "next"),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...childEnvironment,
          BOOKING_AI_ENABLED: "0",
          TWILIO_ACCOUNT_SID: "",
          VOICE_MODE: "gather",
          REALTIME_BRIDGE_SECRET: "",
          OPENAI_API_KEY: "",
          NODE_ENV: "production",
          NEXT_TELEMETRY_DISABLED: "1",
          BOOKING_DB_PATH: join(directory, "bookings.sqlite"),
          ADMIN_PASSWORD: adminPassword,
        },
        // Do not echo server output, account credentials, codes, or contact details.
        stdio: "ignore",
      },
    );
    serverStopped = new Promise<void>((resolve) => {
      server!.once("exit", () => resolve());
      server!.once("error", () => {
        startupFailed = true;
        resolve();
      });
    });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (
        startupFailed ||
        server.exitCode !== null ||
        server.signalCode !== null
      ) {
        throw new Error(
          "The production test server exited before readiness; run npm run build first.",
        );
      }
      try {
        const response = await fetch(
          `${baseUrl}/api/availability?date=2030-02-01`,
          {
            signal: AbortSignal.timeout(1_500),
          },
        );
        await response.arrayBuffer();
        if (response.status === 200) return;
      } catch {
        // A connection refusal while Next starts is expected; polling is bounded.
      }
      await delay(100);
    }
    throw new Error(
      "The production booking API did not become ready within 30 seconds.",
    );
  },
  { timeout: 40_000 },
);

after(
  async () => {
    try {
      await stopServer();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  },
  { timeout: 10_000 },
);

async function api<T>(path: string, options: RequestOptions = {}) {
  const method =
    options.method ?? (options.body === undefined ? "GET" : "POST");
  const headers = new Headers();
  if (options.body !== undefined)
    headers.set("content-type", "application/json");
  if (method !== "GET") headers.set("origin", options.origin ?? baseUrl);
  if (options.cookie) headers.set("cookie", options.cookie);
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await response.json()) as T;
  return { response, body };
}

function input(startLocal: string, courtId = 1): BookingInput {
  return {
    courtId,
    startLocal,
    customerName: "集成测试球友",
    email: "integration@example.invalid",
    phone: "+61000000000",
  };
}

async function create(
  value: BookingInput,
  cookie?: string,
): Promise<CreatedBooking> {
  const { response, body } = await api<CreatedBooking>("/api/bookings", {
    body: value,
    cookie,
  });
  assert.equal(response.status, 201, "valid bookings should be persisted");
  assert.ok(
    /^\d{8}$/.test(body.booking.id),
    "creation returns an eight-digit booking ID",
  );
  assert.ok(
    /^\d{10}$/.test(body.accessCode),
    "creation returns a ten-digit private code",
  );
  return body;
}

async function availability(date: string): Promise<Availability> {
  const { response, body } = await api<Availability>(
    `/api/availability?date=${date}`,
  );
  assert.equal(response.status, 200);
  return body;
}

test("public creation is web-only and schedules expose names without contact details or access codes", async () => {
  const value = { ...input("2030-02-10T10:00"), source: "staff" as const };
  const created = await create(value);
  assert.equal(
    created.booking.source,
    "web",
    "public callers cannot claim staff or channel provenance",
  );
  assert.equal(created.booking.version, 1);
  assert.equal(created.booking.durationHours, 2);
  assert.equal(created.booking.status, "confirmed");
  assert.equal(
    Date.parse(created.booking.endsAt) - Date.parse(created.booking.startsAt),
    7_200_000,
  );

  const schedule = await availability("2030-02-10");
  assert.equal(schedule.timeZone, "Australia/Sydney");
  assert.equal(schedule.slots.length, 48);
  assert.deepEqual(
    schedule.courts.map((court) => court.id),
    [1, 2],
  );
  const visible = schedule.courts[0].bookings.find(
    (booking) => booking.id === created.booking.id,
  );
  assert.ok(visible, "the persisted booking appears in the public schedule");
  assert.equal(visible.customerName, value.customerName);
  assert.deepEqual(
    Object.keys(visible).sort(),
    ["id", "courtId", "customerName", "startsAt", "endsAt"].sort(),
  );
  const serialized = JSON.stringify(schedule);
  assert.ok(
    !serialized.includes(value.email!),
    "public schedules must omit email addresses",
  );
  assert.ok(
    !serialized.includes(value.phone!),
    "public schedules must omit phone numbers",
  );
  assert.ok(
    !serialized.includes(created.accessCode),
    "public schedules must omit management codes",
  );
});

test("staff authentication rejects invalid credentials, permits contact access, and revokes logout sessions", async () => {
  const created = await create(input("2030-02-11T10:00"));
  const anonymous = await api("/api/bookings?date=2030-02-11");
  assert.equal(anonymous.response.status, 401);
  const wrong = await api("/api/admin/login", {
    body: { password: "incorrect-test-password" },
  });
  assert.equal(wrong.response.status, 401);
  assert.equal(wrong.response.headers.get("set-cookie"), null);

  const login = await api<{ authenticated: boolean }>("/api/admin/login", {
    body: { password: adminPassword },
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.authenticated, true);
  const setCookie = login.response.headers.get("set-cookie");
  assert.ok(setCookie, "successful login issues a session cookie");
  assert.ok(
    setCookie.includes("HttpOnly") &&
      setCookie.includes("SameSite=Strict") &&
      setCookie.includes("Secure"),
    "production sessions use secure cookie attributes",
  );
  const cookie = setCookie.split(";")[0];
  const session = await api<{ authenticated: boolean; configured: boolean }>(
    "/api/admin/session",
    { cookie },
  );
  assert.equal(session.body.authenticated, true);
  assert.equal(session.body.configured, true);
  const listed = await api<{ bookings: Booking[] }>(
    "/api/bookings?date=2030-02-11",
    { cookie },
  );
  assert.equal(listed.response.status, 200);
  const staffView = listed.body.bookings.find(
    (booking) => booking.id === created.booking.id,
  );
  assert.ok(staffView, "authenticated staff can find the booking");
  assert.ok(
    staffView.email === created.booking.email &&
      staffView.phone === created.booking.phone,
    "authenticated staff can see contact details",
  );

  const loggedOut = await api("/api/admin/logout", { method: "POST", cookie });
  assert.equal(loggedOut.response.status, 200);
  assert.equal((await api("/api/bookings", { cookie })).response.status, 401);
});

test("overlaps return 409 while adjacent bookings and the other court remain available", async () => {
  await create(input("2030-02-12T10:00"));
  const conflict = await api("/api/bookings", {
    body: input("2030-02-12T11:00"),
  });
  assert.equal(conflict.response.status, 409);
  const otherCourt = await create(input("2030-02-12T10:00", 2));
  assert.equal(otherCourt.booking.courtId, 2);
  const adjacent = await create(input("2030-02-12T12:00"));
  assert.equal(adjacent.booking.status, "confirmed");
  const schedule = await availability("2030-02-12");
  assert.equal(
    schedule.courts[0].bookings.length,
    2,
    "rejected overlap must not insert a record",
  );
  assert.equal(schedule.courts[1].bookings.length, 1);
});

test("hourly occupancy keeps a one-hour gap open without permitting a two-hour overlap", async () => {
  const date = "2031-02-01";
  await create(input(`${date}T08:00`));
  const schedule = await availability(date);
  const hour = (time: string, courtId = 1) => {
    const slot = schedule.slots.find(
      (candidate) =>
        candidate.courtId === courtId &&
        candidate.startLocal === `${date}T${time}`,
    );
    assert.ok(slot);
    return slot;
  };
  assert.equal(hour("07:00").occupied, false);
  assert.equal(hour("07:00").maxDurationHours, 1);
  assert.equal(hour("07:00").available, false);
  for (const time of ["08:00", "09:00"]) {
    assert.equal(hour(time).occupied, true);
    assert.equal(hour(time).maxDurationHours, 0);
    assert.equal(hour(time).available, false);
  }
  assert.equal(hour("10:00").available, true);
  assert.equal(hour("07:00", 2).available, true);

  const oneHour = await api<Availability>(
    `/api/availability?date=${date}&durationHours=1`,
  );
  assert.equal(oneHour.response.status, 200);
  assert.equal(
    oneHour.body.slots.find(
      (slot) => slot.courtId === 1 && slot.startLocal === `${date}T07:00`,
    )?.available,
    true,
  );
  const conflict = await api("/api/bookings", {
    body: { ...input(`${date}T07:00`), durationHours: 2 },
  });
  assert.equal(conflict.response.status, 409);
  const adjacent = await create({
    ...input(`${date}T07:00`),
    durationHours: 1,
  });
  assert.equal(adjacent.booking.durationHours, 1);
  assert.equal(adjacent.booking.status, "confirmed");
});

test("overnight bookings block the following day and appear in its public schedule", async () => {
  const created = await create(input("2030-02-13T23:00"));
  const conflict = await api("/api/bookings", {
    body: input("2030-02-14T00:00"),
  });
  assert.equal(conflict.response.status, 409);
  const schedule = await availability("2030-02-14");
  assert.ok(
    schedule.courts[0].bookings.some(
      (booking) => booking.id === created.booking.id,
    ),
  );
  assert.equal(
    schedule.slots.find(
      (slot) => slot.courtId === 1 && slot.startLocal.endsWith("T00:00"),
    )?.available,
    false,
  );
  assert.equal(
    schedule.slots.find(
      (slot) => slot.courtId === 1 && slot.startLocal.endsWith("T01:00"),
    )?.available,
    true,
  );
});

test("private lookup, edit, stale-version checks, and cancellation preserve booking ownership and availability", async () => {
  const originalInput = input("2030-02-15T10:00");
  const created = await create(originalInput);
  const bookingPath = `/api/bookings/${created.booking.id}`;
  const wrongCode =
    created.accessCode === "0000000000" ? "1111111111" : "0000000000";
  for (const code of [undefined, wrongCode]) {
    const denied = await api("/api/bookings/lookup", {
      body: { id: created.booking.id, accessCode: code },
    });
    assert.equal(
      denied.response.status,
      404,
      "lookup requires the private management code",
    );
  }
  const unauthorizedEdit = await api(bookingPath, {
    method: "PATCH",
    body: { ...originalInput, version: 1 },
  });
  assert.equal(unauthorizedEdit.response.status, 404);
  const unauthorizedCancel = await api(bookingPath, {
    method: "DELETE",
    body: { version: 1, accessCode: wrongCode },
  });
  assert.equal(unauthorizedCancel.response.status, 404);
  const lookup = await api<BookingResponse>("/api/bookings/lookup", {
    body: { id: created.booking.id, accessCode: created.accessCode },
  });
  assert.equal(lookup.response.status, 200);
  assert.equal(lookup.body.booking.id, created.booking.id);
  assert.equal(lookup.body.booking.version, 1);

  const movedInput = input("2030-02-15T16:00");
  const edited = await api<BookingResponse>(bookingPath, {
    method: "PATCH",
    body: { ...movedInput, version: 1, accessCode: created.accessCode },
  });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.body.booking.version, 2);
  assert.notEqual(edited.body.booking.startsAt, created.booking.startsAt);
  const staleEdit = await api(bookingPath, {
    method: "PATCH",
    body: {
      ...input("2030-02-15T18:00"),
      version: 1,
      accessCode: created.accessCode,
    },
  });
  assert.equal(staleEdit.response.status, 409);
  const staleCancel = await api(bookingPath, {
    method: "DELETE",
    body: { version: 1, accessCode: created.accessCode },
  });
  assert.equal(staleCancel.response.status, 409);
  const current = await api<BookingResponse>("/api/bookings/lookup", {
    body: { id: created.booking.id, accessCode: created.accessCode },
  });
  assert.equal(
    current.body.booking.startsAt,
    edited.body.booking.startsAt,
    "stale writes preserve the successful edit",
  );
  const beforeCancel = await availability("2030-02-15");
  assert.equal(
    beforeCancel.slots.find(
      (slot) => slot.courtId === 1 && slot.startLocal.endsWith("T10:00"),
    )?.available,
    true,
  );
  assert.equal(
    beforeCancel.slots.find(
      (slot) => slot.courtId === 1 && slot.startLocal.endsWith("T16:00"),
    )?.available,
    false,
  );

  const cancelled = await api<BookingResponse>(bookingPath, {
    method: "DELETE",
    body: { version: 2, accessCode: created.accessCode },
  });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.booking.status, "cancelled");
  assert.equal(cancelled.body.booking.version, 3);
  const afterCancel = await availability("2030-02-15");
  assert.ok(
    !afterCancel.courts[0].bookings.some(
      (booking) => booking.id === created.booking.id,
    ),
  );
  assert.equal(
    afterCancel.slots.find(
      (slot) => slot.courtId === 1 && slot.startLocal.endsWith("T16:00"),
    )?.available,
    true,
  );
  await create(movedInput);
  const cancelledEdit = await api(bookingPath, {
    method: "PATCH",
    body: {
      ...input("2030-02-15T20:00"),
      version: 3,
      accessCode: created.accessCode,
    },
  });
  assert.equal(
    cancelledEdit.response.status,
    409,
    "cancelled bookings cannot be edited or resurrected",
  );
});

test("cross-origin writes are rejected without creating a booking", async () => {
  const differentPort = new URL(baseUrl);
  differentPort.port = String(
    Number(differentPort.port) === 65535
      ? 65534
      : Number(differentPort.port) + 1,
  );
  const normalizedAlias = new URL(baseUrl);
  normalizedAlias.hostname = "localhost";
  for (const origin of [
    "https://untrusted.example",
    differentPort.origin,
    normalizedAlias.origin,
  ]) {
    const rejected = await api("/api/bookings", {
      body: input("2030-02-16T10:00"),
      origin,
    });
    assert.ok(
      [400, 403].includes(rejected.response.status),
      "a foreign host, port, or normalized alias must be rejected",
    );
  }
  const schedule = await availability("2030-02-16");
  assert.equal(schedule.courts[0].bookings.length, 0);
});

test("attendance calls require staff authentication and same origin and preserve bookings when unconfigured", async () => {
  const created = await create(input("2030-03-01T10:00"));
  const path = `/api/admin/bookings/${created.booking.id}/attendance-call`;
  const body = { version: created.booking.version, requestId: randomUUID() };
  assert.equal((await api(path, { body })).response.status, 401);
  const login = await api("/api/admin/login", {
    body: { password: adminPassword },
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get("set-cookie")!.split(";")[0];
  assert.equal(
    (await api(path, { body, cookie, origin: "https://untrusted.example" }))
      .response.status,
    403,
  );
  assert.equal(
    (await api(path, { body: { ...body, To: "+61400999999" }, cookie }))
      .response.status,
    400,
  );
  assert.equal((await api(path, { body, cookie })).response.status, 503);
  const current = await api<BookingResponse>("/api/bookings/lookup", {
    body: { id: created.booking.id, accessCode: created.accessCode },
  });
  assert.equal(current.body.booking.status, "confirmed");
  assert.equal(current.body.booking.version, created.booking.version);
  const listing = await api<{ attendanceCalls: Record<string, unknown> }>(
    "/api/bookings?date=2030-03-01",
    { cookie },
  );
  assert.deepEqual(listing.body.attendanceCalls, {});
});

test("unconfigured message providers report disabled channels and reject inbound webhooks without external calls", async () => {
  const status = await api<{
    phone: boolean;
    sms: boolean;
    email: boolean;
    configurationOnly: boolean;
  }>("/api/channels/status");
  assert.equal(status.response.status, 200);
  assert.equal(status.body.phone, false);
  assert.equal(status.body.sms, false);
  assert.equal(status.body.email, false);
  assert.equal(status.body.configurationOnly, true);
  for (const channel of ["sms", "voice", "email", "attendance"]) {
    const webhook = await fetch(`${baseUrl}/api/webhooks/${channel}`, {
      method: "POST",
      headers: {
        "content-type":
          channel === "email"
            ? "application/json"
            : "application/x-www-form-urlencoded",
      },
      body: channel === "email" ? "{}" : "",
      signal: AbortSignal.timeout(5_000),
    });
    await webhook.arrayBuffer();
    assert.equal(
      webhook.status,
      503,
      `${channel}: missing provider credentials are an explicit service-unavailable state`,
    );
  }
});
