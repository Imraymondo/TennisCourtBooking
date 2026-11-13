import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import {
  getAttendanceSummaries,
  handleAttendanceWebhook,
  startAttendanceCall,
} from "../lib/channels/attendance";
import {
  AppError,
  cancelBooking,
  claimAttendanceCall,
  closeDatabase,
  createBooking,
  getAttendanceCall,
  getAvailability,
  getBooking,
  getDatabase,
  listBookings,
  reserveAttendanceCall,
  updateBooking,
} from "../lib/store";

const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const AUTH_TOKEN = "fake-test-only-attendance-token";
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
  if ("mock" in t) t.mock.timers.reset();
  closeDatabase();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type CapturedCall = {
  url: string;
  options: https.RequestOptions;
  body: URLSearchParams;
  sid: string;
  respond: (status?: number, body?: string) => void;
};

function fakeProvider(
  t: TestContext,
  behavior: "success" | "timeout" | "error" | "throw" = "success",
) {
  const calls: CapturedCall[] = [];
  t.mock.method(
    https,
    "request",
    (
      url: string,
      options: https.RequestOptions,
      callback: (response: EventEmitter) => void,
    ) => {
      assert.equal(
        getDatabase().isTransaction,
        false,
        "dial only after commit",
      );
      if (behavior === "throw") throw new Error("fake private request error");
      const request = new EventEmitter() as EventEmitter & {
        end: (body: string) => void;
        destroy: () => void;
      };
      request.destroy = () =>
        request.emit("error", new Error("fake closed socket"));
      request.end = (body) => {
        const sid = `CA${randomUUID().replaceAll("-", "")}`;
        const captured: CapturedCall = {
          url,
          options,
          body: new URLSearchParams(body),
          sid,
          respond(
            status = 201,
            result = JSON.stringify({ sid, status: "queued" }),
          ) {
            const response = new EventEmitter() as EventEmitter & {
              statusCode: number;
              destroy: () => void;
            };
            let destroyed = false;
            response.statusCode = status;
            response.destroy = () => {
              destroyed = true;
            };
            callback(response);
            if (destroyed) return;
            response.emit("data", Buffer.from(result));
            if (!destroyed) response.emit("end");
          },
        };
        calls.push(captured);
        if (behavior === "timeout") return;
        queueMicrotask(() => {
          if (behavior === "error")
            request.emit("error", new Error("fake transport error"));
          else captured.respond();
        });
      };
      return request;
    },
  );
  syncBuiltinESMExports();
  return calls;
}

function booking(phone = "0412 345 678", startLocal = "2099-12-01T15:00") {
  return createBooking({
    courtId: 1,
    startLocal,
    durationHours: 2,
    customerName: "球友 <A&B>",
    phone,
    email: "player@example.com",
    source: "web",
  });
}

function fields(call: CapturedCall, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    AccountSid: ACCOUNT_SID,
    CallSid: call.sid,
    From: SENDER,
    To: RECIPIENT,
    CallStatus: "in-progress",
    ...extra,
  });
}

function callback(
  call: CapturedCall,
  url: string,
  extra: Record<string, string> = {},
) {
  return handleAttendanceWebhook(
    fields(call, extra),
    new URL(url).searchParams,
  );
}

function gatherAction(xml: string) {
  const action = /<Gather\b[^>]*\baction="([^"]+)"/.exec(xml)?.[1];
  assert.ok(action, "the next decision has a fresh Gather callback");
  return action.replaceAll("&amp;", "&");
}

