import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { BookingInterpretation } from "../lib/channels/booking-ai";
import { COMMAND_HELP, executeCommand } from "../lib/channels/commands";
import { createTextAssistant } from "../lib/channels/text-assistant";
import {
  closeDatabase,
  createBooking,
  getBooking,
  getChannelState,
  hash,
  listBookings,
  updateBooking,
} from "../lib/store";

const PHONE = "+61400123456";
const OTHER_PHONE = "+61400987654";
const identity = (phone = PHONE) => ({ channel: "sms" as const, phone });
const event = () => `sms:SM${randomUUID().replaceAll("-", "")}`;
const parsed = (
  fields: Partial<BookingInterpretation> = {},
): BookingInterpretation => ({
  scope: "booking",
  action: null,
  date: null,
  court: null,
  hour: null,
  duration: null,
  name: null,
  correction: null,
  ...fields,
});
const complete = (fields: Partial<BookingInterpretation> = {}) =>
  parsed({
    action: "book",
    date: "2099-12-01",
    court: 1,
    hour: "14",
    name: "小王",
    ...fields,
  });

beforeEach(() => {
  closeDatabase();
  process.env.BOOKING_DB_PATH = ":memory:";
  process.env.BOOKING_AI_ENABLED = "1";
  process.env.OPENAI_API_KEY = "test-key-no-network";
});
after(closeDatabase);

function scripted(values: (BookingInterpretation | null)[]) {
  const calls: string[] = [];
  const handler = createTextAssistant(async (text) => {
    calls.push(text);
    assert.ok(values.length, `Unexpected model call: ${text}`);
    return values.shift()!;
  });
  return {
    calls,
    handler,
    send: (text: string, phone = PHONE, key = event()) =>
      handler(text, identity(phone), key),
  };
}

test("SMS collects natural fields, summarizes before writing, and uses only the verified sender", async () => {
  const flow = scripted([
    parsed({ action: "book", date: "2099-12-01", court: 1 }),
    parsed({ hour: "14" }),
    parsed({ name: "小王" }),
  ]);
  assert.match(await flow.send("我想在十二月一日订一号场"), /整点时间/);
  assert.match(await flow.send("下午两点"), /姓名/);
  const summary = await flow.send("叫小王");
  assert.match(summary, /14:00.*1号场.*2小时.*小王/);
  assert.match(summary, /确认预约/);
  assert.equal(listBookings().length, 0);
  const key = event();
  const result = await flow.send("确认预约", PHONE, key);
  assert.match(result, /管理码：\d{10}/);
  assert.equal(listBookings().length, 1);
  assert.equal(listBookings()[0].phone, PHONE);
  assert.equal(listBookings()[0].source, "sms");
  assert.equal(listBookings()[0].durationHours, 2);
  assert.equal(await flow.send("确认预约", PHONE, key), result);
  assert.match(await flow.send("确认预约"), /没有待确认/);
  assert.equal(flow.calls.length, 3);
  assert.equal(getChannelState(`sms:draft:${PHONE}`), null);
  assert.ok(getChannelState(`sms:draft:${hash(PHONE)}`));
});

test("negative language takes priority over confirmation and clears the pending action", async () => {
  const flow = scripted([complete()]);
  await flow.send("帮我预约一号场");
  assert.match(await flow.send("不要，确认预约"), /已放弃/);
  assert.match(await flow.send("确认预约"), /没有待确认/);
  assert.equal(listBookings().length, 0);
  assert.equal(flow.calls.length, 1);
});

test("corrections require a new summary; unclear and unavailable model responses preserve a draft", async () => {
  const flow = scripted([
    complete(),
    parsed({ action: "change", correction: "court", court: 2 }),
    null,
    parsed({ scope: "off_topic" }),
  ]);
  await flow.send("预约一号场");
  const corrected = await flow.send("改成二号场");
  assert.match(corrected, /2号场/);
  assert.match(corrected, /确认预约/);
  assert.equal(listBookings().length, 0);
  assert.match(await flow.send("模糊的话"), /尚未执行/);
  assert.match(await flow.send("帮我写首诗"), /只能帮助/);
  await flow.send("确认预约");
  assert.equal(listBookings()[0].courtId, 2);
});

test("an invalid correction invalidates the old confirmation instead of silently booking old fields", async () => {
  const flow = scripted([
    complete(),
    parsed({ correction: "date", date: "2000-01-01" }),
  ]);
  await flow.send("预约一号场");
  assert.match(await flow.send("改到过去的日期"), /未来/);
  assert.match(await flow.send("确认预约"), /尚未完成/);
  assert.equal(listBookings().length, 0);
});

