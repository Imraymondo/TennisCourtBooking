import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  interpretBookingText,
  bookingAIEnabled,
  type BookingAIContext,
  type BookingInterpretation,
} from "../lib/channels/booking-ai";

const variables = ["BOOKING_AI_ENABLED", "OPENAI_API_KEY", "OPENAI_MODEL"];
const original = Object.fromEntries(
  variables.map((name) => [name, process.env[name]]),
);
const fakeKey = "test-only-openai-key-never-valid";
const context: BookingAIContext = { channel: "phone", step: "menu" };
const utterance = "给我留明天傍晚六点的一号场，打三个小时，我叫张三";
const interpretation: BookingInterpretation = {
  scope: "booking",
  action: "book",
  date: "2099-12-01",
  court: 1,
  hour: "18",
  duration: 3,
  name: "张三",
  correction: null,
};

beforeEach(() => {
  process.env.BOOKING_AI_ENABLED = "1";
  process.env.OPENAI_API_KEY = fakeKey;
  process.env.OPENAI_MODEL = "";
});
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  for (const variable of variables) {
    if (original[variable] === undefined) delete process.env[variable];
    else process.env[variable] = original[variable];
  }
});

function envelope(value: unknown = interpretation) {
  return {
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(value) }],
      },
    ],
  };
}