async function conversation(t: TestContext) {
  const calls = fakeProvider(t);
  const created = booking();
  const summary = await startAttendanceCall(
    created.booking.id,
    1,
    randomUUID(),
  );
  const call = calls[0];
  let url = call.body.get("Url")!;
  return {
    ...created,
    summary,
    call,
    calls,
    get url() {
      return url;
    },
    prepare(speech = "", digits = "") {
      const target = url;
      return () =>
        callback(call, target, { SpeechResult: speech, Digits: digits });
    },
    say(speech = "", digits = "") {
      const xml = callback(call, url, { SpeechResult: speech, Digits: digits });
      const action = /<Gather\b[^>]*\baction="([^"]+)"/.exec(xml)?.[1];
      if (action) url = action.replaceAll("&amp;", "&");
      return xml;
    },
    storedBooking() {
      return getBooking(created.booking.id, created.accessCode);
    },
    storedCall() {
      return getAttendanceCall(summary.id)!;
    },
  };
}

function appError(status: number) {
  return (error: unknown) =>
    error instanceof AppError && error.status === status;
}

test("reading attendance summaries never dials; explicit start posts the stored contact and opaque callback URLs", async (t) => {
  const calls = fakeProvider(t);
  const created = booking();
  assert.deepEqual(getAttendanceSummaries(listBookings()), {});
  assert.equal(calls.length, 0);
  const summary = await startAttendanceCall(
    created.booking.id,
    1,
    randomUUID(),
  );
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(
    call.url,
    `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`,
  );
  assert.equal(call.options.method, "POST");
  assert.ok(call.options.agent instanceof https.Agent);
  const headers = call.options.headers as Record<string, string | number>;
  assert.equal(
    headers.authorization,
    `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64")}`,
  );
  assert.equal(headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(call.body.get("From"), SENDER);
  assert.equal(call.body.get("To"), RECIPIENT);
  for (const name of ["Url", "StatusCallback"]) {
    const url = new URL(call.body.get(name)!);
    assert.equal(url.origin, BASE_URL);
    assert.equal(url.pathname, "/api/webhooks/attendance");
    assert.match(url.searchParams.get("attempt")!, /^[a-f\d-]{36}$/);
    assert.equal(url.searchParams.get("attempt"), summary.id);
    assert.ok(!url.href.includes(created.booking.id));
    assert.ok(!url.href.includes(created.accessCode));
    assert.ok(!url.href.includes(AUTH_TOKEN));
  }
  assert.equal(
    new URL(call.body.get("StatusCallback")!).searchParams.get("event"),
    "status",
  );
  assert.equal(summary.bookingId, created.booking.id);
  assert.equal(summary.bookingVersion, 1);
  assert.equal(typeof summary.createdAt, "number");
  assert.equal(typeof summary.updatedAt, "number");
  assert.equal(summary.canRetry, false);
  assert.equal(
    getAttendanceSummaries(listBookings())[created.booking.id].id,
    summary.id,
  );
  assert.equal(
    calls.length,
    1,
    "refreshing summaries cannot call the customer",
  );
});

test("concurrent start and replay share a durable request claim and issue one provider call", async (t) => {
  const calls = fakeProvider(t, "timeout");
  const created = booking();
  const requestId = randomUUID();
  const first = startAttendanceCall(created.booking.id, 1, requestId);
  const replay = startAttendanceCall(created.booking.id, 1, requestId);
  assert.equal(calls.length, 1);
  const attempt = new URL(calls[0].body.get("Url")!).searchParams.get(
    "attempt",
  )!;
  assert.ok(
    getAttendanceCall(attempt),
    "provider submission has a persistent claim before IO",
  );
  const concurrent = startAttendanceCall(created.booking.id, 1, randomUUID());
  calls[0].respond();
  const [a, b, c] = await Promise.all([first, replay, concurrent]);
  assert.equal(a.id, b.id);
  assert.equal(c.id, a.id);
  assert.equal(
    (await startAttendanceCall(created.booking.id, 1, requestId)).id,
    a.id,
  );
  assert.equal(calls.length, 1);
});

test("another process's persisted claim prevents resubmission and an abandoned claim becomes unknown", async (t) => {
  const calls = fakeProvider(t);
  const created = booking();
  const requestId = randomUUID();
  const value = reserveAttendanceCall({
    id: randomUUID(),
    requestId,
    bookingId: created.booking.id,
    bookingVersion: 1,
    accountSid: ACCOUNT_SID,
    sender: SENDER,
    callbackOrigin: BASE_URL,
  });
  assert.equal(claimAttendanceCall(value.id), true);
  assert.equal(claimAttendanceCall(value.id), false);
  assert.equal(
    (await startAttendanceCall(created.booking.id, 1, requestId)).id,
    value.id,
  );
  assert.equal(
    calls.length,
    0,
    "an existing claim is respected without an in-process promise",
  );
  getDatabase()
    .prepare("UPDATE attendance_calls SET updated_at = ? WHERE id = ?")
    .run(Date.now() - 31_000, value.id);
  const expired = getAttendanceSummaries(listBookings())[created.booking.id];
  assert.equal(expired.status, "unknown");
  assert.equal(expired.canRetry, false);
  assert.equal(
    (await startAttendanceCall(created.booking.id, 1, randomUUID())).id,
    value.id,
  );
  assert.equal(calls.length, 0);
});

test("a known provider rejection permits an explicit new request while replay never redials", async (t) => {
  const calls = fakeProvider(t, "timeout");
  const created = booking();
  const requestId = randomUUID();
  const pending = startAttendanceCall(created.booking.id, 1, requestId);
  calls[0].respond(
    400,
    JSON.stringify({ message: "fake private rejection detail" }),
  );
  const failed = await pending;
  assert.equal(failed.status, "failed");
  assert.equal(failed.canRetry, true);
  assert.equal(
    (await startAttendanceCall(created.booking.id, 1, requestId)).id,
    failed.id,
  );
  assert.equal(calls.length, 1);
  const retry = startAttendanceCall(created.booking.id, 1, randomUUID());
  assert.equal(calls.length, 2);
  calls[1].respond();
  const retried = await retry;
  assert.notEqual(retried.id, failed.id);
  assert.equal(retried.status, "queued");
  assert.equal(retried.canRetry, false);
  assert.equal(
    getBooking(created.booking.id, created.accessCode).status,
    "confirmed",
  );
});

for (const [status, body] of [
  [500, JSON.stringify({ message: "fake provider error" })],
  [201, "not JSON"],
  [201, JSON.stringify({ sid: "not-a-call-sid" })],
] as const) {
  test(`unusable provider acknowledgement ${status}/${body} is uncertain and cannot redial`, async (t) => {
    const calls = fakeProvider(t, "timeout");
    const created = booking();
    const pending = startAttendanceCall(created.booking.id, 1, randomUUID());
    calls[0].respond(status, body);
    const result = await pending;
    assert.equal(result.status, "unknown");
    assert.equal(result.canRetry, false);
    assert.equal(
      (await startAttendanceCall(created.booking.id, 1, randomUUID())).id,
      result.id,
    );
    assert.equal(calls.length, 1);
    assert.equal(
      getBooking(created.booking.id, created.accessCode).status,
      "confirmed",
    );
  });
}

test("missing or invalid outbound configuration never creates a provider request", async (t) => {
  const calls = fakeProvider(t);
  const created = booking();
  for (const [key, value] of [
    ["TWILIO_ACCOUNT_SID", ""],
    ["TWILIO_ACCOUNT_SID", "ACnot-an-account"],
    ["TWILIO_AUTH_TOKEN", ""],
    ["TWILIO_PHONE_NUMBER", "0412345678"],
    ["APP_BASE_URL", ""],
    ["APP_BASE_URL", "http://localhost:3000"],
    ["APP_BASE_URL", "https://courts.example/path"],
    ["APP_BASE_URL", "https://user:password@courts.example"],
  ]) {
    Object.assign(process.env, ENVIRONMENT, { [key]: value });
    await assert.rejects(
      startAttendanceCall(created.booking.id, 1, randomUUID()),
      appError(503),
    );
  }
  assert.equal(calls.length, 0);
  assert.equal(
    getBooking(created.booking.id, created.accessCode).status,
    "confirmed",
  );
});

test("past, cancelled, stale-version and unusable contacts are rejected before dialing", async (t) => {
  const calls = fakeProvider(t);
  for (const phone of ["", "123456"]) {
    const created = booking(phone);
    await assert.rejects(
      startAttendanceCall(created.booking.id, 1, randomUUID()),
    );
    cancelBooking(created.booking.id, 1, created.accessCode);
  }
  const created = booking();
  await assert.rejects(
    startAttendanceCall(created.booking.id, 2, randomUUID()),
    appError(409),
  );
  const futureClock = t.mock.method(Date, "now", () =>
    Date.parse("2100-01-01T00:00:00Z"),
  );
  await assert.rejects(
    startAttendanceCall(created.booking.id, 1, randomUUID()),
  );
  futureClock.mock.restore();
  cancelBooking(created.booking.id, 1, created.accessCode);
  await assert.rejects(
    startAttendanceCall(created.booking.id, 2, randomUUID()),
  );
  assert.equal(calls.length, 0);
});

test("a four second submission deadline is unknown and cannot be retried automatically", async (t) => {
  const calls = fakeProvider(t, "timeout");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const created = booking();
  const requestId = randomUUID();
  let completed = false;
  const pending = startAttendanceCall(created.booking.id, 1, requestId).then(
    (result) => {
      completed = true;
      return result;
    },
  );
  t.mock.timers.tick(3_999);
  await Promise.resolve();
  assert.equal(completed, false);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.status, "unknown");
  assert.equal(result.canRetry, false);
  assert.equal(
    (await startAttendanceCall(created.booking.id, 1, requestId)).id,
    result.id,
  );
  assert.equal(
    (await startAttendanceCall(created.booking.id, 1, randomUUID())).id,
    result.id,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    getBooking(created.booking.id, created.accessCode).status,
    "confirmed",
  );
});