test("availability comes from the store and final booking rechecks a newly occupied slot", async () => {
  const flow = scripted([
    parsed({ action: "query", date: "2099-12-01", court: 1 }),
    complete(),
    parsed({ correction: "hour", hour: "17" }),
  ]);
  const availability = await flow.send("十二月一号一号场有什么空位");
  assert.match(availability, /可开始时间/);
  assert.doesNotMatch(availability, /2号场/);
  await flow.send("帮我订下午两点");
  createBooking({
    courtId: 1,
    startLocal: "2099-12-01T14:00",
    customerName: "其他客人",
    phone: OTHER_PHONE,
  });
  assert.match(await flow.send("确认预约"), /已被预约/);
  assert.equal(listBookings().length, 1);
  assert.match(await flow.send("确认预约"), /尚未完成/);
  assert.match(await flow.send("那改下午五点"), /17:00/);
  await flow.send("确认预约");
  assert.equal(listBookings().length, 2);
});

test("legacy exact commands and disabled AI retain their established direct behavior", async () => {
  const flow = scripted([]);
  assert.equal(await flow.send("HELP"), COMMAND_HELP);
  assert.match(await flow.send("查询 2099-12-01 1"), /可开始时间/);
  const first = await flow.send("预订 1 2099-12-01 10:00 张三");
  const id = first.match(/预约(\d{8})/)![1];
  const code = first.match(/管理码：(\d{10})/)![1];
  assert.equal(listBookings().length, 1);
  assert.match(await flow.send(`查看 ${id} ${code}`), new RegExp(id));
  assert.match(
    await flow.send(`修改 ${id} ${code} 2 2099-12-02 12:00 3`),
    /2号场/,
  );
  assert.match(await flow.send(`取消 ${id} ${code}`), /已取消/);
  process.env.BOOKING_AI_ENABLED = "0";
  assert.match(await flow.send("帮我预约明天"), /无法识别指令/);
  assert.match(await flow.send("BOOK 1 2099-12-03 10:00 Alice"), /管理码/);
  assert.equal(flow.calls.length, 0);
});

