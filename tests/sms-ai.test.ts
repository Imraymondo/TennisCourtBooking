import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { after, beforeEach, test } from "node:test";
import { POST as sms } from "../app/api/webhooks/sms/route";
import { closeDatabase, getAvailability, listBookings } from "../lib/store";

beforeEach(() => {
  closeDatabase();
  Object.assign(process.env, {
    BOOKING_DB_PATH: ":memory:",
    BOOKING_AI_ENABLED: "1",
    OPENAI_API_KEY: "test-only-sms-ai-key",
    OPENAI_MODEL: "",
    APP_BASE_URL: "https://sms-ai.example",
    TWILIO_AUTH_TOKEN: "test-only-sms-ai-signing-key",
    TWILIO_PHONE_NUMBER: "+61255550100",
  });
});
after(closeDatabase);

function signedMessage(
  text: string,
  sid = "SM" + randomUUID().replaceAll("-", ""),
) {
  const url = `${process.env.APP_BASE_URL}/api/webhooks/sms`;
  const fields: Record<string, string> = {
    MessageSid: sid,
    Body: text,
    From: "+61400123456",
    To: process.env.TWILIO_PHONE_NUMBER!,
  };
  const signature = createHmac("sha1", process.env.TWILIO_AUTH_TOKEN!)
    .update(
      url +
        Object.keys(fields)
          .sort()
          .map((key) => key + fields[key])
          .join(""),
    )
    .digest("base64");
  return () =>
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body: new URLSearchParams(fields),
    });
}

test("signed natural SMS uses GPT fields, reviews before writing, and replays both proposal and confirmation once", async (t) => {
  let calls = 0;
  t.mock.method(
    https,
    "request",
    (
      _url: string,
      _options: https.RequestOptions,
      callback: (response: EventEmitter) => void,
    ) => {
      calls++;
      const request = new EventEmitter() as EventEmitter & {
        end: (body: string) => void;
      };
      request.end = (body) => {
        const payload = JSON.parse(body);
        assert.equal(JSON.parse(payload.input).context.channel, "sms");
        assert.equal(payload.store, false);
        queueMicrotask(() => {
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
            destroy: () => void;
          };
          response.statusCode = 200;
          response.destroy = () => {};
          callback(response);
          response.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                status: "completed",
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [
                      {
                        type: "output_text",
                        text: JSON.stringify({
                          scope: "booking",
                          action: "book",
                          date: "2099-12-01",
                          court: 1,
                          hour: "15",
                          duration: 2,
                          name: "智能球友",
                          correction: null,
                        }),
                      },
                    ],
                  },
                ],
              }),
            ),
          );
          response.emit("end");
        });
      };
      return request;
    },
  );
  syncBuiltinESMExports();
  try {
    const message = signedMessage(
      "帮我留2099年12月1日下午三点的一号场打两小时，我叫智能球友",
    );
    const proposed = await sms(message());
    assert.equal(proposed.status, 200);
    const summary = await proposed.text();
    assert.match(summary, /确认预约/);
    assert.match(summary, /智能球友/);
    assert.equal(listBookings().length, 0);
    assert.equal(calls, 1);
    assert.equal(await (await sms(message())).text(), summary);
    assert.equal(
      calls,
      1,
      "Twilio retries do not trigger another OpenAI request",
    );
    const confirmation = signedMessage("确认预约");
    const committed = await sms(confirmation());
    assert.equal(committed.status, 200);
    const receipt = await committed.text();
    assert.match(receipt, /已确认/);
    assert.match(receipt, /管理码/);
    assert.equal(listBookings().length, 1);
    assert.equal(listBookings()[0].customerName, "智能球友");
    assert.equal(listBookings()[0].phone, "+61400123456");
    assert.equal(listBookings()[0].source, "sms");
    assert.equal(calls, 1, "explicit confirmation stays outside the model");
    assert.equal(await (await sms(confirmation())).text(), receipt);
    assert.equal(listBookings().length, 1);
    const schedule = JSON.stringify(getAvailability("2099-12-01"));
    assert.ok(schedule.includes("智能球友"));
    assert.ok(!schedule.includes("+61400123456"));
    assert.ok(!schedule.includes('"accessCode"'));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