for (const behavior of ["error", "throw"] as const) {
  test(`${behavior} during submission preserves the booking and prevents a blind second call`, async (t) => {
    const calls = fakeProvider(t, behavior);
    const created = booking();
    const result = await startAttendanceCall(
      created.booking.id,
      1,
      randomUUID(),
    );
    assert.equal(result.status, "unknown");
    assert.equal(result.canRetry, false);
    assert.equal(
      (await startAttendanceCall(created.booking.id, 1, randomUUID())).id,
      result.id,
    );
    assert.equal(calls.length, behavior === "throw" ? 0 : 1);
    assert.equal(
      getBooking(created.booking.id, created.accessCode).status,
      "confirmed",
    );
  });
}

test("only a second explicit confirmation cancels once and releases the booked court", async (t) => {
  const call = await conversation(t);
  assert.equal(
    getAvailability("2099-12-01").slots.find(
      (slot) => slot.courtId === 1 && slot.startLocal === "2099-12-01T15:00",
    )?.available,
    false,
  );
  const initial = call.say();
  assert.match(initial, /<Gather\b[^>]*language="en-AU"/);
  assert.match(initial, /<Say language="en-AU" voice="Polly.Olivia-Neural">/);
  assert.match(initial, /Can you attend\?/);
  assert.ok(
    !initial.includes(call.accessCode),
    "attendance call never discloses booking management credentials",
  );
  const confirmQuestion = call.say("I cannot attend");
  assert.match(confirmQuestion, /<Gather\b/);
  assert.equal(call.storedBooking().status, "confirmed");
  const confirm = call.prepare("Confirm cancellation");
  const xml = confirm();
  assert.equal(call.storedBooking().status, "cancelled");
  assert.equal(call.storedBooking().version, 2);
  assert.equal(call.storedCall().status, "cancelled");
  assert.equal(
    confirm(),
    xml,
    "provider replay returns the recorded turn without another write",
  );
  assert.equal(call.storedBooking().version, 2);
  assert.equal(
    getAvailability("2099-12-01").slots.find(
      (slot) => slot.courtId === 1 && slot.startLocal === "2099-12-01T15:00",
    )?.available,
    true,
  );
  assert.equal(call.calls.length, 1);
});

