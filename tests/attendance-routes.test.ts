import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { POST as start } from "../app/api/admin/bookings/[id]/attendance-call/route";
import { GET as list } from "../app/api/bookings/route";
import { POST as webhook } from "../app/api/webhooks/attendance/route";
import { login, SESSION_COOKIE } from "../lib/auth";
import {
  closeDatabase,
  createBooking,
  getAttendanceCall,
  getBooking,
} from "../lib/store";

const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const CALL_SID = `CA${"b".repeat(32)}`;
const AUTH_TOKEN = "fake-test-only-attendance-route-token";
const SENDER = "+61255550100";
const RECIPIENT = "+61412345678";
const BASE_URL = "https://courts.example";
const ENVIRONMENT = {
  BOOKING_DB_PATH: ":memory:",
  APP_BASE_URL: BASE_URL,
  ADMIN_PASSWORD: "fake-test-only-admin-password",
  TWILIO_ACCOUNT_SID: ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: SENDER,
};
let originalEnvironment: Record<string, string | undefined>;

beforeEach(() => {
  closeDatabase();
  originalEnvironment = Object.fromEntries(
    Object.keys(ENVIRONMENT).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, ENVIRONMENT);
});
afterEach((t) => {
  if ("mock" in t) t.mock.restoreAll();
  syncBuiltinESMExports();
  closeDatabase();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fakeProvider(t: TestContext) {
  const calls: URLSearchParams[] = [];
  t.mock.method(
    https,
    "request",
    (
      _url: string,
      options: https.RequestOptions,
      callback: (response: EventEmitter) => void,
    ) => {
      const headers = options.headers as Record<string, string>;
      assert.equal(
        headers.authorization,
        `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64")}`,
        "outbound credentials use the trimmed Twilio token",
      );
      const request = new EventEmitter() as EventEmitter & {
        end: (body: string) => void;
        destroy: () => void;
      };
      request.destroy = () =>
        request.emit("error", new Error("fake socket closed"));
      request.end = (body) => {
        calls.push(new URLSearchParams(body));
        queueMicrotask(() => {
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
            destroy: () => void;
          };
          response.statusCode = 201;
          response.destroy = () => {};
          callback(response);
          response.emit(
            "data",
            Buffer.from(JSON.stringify({ sid: CALL_SID, status: "queued" })),
          );
          response.emit("end");
        });
      };
      return request;
    },
  );
  syncBuiltinESMExports();
  return calls;
}

function booking() {
  return createBooking({
    courtId: 1,
    startLocal: "2099-12-01T15:00",
    durationHours: 2,
    customerName: "球友",
    phone: "0412 345 678",
  });
}

function startRequest(
  id: string,
  body: unknown,
  cookie = "",
  origin = BASE_URL,
) {
  return new Request(`${BASE_URL}/api/admin/bookings/${id}/attendance-call`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie },
    body: JSON.stringify(body),
  });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}
function adminCookie() {
  return `${SESSION_COOKIE}=${login(ENVIRONMENT.ADMIN_PASSWORD)}`;
}

function signedRequest(
  url: string,
  extra: Record<string, string> = {},
  valid = true,
) {
  const fields: Record<string, string> = {
    AccountSid: ACCOUNT_SID,
    CallSid: CALL_SID,
    From: SENDER,
    To: RECIPIENT,
    CallStatus: "in-progress",
    ...extra,
  };
  const material =
    url +
    Object.keys(fields)
      .sort()
      .map((key) => key + fields[key])
      .join("");
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": valid
        ? createHmac("sha1", AUTH_TOKEN).update(material).digest("base64")
        : "invalid-signature",
    },
    body: new URLSearchParams(fields),
  });
}

function gatherAction(xml: string) {
  const action = /<Gather\b[^>]*\baction="([^"]+)"/.exec(xml)?.[1];
  assert.ok(action);
  return action.replaceAll("&amp;", "&");
}

