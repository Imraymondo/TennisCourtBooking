import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { POST as voice } from "../app/api/webhooks/voice/route";
import { TIME_ZONE } from "../lib/domain";
import { closeDatabase, getChannelState, listBookings } from "../lib/store";

const WEBHOOK = "https://courts.example/api/webhooks/voice";

beforeEach(() => {
  closeDatabase();
  process.env.BOOKING_DB_PATH = ":memory:";
  process.env.APP_BASE_URL = "https://courts.example";
  process.env.TWILIO_AUTH_TOKEN = "test-only-voice-capture-key";
  process.env.TWILIO_PHONE_NUMBER = "+61255550100";
});
after(closeDatabase);

function attributes(tag: string): Record<string, string> {
  return Object.fromEntries(
    [...tag.matchAll(/([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g)].map((match) => [
      match[1],
      match[2].replaceAll("&amp;", "&"),
    ]),
  );
}

function assertMandarinCapture(xml: string) {
  const gather = xml.match(/<Gather\b[^>]*>/)?.[0];
  assert.ok(gather, "a listening prompt must include a Gather");
  assert.doesNotMatch(
    xml.slice(0, xml.indexOf(gather)),
    /<Say\b/,
    "availability and recovery guidance stays inside the listening Gather",
  );
  const attrs = attributes(gather);
  assert.equal(
    attrs.language,
    "cmn-Hans-CN",
    "Gather uses its Mandarin ASR language code",
  );
  assert.deepEqual(attrs.input.split(/\s+/).sort(), ["dtmf", "speech"]);
  assert.match(
    attrs.speechTimeout,
    /^[1-5]$/,
    "speech pause timeout is a bounded positive integer, not auto",
  );
  assert.ok(Number(attrs.timeout) > 0 && Number(attrs.timeout) <= 30);
  assert.equal(attrs.method, "POST");
  assert.equal(attrs.actionOnEmptyResult, "true");
  assert.match(
    attrs.action,
    /^https:\/\/courts\.example\/api\/webhooks\/voice\?turn=[a-f0-9-]{36}$/,
  );
  const sayTags = [...xml.matchAll(/<Say\b[^>]*>/g)].map((match) =>
    attributes(match[0]),
  );
  assert.ok(sayTags.length > 0, "the caller receives a spoken prompt");
  for (const say of sayTags) {
    assert.equal(
      say.language,
      "cmn-CN",
      "TTS and ASR use their separate Mandarin language codes",
    );
  }
  return attrs;
}

function caller() {
  const sid = "CA" + randomUUID().replaceAll("-", "");
  let action = WEBHOOK;
  return {
    state: () => JSON.parse(getChannelState(`voice:${sid}`)!),
    async send(speech = "", digits = "") {
      const fields: Record<string, string> = {
        CallSid: sid,
        To: process.env.TWILIO_PHONE_NUMBER!,
        From: "+61400123456",
        SpeechResult: speech,
        Digits: digits,
      };
      const material =
        action +
        Object.keys(fields)
          .sort()
          .map((key) => key + fields[key])
          .join("");
      const response = await voice(
        new Request(action, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-twilio-signature": createHmac(
              "sha1",
              process.env.TWILIO_AUTH_TOKEN!,
            )
              .update(material)
              .digest("base64"),
          },
          body: new URLSearchParams(fields),
        }),
      );
      assert.equal(response.status, 200);
      const xml = await response.text();
      const attrs = assertMandarinCapture(xml);
      action = attrs.action;
      return { xml, attrs };
    },
  };
}

test("emitted TwiML uses documented Gather Mandarin language, mixed capture, and a finite speech pause timeout", async () => {
  const call = caller();
  const initial = await call.send();
  assert.match(initial.xml, /欢迎使用/);
  assert.equal(initial.attrs.numDigits, "1");
  assert.equal(listBookings().length, 0);
});

test("pressing 2 then saying 我要预约明天 supplies a spoken date despite the eight-digit DTMF setting", async () => {
  const call = caller();
  await call.send();
  const datePrompt = await call.send("", "2");
  assert.match(datePrompt.xml, /哪一天/);
  assert.equal(datePrompt.attrs.numDigits, "8");
  const availability = await call.send("我要预约明天");
  const tomorrow = Temporal.Now.zonedDateTimeISO(TIME_ZONE)
    .toPlainDate()
    .add({ days: 1 })
    .toString();
  assert.equal(call.state().date, tomorrow);
  assert.equal(call.state().step, "court");
  assert.equal(call.state().duration || 2, 2);
  assert.match(availability.xml, /可开始时间/);
  assert.match(availability.xml, /1号场/);
  assert.match(availability.xml, /2号场/);
  assert.equal(listBookings().length, 0);
});

test("every pending booking prompt keeps speech capture enabled while only final confirmation can write", async () => {
  const call = caller();
  await call.send();
  assert.match((await call.send("我要预定球场")).xml, /哪一天/);
  await call.send("2099年12月1日");
  await call.send("一号球场");
  await call.send("下午三点");
  await call.send("默认");
  const contact = await call.send("我叫李四");
  assert.match(contact.xml, /联系电话/);
  const summary = await call.send("使用来电号码");
  assert.match(summary.xml, /预约人李四/);
  assert.equal(call.state().step, "confirm");
  assert.equal(listBookings().length, 0);
});
