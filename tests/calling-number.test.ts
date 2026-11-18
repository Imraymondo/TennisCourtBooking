import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { POST as realtimeTurn } from "../app/api/realtime/turn/route";
import { POST as voiceWebhook } from "../app/api/webhooks/voice/route";
import {
  parsePhoneSpeech,
  usesCallerNumber,
} from "../lib/channels/voice-input";
import { closeDatabase, getChannelState, listBookings } from "../lib/store";

const WEBHOOK_URL = "https://courts.example/api/webhooks/voice";
const INTERNAL_URL = "http://127.0.0.1:3000/api/realtime/turn";
const CALLER = "+61400123456";
const SERVICE = "+61255550100";
const ENVIRONMENT = {
  BOOKING_DB_PATH: ":memory:",
  APP_BASE_URL: "https://courts.example",
  BOOKING_AI_ENABLED: "0",
  VOICE_DEBUG: "0",
  VOICE_MODE: "gather",
  TWILIO_ACCOUNT_SID: "",
  TWILIO_AUTH_TOKEN: "fake-calling-number-signature-token",
  TWILIO_PHONE_NUMBER: SERVICE,
  OPENAI_API_KEY: "fake-calling-number-openai-key",
  REALTIME_BRIDGE_SECRET: "fake-calling-number-bridge-secret",
};
let originalEnvironment: Record<string, string | undefined>;

beforeEach(() => {
  closeDatabase();
  originalEnvironment = Object.fromEntries(
    Object.keys(ENVIRONMENT).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, ENVIRONMENT);
});

afterEach(() => {
  closeDatabase();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const acceptedConsent = [
  "Use my calling number",
  "Use my calling number.",
  "Use my calling number?",
  "Use my calling number, please.",
  "Please, use my calling number.",
  "Yes, please use my calling number.",
  "Use my calling number, thanks.",
  "Please use the number I'm calling from.",
  "Use the number I’m calling from.",
  "Use the number that I am calling from, thank you.",
  "Use my caller ID.",
  "Use my caller I.D., please.",
  "Use my calling number，please。",
  "使用来电号码。",
  "使用來電號碼。",
];

const rejectedConsent = [
  "Do not use my calling number.",
  "Don't use my calling number.",
  "Don’t use my calling number.",
  "No, don't use my calling number.",
  "I'm not sure, use my calling number.",
  "Can you use my calling number?",
  "What does use my calling number mean?",
  "You said use my calling number.",
  "Use my calling number or 0400000000.",
  "Use my calling number, 0400000000.",
  "Use my calling number or zero four zero zero zero zero zero zero zero zero.",
  "不要使用来电号码。",
];

test("caller-number consent accepts speech punctuation and common explicit wording", () => {
  for (const speech of acceptedConsent) {
    assert.equal(usesCallerNumber(speech), true, speech);
    assert.equal(parsePhoneSpeech(speech), null, speech);
  }
  assert.equal(
    parsePhoneSpeech("my phone number is 0400 000 000"),
    "0400000000",
  );
});

test("questions, negation, mentions and alternative numbers never grant caller-number consent", () => {
  for (const speech of rejectedConsent) {
    assert.equal(usesCallerNumber(speech), false, speech);
    assert.equal(parsePhoneSpeech(speech), null, speech);
  }
});

function identifier(prefix: "CA" | "MS") {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

function signedRequest(url: string, fields: Record<string, string>) {
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
      "x-twilio-signature": createHmac("sha1", ENVIRONMENT.TWILIO_AUTH_TOKEN)
        .update(material)
        .digest("base64"),
    },
    body: new URLSearchParams(fields),
  });
}

function voiceState(callSid: string): {
  step: string;
  contactPhone?: string;
  contactUsesCallerNumber?: boolean;
} {
  const saved = getChannelState(`voice:${callSid}`);
  assert.ok(saved);
  return JSON.parse(saved);
}

function gatherCall() {
  const callSid = identifier("CA");
  let url = WEBHOOK_URL;
  const prepare = (speech = "") => {
    const target = url;
    const fields = {
      CallSid: callSid,
      From: CALLER,
      To: SERVICE,
      SpeechResult: speech,
    };
    return () => voiceWebhook(signedRequest(target, fields));
  };
  return {
    prepare,
    state: () => voiceState(callSid),
    say: async (speech = "") => {
      const response = await prepare(speech)();
      assert.equal(response.status, 200);
      const xml = await response.text();
      const next = xml.match(/action="([^"]+)"/)?.[1];
      if (next) url = next.replaceAll("&amp;", "&");
      return xml;
    },
  };
}

const bookingFields = [
  ["I want to book a court", "date"],
  ["1 December 2099", "hour"],
  ["3 pm", "duration"],
  ["two hours", "name"],
  ["My name is Alice", "contact"],
] as const;

async function pendingGather() {
  const call = gatherCall();
  await call.say();
  for (const [speech, step] of bookingFields) {
    await call.say(speech);
    assert.equal(call.state().step, step, speech);
  }
  assert.equal(call.state().contactPhone, undefined);
  assert.equal(listBookings().length, 0);
  return call;
}