function provider(
  options: {
    status?: number;
    body?: unknown;
    raw?: string;
    error?: boolean;
    aborted?: boolean;
  } = {},
) {
  const calls: {
    url: string;
    options: https.RequestOptions;
    body: Record<string, unknown>;
  }[] = [];
  mock.method(
    https,
    "request",
    (
      url: string,
      requestOptions: https.RequestOptions,
      callback: (response: EventEmitter) => void,
    ) => {
      const request = new EventEmitter() as EventEmitter & {
        end: (body: string) => void;
      };
      request.end = (body) => {
        calls.push({ url, options: requestOptions, body: JSON.parse(body) });
        queueMicrotask(() => {
          if (
            options.error ||
            options.aborted ||
            requestOptions.signal?.aborted
          ) {
            request.emit(
              "error",
              new Error("fake provider failure, never display " + fakeKey),
            );
            return;
          }
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
            destroy: () => void;
          };
          response.statusCode = options.status ?? 200;
          response.destroy = () =>
            response.emit("error", new Error("destroyed fake response"));
          callback(response);
          response.emit(
            "data",
            Buffer.from(
              options.raw ?? JSON.stringify(options.body ?? envelope()),
            ),
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

test("GPT uses the official Responses endpoint, bounded strict schema, server credentials and whitelisted context", async () => {
  const calls = provider();
  const result = await interpretBookingText(utterance, {
    ...context,
    date: "2099-11-30",
    court: 2,
    name: "private-context-name",
    code: "fake-management-code",
    phone: "+61000000000",
  } as BookingAIContext);
  assert.deepEqual(result, interpretation);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, "https://api.openai.com/v1/responses");
  assert.equal(call.options.method, "POST");
  assert.equal(
    (call.options.headers as Record<string, string>).authorization,
    `Bearer ${fakeKey}`,
  );
  assert.ok(call.options.signal);
  assert.equal(call.body.model, "gpt-4.1-mini");
  assert.equal(call.body.store, false);
  assert.equal(call.body.max_output_tokens, 650);
  assert.equal(
    call.body.tools,
    undefined,
    "the interpreter cannot access tools or the database",
  );
  const input = JSON.parse(call.body.input as string);
  assert.equal(input.timeZone, "Australia/Sydney");
  assert.match(input.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(input.context, { ...context, date: "2099-11-30", court: 2 });
  assert.equal(input.utterance, utterance.normalize("NFKC"));
  const format = (
    call.body.text as {
      format: {
        type: string;
        strict: boolean;
        schema: {
          additionalProperties: boolean;
          required: string[];
          properties: object;
        };
      };
    }
  ).format;
  assert.equal(format.type, "json_schema");
  assert.equal(format.strict, true);
  assert.equal(format.schema.additionalProperties, false);
  assert.equal(format.schema.required.length, 8);
  assert.equal(Object.hasOwn(format.schema.properties, "confirmation"), false);
  for (const privateValue of [
    fakeKey,
    "private-context-name",
    "fake-management-code",
    "+61000000000",
  ])
    assert.ok(!JSON.stringify(call.body).includes(privateValue));
});

test("disabled, missing-key, invalid model and sensitive turns never contact a provider", async () => {
  const calls = provider();
  process.env.BOOKING_AI_ENABLED = "0";
  assert.equal(bookingAIEnabled(), false);
  assert.equal(await interpretBookingText(utterance, context), null);
  process.env.BOOKING_AI_ENABLED = "1";
  process.env.OPENAI_API_KEY = "";
  assert.equal(bookingAIEnabled(), false);
  assert.equal(await interpretBookingText(utterance, context), null);
  process.env.OPENAI_API_KEY = fakeKey;
  process.env.OPENAI_MODEL = "unsafe\nmodel";
  assert.equal(await interpretBookingText(utterance, context), null);
  process.env.OPENAI_MODEL = "";
  for (const step of ["id", "code", "contact", "credentials"])
    assert.equal(
      await interpretBookingText(utterance, { ...context, step }),
      null,
    );
  for (const text of [
    "我的电话+61400123456",
    "管理码是1234567890",
    "预约编号12345678",
    "0412 345 678",
    "联系电话零四一二三四五六七八",
    "零四一二三四五六七八",
    "邮箱是alice@example.invalid",
    "管理碼是一二三四五六七八九零",
    "預約編號一二三四五六七八",
    "api key sk-placeholder",
    "",
    "a".repeat(1001),
  ])
    assert.equal(await interpretBookingText(text, context), null);
  assert.equal(calls.length, 0);
});

test("ISO dates are not treated as contacts, and model selection can be configured", async () => {
  const calls = provider({ body: envelope({ ...interpretation, name: null }) });
  process.env.OPENAI_MODEL = "gpt-4.1-mini-2025-04-14";
  assert.ok(
    await interpretBookingText("帮我订2099-12-01傍晚六点的一号场", context),
  );
  assert.equal(calls[0].body.model, "gpt-4.1-mini-2025-04-14");
});

test("partial-hour requests cannot be rounded into valid model bookings", async () => {
  const calls = provider();
  for (const text of [
    "下午三点半订球场",
    "我要15:30的球场",
    "预约1.5小时",
    "预约一个半小时",
    "预约两个半小时",
    "我要24:00的球场",
    "half an hour",
    "三点一刻开始",
  ])
    assert.equal(await interpretBookingText(text, context), null);
  assert.equal(calls.length, 0);
});

test("invalid or invented structured fields and extra confirmation fields are rejected locally", async () => {
  for (const fields of [
    { hour: "24" },
    { hour: "8" },
    { duration: 1.5 },
    { duration: 9 },
    { court: 3 },
    { date: "2099-02-30" },
    { name: "原话没有的姓名" },
    { confirmation: true },
    { action: "delete_database" },
  ]) {
    mock.restoreAll();
    syncBuiltinESMExports();
    provider({ body: envelope({ ...interpretation, ...fields }) });
    assert.equal(await interpretBookingText(utterance, context), null);
  }
});

test("provider failures, incomplete outputs, refusal, tools, malformed JSON and oversized replies fall back without retries", async () => {
  for (const options of [
    { status: 401 },
    { status: 429 },
    { error: true },
    { body: { ...envelope(), status: "incomplete" } },
    { body: { ...envelope(), error: { message: fakeKey } } },
    {
      body: {
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "refusal", refusal: "declined" }],
          },
        ],
      },
    },
    {
      body: {
        status: "completed",
        output: [{ type: "function_call", name: "createBooking" }],
      },
    },
    { raw: "not-json" },
    { raw: "a".repeat(65_537) },
  ]) {
    mock.restoreAll();
    syncBuiltinESMExports();
    const calls = provider(options);
    assert.equal(await interpretBookingText(utterance, context), null);
    assert.equal(
      calls.length,
      1,
      "there are no API retries inside a phone callback",
    );
  }
});

test("the provider has a four-second total deadline and abort safely returns to the existing flow", async () => {
  let deadline: number | undefined;
  mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    deadline = milliseconds;
    return AbortSignal.abort();
  });
  const calls = provider({ aborted: true });
  assert.equal(await interpretBookingText(utterance, context), null);
  assert.equal(deadline, 4000);
  assert.equal(calls.length, 1);
});
