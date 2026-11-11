import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { POST as voice } from "../app/api/webhooks/voice/route";
import { closeDatabase, getChannelState, listBookings } from "../lib/store";

const origin = "https://voice-diagnostics.example";
const webhook = origin + "/api/webhooks/voice";
const signingKey = "voice-diagnostics-fixture-key-not-a-real-credential";
const receivingNumber = "+61255550100";
const callerNumber = "+61400123456";
const originalInfo = console.info;
const environmentNames = [
  "VOICE_MODE",
  "BOOKING_AI_ENABLED",
  "BOOKING_DB_PATH",
  "APP_BASE_URL",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "VOICE_DEBUG",
] as const;
const previousEnvironment = Object.fromEntries(
  environmentNames.map((name) => [name, process.env[name]]),
);
let printed: string[] = [];

type Diagnostic = {
  version: string;
  turn: string;
  turnState: string;
  input: string;
  handling: string;
  stepBefore: string | null;
  stepAfter: string | null;
  cached: boolean;
  speechField: string;
  speechLength: number;
  partialFieldPresent: boolean;
  partialLength: number;
  confidence: number | null;
  providerErrorCode: string | null;
  recognizedIntent: string | null;
  dateRecognized: boolean | null;
  configuredLanguage: string;
  responseLanguage: string;
};

function records(): Diagnostic[] {
  return printed.map(
    (line) => JSON.parse(line.slice("Voice callback: ".length)) as Diagnostic,
  );
}

