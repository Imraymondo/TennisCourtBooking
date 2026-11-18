import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { POST as webhook } from "../app/api/webhooks/attendance/route";
import {
  claimAttendanceCall,
  closeDatabase,
  createBooking,
  finishAttendanceCallSubmission,
  reserveAttendanceCall,
} from "../lib/store";

const origin = "https://attendance-diagnostics.example";
const signingKey = "attendance-diagnostics-test-only-key";
const accountSid = `AC${"a".repeat(32)}`;
const callSid = `CA${"b".repeat(32)}`;
const sender = "+61255550100";
const recipient = "+61412345678";
const environment = {
  BOOKING_DB_PATH: ":memory:",
  APP_BASE_URL: origin,
  TWILIO_AUTH_TOKEN: signingKey,
  TWILIO_PHONE_NUMBER: sender,
  VOICE_DEBUG: "1",
};
let previousEnvironment: Record<string, string | undefined>;
let printed: string[];

type Diagnostic = {
  version: string;
  input: string;
  digits: string;
  speechLength: number;
  confidence: number | null;
  turn: string;
  event: string;
  outcome: string;
};

beforeEach((t) => {
  closeDatabase();
  previousEnvironment = Object.fromEntries(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, environment);
  printed = [];
  if ("mock" in t)
    t.mock.method(console, "info", (...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
});

afterEach((t) => {
  if ("mock" in t) t.mock.restoreAll();
  closeDatabase();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function records(): Diagnostic[] {
  return printed.map((line) => {
    assert.ok(line.startsWith("Attendance callback: "));
    return JSON.parse(line.slice("Attendance callback: ".length)) as Diagnostic;
  });
}

function conversation() {
  const created = createBooking({
    courtId: 1,
    startLocal: "2099-12-01T15:00",
    durationHours: 2,
    customerName: "Private fixture player",
    phone: "0412 345 678",
    source: "web",
  });
  const attempt = randomUUID();
  reserveAttendanceCall({
    id: attempt,
    requestId: randomUUID(),
    bookingId: created.booking.id,
    bookingVersion: 1,
    accountSid,
    sender,
    callbackOrigin: origin,
  });
  assert.equal(claimAttendanceCall(attempt), true);
  finishAttendanceCallSubmission(attempt, "submitted", callSid);
  const initial = `${origin}/api/webhooks/attendance?attempt=${attempt}`;
  let action = initial;
  async function send(
    extra: Record<string, string> = {},
    target = action,
    validSignature = true,
  ) {
    const fields: Record<string, string> = {
      AccountSid: accountSid,
      CallSid: callSid,
      From: sender,
      To: recipient,
      CallStatus: "in-progress",
      ...extra,
    };
    const material =
      target +
      Object.keys(fields)
        .sort()
        .map((name) => name + fields[name])
        .join("");
    const response = await webhook(
      new Request(target, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": validSignature
            ? createHmac("sha1", signingKey).update(material).digest("base64")
            : "invalid-signature",
        },
        body: new URLSearchParams(fields),
      }),
    );
    assert.equal(
      response.headers.get("x-attendance-version"),
      "attendance-input-3",
    );
    const xml = await response.text();
    const next = /<Gather\b[^>]*action="([^"]+)"/.exec(xml)?.[1];
    if (next) action = next.replaceAll("&amp;", "&");
    return { response, xml, diagnostic: records().at(-1) };
  }
  return {
    send,
    attempt,
    initial,
    bookingId: created.booking.id,
    accessCode: created.accessCode,
  };
}

test("signed attendance diagnostics distinguish keypad input and response outcome", async () => {
  const call = conversation();
  assert.equal((await call.send()).response.status, 200);
  assert.deepEqual(records()[0], {
    version: "attendance-input-3",
    input: "empty",
    digits: "absent",
    speechLength: 0,
    confidence: null,
    turn: "missing",
    event: "voice",
    outcome: "gather",
  });

  const negative = await call.send({ Digits: "2" });
  assert.equal(negative.response.status, 200);
  assert.match(negative.xml, /Would you like to cancel this booking/);
  assert.equal(negative.diagnostic!.input, "digits");
  assert.equal(negative.diagnostic!.digits, "2");
  assert.equal(negative.diagnostic!.turn, "present");
  assert.equal(negative.diagnostic!.outcome, "gather");

  const confirmed = await call.send({ Digits: "1" });
  assert.equal(confirmed.diagnostic!.digits, "1");
  assert.equal(confirmed.diagnostic!.outcome, "end");
  assert.match(confirmed.xml, /booking has been cancelled/);
});