test("attendance start requires an admin session and same-origin request before any provider IO", async (t) => {
  const calls = fakeProvider(t);
  const created = booking();
  const body = { version: 1, requestId: randomUUID() };
  const unauthenticated = await start(
    startRequest(created.booking.id, body),
    context(created.booking.id),
  );
  assert.equal(unauthenticated.status, 401);
  const crossOrigin = await start(
    startRequest(
      created.booking.id,
      body,
      adminCookie(),
      "https://attacker.example",
    ),
    context(created.booking.id),
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(calls.length, 0);
  assert.equal(
    getBooking(created.booking.id, created.accessCode).status,
    "confirmed",
  );
});

test("admin start rejects untrusted dial targets, malformed request ids and invalid versions", async (t) => {
  const calls = fakeProvider(t);
  const created = booking();
  const cookie = adminCookie();
  for (const body of [
    { version: 1, requestId: randomUUID(), phone: "+61499999999" },
    { version: 1, requestId: "not-a-request-id" },
    { version: "1", requestId: randomUUID() },
    { version: 0, requestId: randomUUID() },
  ]) {
    const response = await start(
      startRequest(created.booking.id, body, cookie),
      context(created.booking.id),
    );
    assert.equal(response.status, 400);
  }
  assert.equal(calls.length, 0);
});

test("admin start returns a private summary; polling the authenticated list performs no extra call", async (t) => {
  const calls = fakeProvider(t);
  const created = booking();
  const cookie = adminCookie();
  const requestId = randomUUID();
  const response = await start(
    startRequest(created.booking.id, { version: 1, requestId }, cookie),
    context(created.booking.id),
  );
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  const summary = result.attendanceCall;
  assert.deepEqual(
    Object.keys(summary).sort(),
    [
      "bookingId",
      "bookingVersion",
      "canRetry",
      "createdAt",
      "id",
      "status",
      "updatedAt",
    ].sort(),
  );
  assert.equal(summary.bookingId, created.booking.id);
  assert.equal(summary.bookingVersion, 1);
  assert.equal(summary.canRetry, false);
  assert.equal(calls[0].get("To"), RECIPIENT);
  for (let i = 0; i < 2; i++) {
    const listed = list(
      new Request(`${BASE_URL}/api/bookings`, { headers: { cookie } }),
    );
    assert.equal(listed.status, 200);
    assert.equal(
      (await listed.json()).attendanceCalls[created.booking.id].id,
      summary.id,
    );
  }
  const replay = await start(
    startRequest(created.booking.id, { version: 1, requestId }, cookie),
    context(created.booking.id),
  );
  assert.equal((await replay.json()).attendanceCall.id, summary.id);
  assert.equal(calls.length, 1);
});

test("whitespace around the configured Twilio token is normalized for outbound credentials and signed callbacks", async (t) => {
  process.env.TWILIO_AUTH_TOKEN = ` ${AUTH_TOKEN} `;
  const calls = fakeProvider(t);
  const created = booking();
  const started = await start(
    startRequest(
      created.booking.id,
      { version: 1, requestId: randomUUID() },
      adminCookie(),
    ),
    context(created.booking.id),
  );
  assert.equal(started.status, 202);
  assert.equal(calls.length, 1);
  const summary = (await started.json()).attendanceCall;
  const initial = await webhook(signedRequest(calls[0].get("Url")!));
  assert.equal(initial.status, 200);
  const attending = await webhook(
    signedRequest(gatherAction(await initial.text()), { Digits: "1" }),
  );
  assert.equal(attending.status, 200);
  assert.equal(getAttendanceCall(summary.id)?.status, "attending");
  assert.equal(
    getBooking(created.booking.id, created.accessCode).status,
    "confirmed",
  );
});

test("invalid webhook signature cannot bind a call or advance its cancellation flow", async (t) => {
  const calls = fakeProvider(t);
  const created = booking();
  const response = await start(
    startRequest(
      created.booking.id,
      { version: 1, requestId: randomUUID() },
      adminCookie(),
    ),
    context(created.booking.id),
  );
  const summary = (await response.json()).attendanceCall;
  const before = getAttendanceCall(summary.id);
  const invalid = await webhook(
    signedRequest(
      calls[0].get("Url")!,
      { Digits: "1", SpeechResult: "确认取消" },
      false,
    ),
  );
  assert.equal(invalid.status, 403);
  assert.deepEqual(getAttendanceCall(summary.id), before);
  assert.equal(
    getBooking(created.booking.id, created.accessCode).status,
    "confirmed",
  );
});

test("signed outbound callbacks follow two distinct turns and cancellation replay remains idempotent", async (t) => {
  const calls = fakeProvider(t);
  const created = booking();
  await start(
    startRequest(
      created.booking.id,
      { version: 1, requestId: randomUUID() },
      adminCookie(),
    ),
    context(created.booking.id),
  );
  const initial = await webhook(signedRequest(calls[0].get("Url")!));
  assert.equal(initial.status, 200);
  assert.match(initial.headers.get("content-type")!, /text\/xml/);
  assert.equal(initial.headers.get("cache-control"), "no-store");
  const initialXml = await initial.text();
  assert.equal(
    (initialXml.match(/<Response>/g) || []).length,
    1,
    "route returns one TwiML document",
  );
  const firstTurn = gatherAction(initialXml);
  const negative = await webhook(
    signedRequest(firstTurn, { SpeechResult: "I cannot attend" }),
  );
  const confirmationUrl = gatherAction(await negative.text());
  assert.notEqual(confirmationUrl, firstTurn);
  assert.equal(
    getBooking(created.booking.id, created.accessCode).status,
    "confirmed",
  );
  for (let i = 0; i < 2; i++) {
    const confirmed = await webhook(
      signedRequest(confirmationUrl, { SpeechResult: "Confirm cancellation" }),
    );
    assert.equal(confirmed.status, 200);
    assert.equal(
      getBooking(created.booking.id, created.accessCode).status,
      "cancelled",
    );
    assert.equal(getBooking(created.booking.id, created.accessCode).version, 2);
  }
  assert.equal(calls.length, 1);
});

test("a valid Twilio signature still cannot substitute another outbound call identity", async (t) => {
  const calls = fakeProvider(t);
  const created = booking();
  await start(
    startRequest(
      created.booking.id,
      { version: 1, requestId: randomUUID() },
      adminCookie(),
    ),
    context(created.booking.id),
  );
  const initial = await webhook(signedRequest(calls[0].get("Url")!));
  const negative = await webhook(
    signedRequest(gatherAction(await initial.text()), { Digits: "2" }),
  );
  const confirmationUrl = gatherAction(await negative.text());
  const invalidIdentities: Record<string, string>[] = [
    { From: "+61255550199" },
    { To: "+61499999999" },
    { CallSid: `CA${"c".repeat(32)}` },
    { AccountSid: `AC${"d".repeat(32)}` },
  ];
  for (const extra of invalidIdentities) {
    const response = await webhook(
      signedRequest(confirmationUrl, { Digits: "1", ...extra }),
    );
    assert.equal(response.status, 403);
    assert.equal(
      getBooking(created.booking.id, created.accessCode).status,
      "confirmed",
    );
  }
});