test("DTMF 1 in the attendance question marks attending and completion cannot cancel it", async (t) => {
  const call = await conversation(t);
  call.say();
  call.say("", "1");
  assert.equal(call.storedCall().status, "attending");
  assert.equal(call.storedBooking().status, "confirmed");
  callback(call.call, call.call.body.get("StatusCallback")!, {
    CallStatus: "completed",
    Digits: "1",
    SpeechResult: "确认取消",
  });
  assert.equal(call.storedCall().status, "attending");
  assert.equal(call.storedBooking().status, "confirmed");
});

for (const speech of [
  "I can attend",
  "I will attend",
  "I’ll be there",
  "attending",
  "能到场",
  "我能到场",
  "可以到场",
]) {
  test(`explicit attendance ${JSON.stringify(speech)} preserves the booking and marks attending`, async (t) => {
    const call = await conversation(t);
    call.say();
    call.say(speech);
    assert.equal(call.storedCall().status, "attending");
    assert.equal(call.storedBooking().status, "confirmed");
    assert.equal(call.storedBooking().version, 1);
  });
}

for (const speech of [
  "I cannot attend",
  "I can't attend",
  "I can’t make it",
  "unable to attend",
]) {
  test(`English non-attendance ${JSON.stringify(speech)} requires a separate confirmation`, async (t) => {
    const call = await conversation(t);
    call.say();
    const review = call.say(speech);
    assert.match(review, /Would you like to cancel this booking/);
    assert.equal(call.storedBooking().status, "confirmed");
    call.say("Confirm cancellation");
    assert.equal(call.storedBooking().status, "cancelled");
    assert.equal(call.storedBooking().version, 2);
  });
}