function assertCallerReview(prompt: string) {
  assert.match(prompt, /Booking name: Alice/i);
  assert.match(prompt, /Contact number: the number you are calling from/i);
  assert.match(prompt, /confirm booking/i);
  assert.doesNotMatch(prompt, /61400123456|61255550100/);
  assert.equal(listBookings().length, 0);
}

for (const speech of [
  "Use my calling number.",
  "Use my calling number, please.",
  "Please use the number I'm calling from.",
]) {
  test(`signed Gather captures its From number after "${speech}" and only books on confirmation`, async () => {
    const call = await pendingGather();
    const review = await call.say(speech);
    assert.equal(call.state().step, "confirm");
    assert.equal(call.state().contactPhone, CALLER);
    assert.equal(call.state().contactUsesCallerNumber, true);
    assertCallerReview(review);

    const confirm = call.prepare("confirm booking");
    const receipt = await (await confirm()).text();
    assert.match(receipt, /Booking confirmed/i);
    assert.equal(listBookings().length, 1);
    assert.equal(listBookings()[0].phone, CALLER);
    assert.equal(listBookings()[0].source, "phone");
    assert.equal(await (await confirm()).text(), receipt);
    assert.equal(listBookings().length, 1);
  });
}

test("signed Gather asks again for ambiguous caller-number speech without choosing another number", async () => {
  const call = await pendingGather();
  for (const speech of rejectedConsent) {
    await call.say(speech);
    assert.equal(call.state().step, "contact", speech);
    assert.equal(call.state().contactPhone, undefined, speech);
    assert.equal(listBookings().length, 0, speech);
  }
});

function internalRequest(body: Record<string, unknown>) {
  return new Request(INTERNAL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ENVIRONMENT.REALTIME_BRIDGE_SECRET}`,
    },
    body: JSON.stringify(body),
  });
}

async function realtimeCall() {
  process.env.VOICE_MODE = "realtime";
  const callSid = identifier("CA");
  const streamSid = identifier("MS");
  const initial = await voiceWebhook(
    signedRequest(WEBHOOK_URL, { CallSid: callSid, From: CALLER, To: SERVICE }),
  );
  assert.equal(initial.status, 200);
  const xml = await initial.text();
  const ticket = xml.match(/name="ticket" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(ticket, "the signed webhook issues the private stream ticket");
  assert.doesNotMatch(xml, /61400123456|61255550100/);
  const start = await realtimeTurn(
    internalRequest({ op: "start", callSid, streamSid, ticket }),
  );
  assert.equal(start.status, 200);
  const prepare = (transcript: string, extra: Record<string, unknown> = {}) => {
    const body = {
      op: "turn",
      callSid,
      streamSid,
      inputId: `item_${randomUUID().replaceAll("-", "")}`,
      transcript,
      ...extra,
    };
    return () => realtimeTurn(internalRequest(body));
  };
  return {
    prepare,
    state: () => voiceState(callSid),
    say: async (speech: string) => {
      const response = await prepare(speech)();
      assert.equal(response.status, 200);
      return response.json();
    },
  };
}

async function pendingRealtime() {
  const call = await realtimeCall();
  for (const [speech, step] of bookingFields) {
    const result = await call.say(speech);
    assert.equal(result.context.step, step, speech);
    assert.equal(listBookings().length, 0);
  }
  return call;
}

test("private Realtime uses the signed caller number for punctuated consent and replays one confirmed booking", async () => {
  const call = await pendingRealtime();
  for (const speech of rejectedConsent) {
    const response = await call.say(speech);
    assert.equal(response.context.step, "contact", speech);
    assert.equal(call.state().contactPhone, undefined, speech);
    assert.equal(listBookings().length, 0, speech);
  }

  const review = await call.say("Use my calling number, please.");
  assert.equal(review.context.step, "confirm");
  assert.equal(call.state().contactPhone, CALLER);
  assert.equal(call.state().contactUsesCallerNumber, true);
  assertCallerReview(review.prompt);
  assert.doesNotMatch(
    JSON.stringify(review.context),
    /phone|contact|61400123456/i,
  );

  const confirm = call.prepare("confirm booking");
  const receipt = await (await confirm()).json();
  assert.match(receipt.prompt, /Booking confirmed/i);
  assert.equal(listBookings().length, 1);
  assert.equal(listBookings()[0].phone, CALLER);
  assert.equal(listBookings()[0].source, "phone");
  assert.deepEqual(await (await confirm()).json(), receipt);
  assert.equal(listBookings().length, 1);
});

test("Realtime model and request fields cannot supply a caller or contact number", async () => {
  const call = await pendingRealtime();
  const interpretation = {
    scope: "booking",
    action: null,
    date: null,
    court: null,
    hour: null,
    duration: null,
    name: null,
    correction: null,
  };
  for (const extra of [
    { phone: "+61400999999" },
    { contactPhone: "+61400999999" },
    { interpretation: { ...interpretation, phone: "+61400999999" } },
    { interpretation: { ...interpretation, contactPhone: "+61400999999" } },
  ]) {
    const response = await call.prepare("I am still deciding", extra)();
    assert.equal(response.status, 400);
    assert.equal(call.state().step, "contact");
    assert.equal(call.state().contactPhone, undefined);
    assert.equal(listBookings().length, 0);
  }
  const review = await call.say("Use my caller ID.");
  assert.equal(call.state().contactPhone, CALLER);
  assertCallerReview(review.prompt);
});
