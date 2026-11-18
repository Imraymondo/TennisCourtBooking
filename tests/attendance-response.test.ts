import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { POST as webhook } from "../app/api/webhooks/attendance/route";
import { startAttendanceCall } from "../lib/channels/attendance";
import {
  closeDatabase,
  createBooking,
  getAttendanceCall,
  getBooking,
} from "../lib/store";

const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const CALL_SID = `CA${"b".repeat(32)}`;
const AUTH_TOKEN = "fake-test-only-attendance-response-token";
const SENDER = "+61255550100";
const RECIPIENT = "+61412345678";
const BASE_URL = "https://courts.example";
const ENVIRONMENT = {
  BOOKING_DB_PATH: ":memory:",
  APP_BASE_URL: BASE_URL,
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
      _options: https.RequestOptions,
      callback: (response: EventEmitter) => void,
    ) => {
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

function signedRequest(url: string, extra: Record<string, string>) {
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
      "x-twilio-signature": createHmac("sha1", AUTH_TOKEN)
        .update(material)
        .digest("base64"),
    },
    body: new URLSearchParams(fields),
  });
}

function gatherAction(xml: string) {
  const action = /<Gather\b[^>]*\baction="([^"]+)"/.exec(xml)?.[1];
  return action?.replaceAll("&amp;", "&");
}

async function conversation(t: TestContext) {
  const calls = fakeProvider(t);
  const created = createBooking({
    courtId: 1,
    startLocal: "2099-12-01T15:00",
    durationHours: 2,
    customerName: "Player",
    phone: "0412 345 678",
    source: "web",
  });
  const started = await startAttendanceCall(
    created.booking.id,
    1,
    randomUUID(),
  );
  assert.equal(calls.length, 1);
  let url = calls[0].get("Url")!;
  async function sendAt(target: string, extra: Record<string, string> = {}) {
    const response = await webhook(signedRequest(target, extra));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /^text\/xml/);
    return response.text();
  }
  async function respond(extra: Record<string, string> = {}) {
    const xml = await sendAt(url, extra);
    url = gatherAction(xml) || url;
    return xml;
  }
  const initial = await respond();
  assert.match(initial, /Can you attend\?/);
  return {
    initial,
    get url() {
      return url;
    },
    respond,
    sendAt,
    storedBooking: () => getBooking(created.booking.id, created.accessCode),
    storedCall: () => getAttendanceCall(started.id)!,
  };
}

const nonAttendanceResponses: Record<string, string>[] = [
  { SpeechResult: "I can’t attend" },
  { SpeechResult: "Sorry, I can’t attend." },
  { SpeechResult: "I can't attend, sorry" },
  { SpeechResult: "No, I can't attend" },
  { SpeechResult: "I'm sorry, I can't attend" },
  { SpeechResult: "I can’t attend", Confidence: "0.4" },
  { SpeechResult: "press 2" },
  { SpeechResult: "press two" },
  { SpeechResult: "two" },
  { SpeechResult: "2" },
  { Digits: "2" },
  { Digits: "2", SpeechResult: "" },
  { Digits: "2", SpeechResult: "background noise" },
  { Digits: "2", SpeechResult: "background noise", Confidence: "0.2" },
  { Digits: "2", SpeechResult: "I can't attend", Confidence: "0.2" },
  { Digits: "2", SpeechResult: "I can't attend", Confidence: "0.79" },
];

for (const fields of nonAttendanceResponses) {
  test(`signed non-attendance response ${JSON.stringify(fields)} requires a new cancellation confirmation`, async (t) => {
    const call = await conversation(t);
    const original = call.storedBooking();
    const attendanceTurn = call.url;
    const review = await call.respond(fields);

    assert.match(review, /Would you like to cancel this booking\?/);
    assert.equal(call.storedCall().phase, "confirm");
    assert.notEqual(call.url, attendanceTurn);
    assert.deepEqual(call.storedBooking(), original);

    assert.equal(await call.sendAt(attendanceTurn, fields), review);
    assert.deepEqual(call.storedBooking(), original);

    await call.respond({
      SpeechResult: "Confirm cancellation",
      Confidence: "0.8",
    });
    assert.equal(call.storedCall().status, "cancelled");
    assert.equal(call.storedBooking().status, "cancelled");
    assert.equal(call.storedBooking().version, original.version + 1);
  });
}

test("attendance and cancellation Gathers use Australian English and allow a two-second speech pause", async (t) => {
  const call = await conversation(t);
  const review = await call.respond({ Digits: "2" });

  for (const xml of [call.initial, review]) {
    const gather = /<Gather\b[^>]*>/.exec(xml)?.[0];
    assert.ok(gather);
    assert.match(gather, /\blanguage="en-AU"/);
    assert.match(gather, /\bspeechTimeout="2"/);
  }
});