for (const speech of [
  "Keep my booking",
  "Don't cancel",
  "Do not cancel my booking",
]) {
  test(`English refusal ${JSON.stringify(speech)} keeps the booking`, async (t) => {
    const call = await conversation(t);
    call.say();
    call.say("I cannot attend");
    call.say(speech);
    assert.equal(call.storedBooking().status, "confirmed");
    assert.equal(call.storedCall().phase, "done");
    assert.equal(call.storedBooking().version, 1);
  });
}

test("DTMF cancellation confirmation is bound to its distinct second turn", async (t) => {
  const call = await conversation(t);
  call.say();
  const firstTurn = call.url;
  const no = call.prepare("", "2");
  const confirm = call.say("", "2");
  assert.notEqual(gatherAction(confirm), firstTurn);
  assert.equal(call.storedBooking().status, "confirmed");
  no();
  assert.equal(
    call.storedBooking().status,
    "confirmed",
    "replaying the first negative cannot confirm cancellation",
  );
  callback(call.call, firstTurn, { Digits: "1" });
  assert.equal(
    call.storedBooking().status,
    "confirmed",
    "changing a replayed first-turn answer cannot authorize its second stage",
  );
  call.say("", "1");
  assert.equal(call.storedBooking().status, "cancelled");
  assert.equal(call.storedBooking().version, 2);
});

for (const speech of [
  "确认取消",
  "我不是不能来",
  "我不能来但是不要取消",
  "可能来不了",
  "不要取消预约",
  "no",
  "I cannot not attend",
  "I can attend but do not cancel",
  "Can I attend",
  "I might attend",
  "I cannot attend?",
  "",
]) {
  test(`attendance answer ${JSON.stringify(speech)} preserves the booking`, async (t) => {
    const call = await conversation(t);
    call.say();
    call.say(speech);
    assert.equal(call.storedBooking().status, "confirmed");
    assert.equal(call.storedBooking().version, 1);
  });
}