test("speech and mixed input diagnostics retain numeric confidence without private values", async () => {
  const call = conversation();
  await call.send();
  const speech = await call.send({
    SpeechResult: "Sorry, I can't attend.",
    Confidence: "0.799",
  });
  assert.equal(speech.diagnostic!.input, "speech");
  assert.equal(speech.diagnostic!.digits, "absent");
  assert.equal(
    speech.diagnostic!.speechLength,
    "Sorry, I can't attend.".length,
  );
  assert.equal(speech.diagnostic!.confidence, 0.799);

  const rawSpeech = "Private visitor@example.invalid 0412345678";
  const rawDigits = "13900000000";
  const rawConfidence = "PRIVATE-CONFIDENCE";
  const mixed = await call.send({
    Digits: rawDigits,
    SpeechResult: rawSpeech,
    Confidence: rawConfidence,
  });
  assert.equal(mixed.diagnostic!.input, "both");
  assert.equal(mixed.diagnostic!.digits, "other");
  assert.equal(mixed.diagnostic!.speechLength, rawSpeech.length);
  assert.equal(mixed.diagnostic!.confidence, null);

  const logs = printed.join("\n");
  for (const privateValue of [
    rawSpeech,
    rawDigits,
    rawConfidence,
    "Sorry, I can't attend.",
    sender,
    recipient,
    accountSid,
    callSid,
    call.attempt,
    call.bookingId,
    call.accessCode,
    call.initial,
    origin,
    signingKey,
  ]) {
    assert.ok(
      !logs.includes(privateValue),
      "only approved metadata enters diagnostics",
    );
  }
});

for (const confidence of ["0.2", "PRIVATE-CONFIDENCE-FIXTURE"]) {
  test(`explicit final confirmation cancels while diagnostic confidence ${confidence === "0.2" ? "remains numeric" : "is redacted"}`, async () => {
    const call = conversation();
    await call.send();
    await call.send({ Digits: "2" });

    const result = await call.send({
      SpeechResult: "confirm cancellation",
      Confidence: confidence,
    });
    assert.equal(result.response.status, 200);
    assert.match(result.xml, /booking has been cancelled/);
    assert.equal(result.diagnostic!.version, "attendance-input-3");
    assert.equal(result.diagnostic!.input, "speech");
    assert.equal(result.diagnostic!.outcome, "end");
    assert.equal(result.diagnostic!.confidence, confidence === "0.2" ? 0.2 : null);
    assert.ok(!printed.join("\n").includes("confirm cancellation"));
    assert.ok(!printed.join("\n").includes("PRIVATE-CONFIDENCE-FIXTURE"));
  });
}

test("status callbacks are labelled without logging their call identifiers", async () => {
  const call = conversation();
  const status = await call.send(
    { CallStatus: "completed", SequenceNumber: "1" },
    `${call.initial}&event=status`,
  );
  assert.equal(status.response.status, 200);
  assert.equal(status.diagnostic!.event, "status");
  assert.equal(status.diagnostic!.outcome, "end");
  assert.equal(status.diagnostic!.turn, "missing");
});

test("debug is off by default and version headers remain present", async () => {
  delete process.env.VOICE_DEBUG;
  const call = conversation();
  await call.send();
  await call.send({ Digits: "2" });
  assert.deepEqual(printed, []);
});

test("failed signature checks retain the version header and do not log unverified input", async () => {
  const call = conversation();
  const rejected = await call.send(
    { Digits: "2", SpeechResult: "UNVERIFIED-PRIVATE-SPEECH" },
    call.initial,
    false,
  );
  assert.equal(rejected.response.status, 403);
  assert.deepEqual(printed, []);
});