beforeEach(() => {
  process.env.VOICE_MODE = "gather";
  process.env.BOOKING_AI_ENABLED = "0";
  closeDatabase();
  process.env.BOOKING_DB_PATH = ":memory:";
  process.env.APP_BASE_URL = origin;
  process.env.TWILIO_AUTH_TOKEN = signingKey;
  process.env.TWILIO_PHONE_NUMBER = receivingNumber;
  process.env.VOICE_DEBUG = "1";
  printed = [];
  console.info = (...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.info = originalInfo;
  closeDatabase();
});

after(() => {
  for (const name of environmentNames) {
    const previous = previousEnvironment[name];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

function caller() {
  const callSid = "CA" + randomUUID().replaceAll("-", "");
  let action = webhook;
  const signed = (url: string, fields: Record<string, string>) => {
    const material =
      url +
      Object.keys(fields)
        .sort()
        .map((key) => key + fields[key])
        .join("");
    const signature = createHmac("sha1", signingKey)
      .update(material)
      .digest("base64");
    return new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body: new URLSearchParams(fields),
    });
  };
  const send = async (
    input: {
      speech?: string;
      digits?: string;
      partial?: string;
      extra?: Record<string, string>;
    } = {},
  ) => {
    const fields: Record<string, string> = {
      CallSid: callSid,
      To: receivingNumber,
      From: callerNumber,
      ...input.extra,
    };
    if (input.speech !== undefined) fields.SpeechResult = input.speech;
    if (input.digits !== undefined) fields.Digits = input.digits;
    if (input.partial !== undefined)
      fields.UnstableSpeechResult = input.partial;
    const url = action;
    const response = await voice(signed(url, fields));
    assert.equal(response.status, 200);
    const xml = await response.text();
    const next = xml.match(/<Gather\b[^>]*action="([^"]+)"/)?.[1];
    if (next) action = next.replaceAll("&amp;", "&");
    return {
      xml,
      diagnostic: records().at(-1),
      replay: async () => {
        const replay = await voice(signed(url, fields));
        assert.equal(replay.status, 200);
        return { xml: await replay.text(), diagnostic: records().at(-1) };
      },
    };
  };
  return {
    send,
    callSid,
    state: () =>
      JSON.parse(getChannelState(`voice:${callSid}`)!) as {
        step: string;
        turn: string;
      },
  };
}

test("diagnostics distinguish initial and DTMF callbacks from final Mandarin speech and show actual step progress", async () => {
  const call = caller();
  const first = (await call.send()).diagnostic!;
  assert.equal(first.version, "mandarin-gather-2");
  assert.equal(first.turnState, "initial");
  assert.equal(first.speechField, "absent");
  assert.equal(first.input, "empty");
  assert.equal(first.stepBefore, null);
  assert.equal(first.stepAfter, "menu");
  assert.equal(first.cached, false);
  assert.equal(first.configuredLanguage, "cmn-Hans-CN");
  assert.equal(first.responseLanguage, "cmn-Hans-CN");

  const selected = (await call.send({ digits: "2" })).diagnostic!;
  assert.equal(selected.turnState, "current");
  assert.equal(selected.input, "digits");
  assert.equal(selected.speechField, "absent");
  assert.equal(selected.stepBefore, "menu");
  assert.equal(selected.stepAfter, "date");

  const result = await call.send({
    speech: "我要预约明天",
    extra: { Confidence: "0.91" },
  });
  const heard = result.diagnostic!;
  assert.equal(heard.speechField, "present");
  assert.equal(heard.speechLength, "我要预约明天".length);
  assert.equal(heard.input, "speech");
  assert.equal(heard.confidence, 0.91);
  assert.equal(heard.stepBefore, "date");
  assert.equal(heard.stepAfter, "court");
  assert.equal(heard.dateRecognized, true);
  assert.equal(
    heard.recognizedIntent,
    null,
    "date-step diagnostics do not reinterpret a date answer as a new booking intent",
  );
  assert.equal(heard.configuredLanguage, "cmn-Hans-CN");
  assert.equal(heard.responseLanguage, "cmn-Hans-CN");
  assert.equal(listBookings().length, 0);
  assert.ok(!printed.join("\n").includes("我要预约明天"));
});

test("partial-only and empty-final speech remain distinct and neither advances a date step nor creates an order", async () => {
  const call = caller();
  await call.send();
  await call.send({ digits: "2" });
  const partial = (await call.send({ partial: "我要预约明天" })).diagnostic!;
  assert.equal(partial.speechField, "absent");
  assert.equal(partial.speechLength, 0);
  assert.equal(partial.partialFieldPresent, true);
  assert.equal(partial.partialLength, "我要预约明天".length);
  assert.equal(partial.input, "empty");
  assert.equal(partial.stepBefore, "date");
  assert.equal(partial.stepAfter, "date");

  const empty = (await call.send({ speech: " \t " })).diagnostic!;
  assert.equal(empty.speechField, "empty");
  assert.equal(empty.speechLength, 0);
  assert.equal(empty.partialFieldPresent, false);
  assert.equal(empty.partialLength, 0);
  assert.equal(empty.stepAfter, "date");
  assert.equal(call.state().step, "date");
  assert.equal(listBookings().length, 0);
});

test("cached webhook retries are marked without consuming the speech twice", async () => {
  const call = caller();
  await call.send();
  const first = await call.send({ speech: "我要预约" });
  assert.equal(first.diagnostic!.recognizedIntent, "book");
  assert.equal(first.diagnostic!.cached, false);
  assert.equal(first.diagnostic!.stepAfter, "date");
  const state = call.state();
  const replay = await first.replay();
  assert.equal(replay.xml, first.xml);
  assert.equal(replay.diagnostic!.cached, true);
  assert.equal(replay.diagnostic!.stepBefore, "date");
  assert.equal(replay.diagnostic!.stepAfter, "date");
  assert.deepEqual(call.state(), state);
  assert.equal(listBookings().length, 0);
});

test("provider numeric errors are retained while invalid confidence, raw utterances and private fields never enter logs", async () => {
  const call = caller();
  await call.send();
  const rawPrivateSpeech =
    "机密测试 13900000000 visitor@example.invalid 1234567890 PRIVATE-FIXTURE";
  const rawPartial = "另一个机密 0412345678";
  const result = await call.send({
    speech: rawPrivateSpeech,
    partial: rawPartial,
    extra: {
      Confidence: "PRIVATE-CONFIDENCE-FIXTURE",
      ErrorCode: "12345",
      ManagementCode: "1234567890",
    },
  });
  assert.equal(result.diagnostic!.confidence, null);
  assert.equal(result.diagnostic!.providerErrorCode, "12345");
  assert.equal(result.diagnostic!.speechField, "present");
  assert.equal(result.diagnostic!.partialFieldPresent, true);

  const malformed = await call.send({
    speech: "",
    extra: { Confidence: "1.5", ErrorCode: rawPrivateSpeech },
  });
  assert.equal(malformed.diagnostic!.confidence, null);
  assert.equal(malformed.diagnostic!.providerErrorCode, null);
  const text = printed.join("\n");
  for (const privateValue of [
    rawPrivateSpeech,
    rawPartial,
    "13900000000",
    "visitor@example.invalid",
    "1234567890",
    "0412345678",
    "PRIVATE-CONFIDENCE-FIXTURE",
    callerNumber,
    receivingNumber,
    call.callSid,
    signingKey,
  ]) {
    assert.ok(
      !text.includes(privateValue),
      "diagnostics must never print transcript, contact, identifier, management code or credential values",
    );
  }
  assert.equal(listBookings().length, 0);
});

test("diagnostics remain disabled unless explicitly enabled", async () => {
  process.env.VOICE_DEBUG = "0";
  const call = caller();
  await call.send();
  await call.send({ digits: "2" });
  assert.deepEqual(printed, []);
  assert.equal(call.state().step, "date");
});