for (const speech of [
  "不确认取消",
  "不要取消预约",
  "我不想取消",
  "可能取消",
  "确认取消但我还没决定",
  "Do not confirm cancellation",
  "I do not want to cancel",
  "Maybe cancel",
  "Confirm cancellation but I have not decided",
  "Can you confirm cancellation",
  "",
]) {
  test(`second-stage ambiguity ${JSON.stringify(speech)} never cancels`, async (t) => {
    const call = await conversation(t);
    call.say();
    call.say("不能来");
    call.say(speech);
    assert.equal(call.storedBooking().status, "confirmed");
    assert.equal(call.storedBooking().version, 1);
  });
}

for (const speech of [
  "Confirm cancellation?",
  "Cancel my booking?",
  "确认取消？",
  "取消预约？",
]) {
  test(`a cancellation question ${JSON.stringify(speech)} requires a subsequent clear confirmation`, async (t) => {
    const call = await conversation(t);
    call.say();
    call.say("不能到场");
    const retry = call.say(speech);
    assert.equal(call.storedBooking().status, "confirmed");
    assert.equal(call.storedBooking().version, 1);
    assert.match(retry, /<Gather\b/);
    call.say("确认取消");
    assert.equal(call.storedBooking().status, "cancelled");
    assert.equal(call.storedBooking().version, 2);
  });
}

test("keeping the reservation at the second question leaves it booked", async (t) => {
  const call = await conversation(t);
  call.say();
  call.say("", "2");
  call.say("", "2");
  assert.equal(call.storedBooking().status, "confirmed");
  assert.equal(call.storedBooking().version, 1);
});

const unclearConfirmations: Record<string, string>[] = [
  { SpeechResult: "Confirm cancellation", Confidence: "0.4" },
  { SpeechResult: "Confirm cancellation", Confidence: "invalid" },
  { SpeechResult: "Do not cancel", Digits: "1" },
  { SpeechResult: "Confirm cancellation", Digits: "2" },
  { Digits: "11" },
];
for (const extra of unclearConfirmations) {
  test(`low-confidence or conflicting confirmation ${JSON.stringify(extra)} preserves the booking`, async (t) => {
    const call = await conversation(t);
    call.say();
    call.say("不能来");
    callback(call.call, call.url, extra);
    assert.equal(call.storedBooking().status, "confirmed");
    assert.equal(call.storedBooking().version, 1);
  });
}

test("silence is bounded and finishes without releasing the court", async (t) => {
  const call = await conversation(t);
  let xml = call.say();
  let prompts = 0;
  while (xml.includes("<Gather") && prompts < 10) {
    xml = call.say();
    prompts++;
  }
  assert.ok(
    prompts < 10,
    "empty answers cannot keep the call open indefinitely",
  );
  assert.equal(call.storedBooking().status, "confirmed");
  assert.equal(call.storedBooking().version, 1);
});

for (const status of ["busy", "no-answer", "completed", "failed", "canceled"]) {
  test(`provider status ${status} cannot act as customer cancellation consent`, async (t) => {
    const call = await conversation(t);
    call.say();
    call.say("不能来");
    callback(call.call, call.call.body.get("StatusCallback")!, {
      CallStatus: status,
      Digits: "1",
      SpeechResult: "确认取消",
    });
    assert.equal(call.storedBooking().status, "confirmed");
    assert.equal(call.storedBooking().version, 1);
  });
}

test("callback identity independently binds account, outbound sender, customer and CallSid", async (t) => {
  const call = await conversation(t);
  call.say();
  call.say("不能来");
  const invalidIdentities: Record<string, string>[] = [
    { AccountSid: `AC${"b".repeat(32)}` },
    { AccountSid: "" },
    { From: "+61255550199" },
    { To: "+61499999999" },
    { CallSid: `CA${"c".repeat(32)}` },
  ];
  for (const invalid of invalidIdentities) {
    const before = call.storedCall();
    try {
      callback(call.call, call.url, { Digits: "1", ...invalid });
    } catch (error) {
      assert.ok(error instanceof AppError);
    }
    assert.deepEqual(
      call.storedCall(),
      before,
      "invalid identity cannot advance a turn or change status",
    );
    assert.equal(call.storedBooking().status, "confirmed");
  }
  call.say("", "1");
  assert.equal(
    call.storedBooking().status,
    "cancelled",
    "invalid callbacks do not consume the genuine turn",
  );
});