test("sender drafts are isolated, and concurrent redelivery calls the model and writes once", async () => {
  let resolve!: (value: BookingInterpretation) => void;
  let calls = 0;
  const handler = createTextAssistant(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const key = event();
  const first = handler("预约球场", identity(), key);
  const replay = handler("预约球场", identity(), key);
  assert.equal(calls, 1);
  resolve(complete());
  assert.equal(await first, await replay);
  assert.match(
    await handler("确认预约", identity(OTHER_PHONE), event()),
    /没有待确认/,
  );
  const confirmationKey = event();
  const results = await Promise.all([
    handler("确认预约", identity(), confirmationKey),
    handler("确认预约", identity(), confirmationKey),
  ]);
  assert.equal(results[0], results[1]);
  assert.equal(listBookings().length, 1);
  assert.equal(calls, 1);
});

test("a slow older interpretation cannot replace a newer sender draft or resurrect a denial", async () => {
  let finish!: (value: BookingInterpretation) => void;
  const handler = createTextAssistant(async (text) => {
    if (text === "旧请求")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return complete({ court: 2 });
  });
  const old = handler("旧请求", identity(), event());
  await handler("新请求", identity(), event());
  finish(complete({ court: 1 }));
  assert.match(await old, /旧消息/);
  await handler("确认预约", identity(), event());
  assert.equal(listBookings()[0].courtId, 2);
  const anotherOld = handler("旧请求", identity(), event());
  await handler("算了", identity(), event());
  finish(complete({ hour: "18" }));
  assert.match(await anotherOld, /旧消息/);
  assert.match(await handler("确认预约", identity(), event()), /没有待确认/);
  assert.equal(listBookings().length, 1);
});

test("natural management credentials stay local; changes and cancellations each need a separate confirmation", async () => {
  const created = createBooking({
    courtId: 1,
    startLocal: "2099-12-01T10:00",
    customerName: "原姓名",
    phone: PHONE,
  });
  const { id } = created.booking;
  const code = created.accessCode;
  const flow = scripted([
    parsed({
      action: "change",
      date: "2099-12-02",
      court: 2,
      hour: "12",
      duration: 3,
    }),
    parsed({ action: "view" }),
    parsed({ action: "cancel" }),
  ]);
  assert.match(
    await flow.send("帮我把原预约改到十二月二日中午二号场三小时"),
    /八位/,
  );
  assert.match(await flow.send(`编号${id} 管理码${code}`), /确认修改/);
  assert.equal(getBooking(id, code).version, 1);
  await flow.send("确认修改");
  assert.equal(getBooking(id, code).version, 2);
  assert.equal(getBooking(id, code).courtId, 2);
  assert.equal(getBooking(id, code).durationHours, 3);
  await flow.send("帮我查看预约");
  assert.match(await flow.send(`编号${id} 管理码${code}`), new RegExp(id));
  await flow.send("帮我取消原来的预约");
  assert.match(await flow.send(`编号${id} 管理码${code}`), /确认取消/);
  assert.equal(getBooking(id, code).status, "confirmed");
  await flow.send("确认取消");
  assert.equal(getBooking(id, code).status, "cancelled");
  assert.equal(flow.calls.length, 3);
  assert.ok(
    flow.calls.every((text) => !text.includes(id) && !text.includes(code)),
  );
});

test("credentials can precede change details, wrong codes and stale versions cannot mutate a booking", async () => {
  const created = createBooking({
    courtId: 1,
    startLocal: "2099-12-01T10:00",
    customerName: "原姓名",
    phone: PHONE,
  });
  const { id } = created.booking;
  const code = created.accessCode;
  const flow = scripted([parsed({ hour: "15" })]);
  assert.match(await flow.send(`请修改 编号${id} 管理码0000000000`), /不正确/);
  assert.match(await flow.send("确认修改"), /尚未完成/);
  assert.match(await flow.send(`请修改 编号${id} 管理码${code}`), /需要修改/);
  assert.match(await flow.send("改成下午三点"), /确认修改/);
  updateBooking(
    id,
    {
      courtId: 1,
      startLocal: "2099-12-02T10:00",
      customerName: "原姓名",
      phone: PHONE,
      version: 1,
    },
    code,
  );
  assert.match(await flow.send("确认修改"), /已被更新/);
  assert.equal(getBooking(id, code).version, 2);
  assert.equal(getBooking(id, code).startsAt, "2099-12-01T23:00:00Z");
  const cancelled = executeCommand(`查看 ${id} ${code}`, identity());
  assert.match(cancelled, /已确认/);
});

test("natural date changes retain an original duration that the user did not change", async () => {
  const created = createBooking({
    courtId: 1,
    startLocal: "2099-12-01T10:00",
    durationHours: 3,
    customerName: "原姓名",
    phone: PHONE,
  });
  const flow = scripted([parsed({ action: "change", date: "2099-12-03" })]);
  await flow.send("帮我改到十二月三日");
  const summary = await flow.send(
    `编号${created.booking.id} 管理码${created.accessCode}`,
  );
  assert.match(summary, /3小时/);
  await flow.send("确认修改");
  assert.equal(
    getBooking(created.booking.id, created.accessCode).durationHours,
    3,
  );
});

test("credential-bearing changes reject fractional, ambiguous or out-of-range times locally", async () => {
  const created = createBooking({
    courtId: 1,
    startLocal: "2099-12-01T10:00",
    customerName: "原姓名",
    phone: PHONE,
  });
  const flow = scripted([]);
  for (const fields of [
    "14点半",
    "下午2点",
    "14:30",
    "24:00",
    "12小时",
    "1.5小时",
    "十二小时",
  ]) {
    assert.match(
      await flow.send(
        `请修改 编号${created.booking.id} 管理码${created.accessCode} 2099-12-02 ${fields}`,
      ),
      /整点|完整小时/,
    );
    await flow.send("确认修改");
    assert.equal(getBooking(created.booking.id, created.accessCode).version, 1);
  }
  assert.equal(flow.calls.length, 0);
});

test("invalid credential corrections invalidate a pending change until a new summary is reviewed", async () => {
  for (const invalid of ["14:30", "1.5小时"]) {
    closeDatabase();
    const created = createBooking({
      courtId: 1,
      startLocal: "2099-12-01T10:00",
      customerName: "原姓名",
      phone: PHONE,
    });
    const flow = scripted([
      parsed({ action: "change", hour: "12" }),
      parsed({ correction: "hour", hour: "14" }),
    ]);
    await flow.send("帮我改到中午十二点");
    const credentials = `编号${created.booking.id} 管理码${created.accessCode}`;
    assert.match(await flow.send(credentials), /确认修改/);
    assert.match(
      await flow.send(`请修改 ${credentials} ${invalid}`),
      /整点|完整小时/,
    );
    assert.match(await flow.send("确认修改"), /尚未完成/);
    assert.equal(getBooking(created.booking.id, created.accessCode).version, 1);
    assert.match(await flow.send("改到下午两点"), /14:00.*确认修改/);
    await flow.send("确认修改");
    assert.equal(getBooking(created.booking.id, created.accessCode).version, 2);
    assert.equal(
      getBooking(created.booking.id, created.accessCode).startsAt,
      "2099-12-01T03:00:00Z",
    );
  }
});

test("change availability excludes the original booking and includes conflicts after midnight", async () => {
  const created = createBooking({
    courtId: 1,
    startLocal: "2099-12-01T22:00",
    customerName: "原姓名",
    phone: PHONE,
  });
  createBooking({
    courtId: 1,
    startLocal: "2099-12-02T00:00",
    customerName: "其他客人",
    phone: OTHER_PHONE,
  });
  const flow = scripted([parsed({ correction: "hour", hour: "21" })]);
  assert.match(
    await flow.send(
      `请修改 编号${created.booking.id} 管理码${created.accessCode} 2099-12-01 23:00 1号场 2小时`,
    ),
    /已被预约/,
  );
  assert.match(await flow.send("改到晚上九点"), /确认修改/);
  await flow.send("确认修改");
  assert.equal(getBooking(created.booking.id, created.accessCode).version, 2);
});

test("cached retries do not consume another SMS rate-limit allowance", async () => {
  const flow = scripted([]);
  const key = event();
  await flow.send("HELP", PHONE, key);
  await flow.send("HELP", PHONE, key);
  for (let count = 1; count < 30; count++) await flow.send("HELP");
  await assert.rejects(flow.send("HELP"), /过于频繁/);
});