for (const confidence of ["invalid", "-0.1", "1.1", ""]) {
  test(`signed non-attendance speech with invalid confidence ${JSON.stringify(confidence)} asks again without changing the booking`, async (t) => {
    const call = await conversation(t);
    const original = call.storedBooking();
    const retry = await call.respond({
      SpeechResult: "I can't attend",
      Confidence: confidence,
    });

    assert.match(retry, /Can you attend\?/);
    assert.equal(call.storedCall().phase, "attendance");
    assert.deepEqual(call.storedBooking(), original);
  });
}

for (const confidence of ["0.95", "0.2"]) {
  test(`a signed DTMF 2 callback with contradictory attendance speech at confidence ${confidence} opens a separate cancellation review without changing the booking`, async (t) => {
    const call = await conversation(t);
    const original = call.storedBooking();
    const review = await call.respond({
      Digits: "2",
      SpeechResult: "I can attend",
      Confidence: confidence,
    });

    assert.match(review, /Would you like to cancel this booking\?/);
    assert.equal(call.storedCall().phase, "confirm");
    assert.deepEqual(call.storedBooking(), original);

    await call.respond({ Digits: "2" });
    assert.equal(call.storedCall().phase, "done");
    assert.deepEqual(call.storedBooking(), original);
  });
}

test("a signed DTMF 1 attendance response with contradictory speech confirms attendance and keeps the booking", async (t) => {
  const call = await conversation(t);
  const original = call.storedBooking();

  await call.respond({
    Digits: "1",
    SpeechResult: "I can't attend",
    Confidence: "0.95",
  });
  assert.equal(call.storedCall().status, "attending");
  assert.equal(call.storedCall().phase, "done");
  assert.deepEqual(call.storedBooking(), original);
});

const unsafeConfirmations: Record<string, string>[] = [
  { Digits: "1", SpeechResult: "Do not cancel" },
  { Digits: "1", SpeechResult: "Do not cancel", Confidence: "0.95" },
  { Digits: "1", SpeechResult: "Do not cancel", Confidence: "0.2" },
  { Digits: "1", SpeechResult: "background noise" },
  { Digits: "2", SpeechResult: "Confirm cancellation", Confidence: "0.95" },
  { SpeechResult: "Confirm cancellation", Confidence: "0.2" },
  { SpeechResult: "Confirm cancellation", Confidence: "0.79" },
  { SpeechResult: "Confirm cancellation", Confidence: "invalid" },
  { SpeechResult: "Confirm cancellation﹖", Confidence: "0.95" },
];

for (const fields of unsafeConfirmations) {
  test(`signed unsafe cancellation confirmation ${JSON.stringify(fields)} keeps the booking`, async (t) => {
    const call = await conversation(t);
    const original = call.storedBooking();
    await call.respond({ Digits: "2" });
    assert.equal(call.storedCall().phase, "confirm");

    await call.respond(fields);
    assert.deepEqual(call.storedBooking(), original);
    assert.notEqual(call.storedCall().status, "cancelled");
  });
}

test("a signed DTMF 2 cancellation refusal with leftover speech keeps the booking", async (t) => {
  const call = await conversation(t);
  const original = call.storedBooking();
  await call.respond({ Digits: "2" });

  await call.respond({ Digits: "2", SpeechResult: "background noise" });
  assert.equal(call.storedCall().phase, "done");
  assert.deepEqual(call.storedBooking(), original);
});

for (const speech of ["press 2", "press two"]) {
  test(`signed spoken cancellation refusal ${JSON.stringify(speech)} keeps the booking`, async (t) => {
    const call = await conversation(t);
    const original = call.storedBooking();
    await call.respond({ Digits: "2" });

    await call.respond({ SpeechResult: speech });
    assert.equal(call.storedCall().phase, "done");
    assert.deepEqual(call.storedBooking(), original);
  });
}

test("a signed polite cancellation confirmation only cancels on its second turn with sufficient confidence", async (t) => {
  const call = await conversation(t);
  const original = call.storedBooking();
  await call.respond({ SpeechResult: "Sorry, I can’t attend." });
  assert.equal(call.storedCall().phase, "confirm");
  assert.deepEqual(call.storedBooking(), original);

  await call.respond({
    SpeechResult: "Confirm cancellation, please",
    Confidence: "0.95",
  });
  assert.equal(call.storedCall().status, "cancelled");
  assert.equal(call.storedBooking().status, "cancelled");
  assert.equal(call.storedBooking().version, original.version + 1);
});