test("unknown attempt and fabricated turn cannot mutate a reservation", async (t) => {
  const call = await conversation(t);
  call.say();
  call.say("不能来");
  for (const key of ["attempt", "turn"]) {
    const target = new URL(call.url);
    target.searchParams.set(key, randomUUID());
    try {
      callback(call.call, target.href, { Digits: "1" });
    } catch (error) {
      assert.ok(error instanceof AppError);
    }
    assert.equal(call.storedBooking().status, "confirmed");
  }
});

for (const change of ["contact", "time"] as const) {
  test(`a ${change} change during the call invalidates the cancellation snapshot`, async (t) => {
    const call = await conversation(t);
    call.say();
    call.say("不能来");
    const updated = updateBooking(
      call.booking.id,
      {
        courtId: 1,
        startLocal: change === "time" ? "2099-12-02T15:00" : "2099-12-01T15:00",
        durationHours: 2,
        customerName: call.booking.customerName,
        email: call.booking.email,
        phone: change === "contact" ? "+61499999999" : call.booking.phone,
        version: 1,
      },
      call.accessCode,
    );
    call.say("确认取消");
    assert.deepEqual(call.storedBooking(), updated);
    assert.equal(call.storedCall().status, "stale");
  });
}

test("an expired confirmation token cannot cancel without an administrator poll, and status reconciliation stays safe", async (t) => {
  const call = await conversation(t);
  call.say();
  call.say("不能来");
  const lateConfirmation = call.prepare("确认取消");
  getDatabase()
    .prepare("UPDATE attendance_calls SET created_at = ? WHERE id = ?")
    .run(Date.now() - 31 * 60_000, call.summary.id);
  lateConfirmation();
  assert.equal(call.storedBooking().status, "confirmed");
  assert.equal(call.storedBooking().version, 1);
  assert.equal(call.storedCall().status, "unknown");
  assert.equal(call.storedCall().phase, "done");
  callback(call.call, call.call.body.get("StatusCallback")!, {
    CallStatus: "no-answer",
    Digits: "1",
    SpeechResult: "确认取消",
  });
  assert.equal(call.storedCall().status, "unanswered");
  assert.equal(
    getAttendanceSummaries(listBookings())[call.booking.id].canRetry,
    true,
  );
  const retry = await startAttendanceCall(call.booking.id, 1, randomUUID());
  assert.notEqual(retry.id, call.summary.id);
  assert.equal(call.calls.length, 2);
  lateConfirmation();
  assert.equal(
    call.storedBooking().status,
    "confirmed",
    "an old call cannot cancel after an explicit retry",
  );
  assert.equal(call.storedBooking().version, 1);
});

test("a callback before REST acknowledgement can bind and finish without being overwritten by queued", async (t) => {
  const calls = fakeProvider(t, "timeout");
  const created = booking();
  const pending = startAttendanceCall(created.booking.id, 1, randomUUID());
  const call = calls[0];
  const initial = callback(call, call.body.get("Url")!);
  const question = gatherAction(initial);
  const confirm = callback(call, question, { Digits: "2" });
  callback(call, gatherAction(confirm), { Digits: "1" });
  assert.equal(
    getBooking(created.booking.id, created.accessCode).status,
    "cancelled",
  );
  call.respond();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(getAttendanceCall(result.id)?.status, "cancelled");
  assert.equal(getBooking(created.booking.id, created.accessCode).version, 2);
  assert.equal(calls.length, 1);
});
