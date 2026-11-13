import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripSpeech,
  parseIntent,
  parseCalendarDate,
  parseCourtSpeech,
  parseHourSpeech,
  parseDurationSpeech,
  parsePhoneSpeech,
  parseNameSpeech,
  explicitConfirmation,
  usesCallerNumber,
  isOffTopic,
} from "../lib/channels/voice-input";

test("normalizes transcription punctuation and full-width numbers while preserving structured values", () => {
  assert.equal(stripSpeech("  下午３：００。 "), "下午3:00");
  assert.equal(stripSpeech("＋６１ ４１２ ３４５ ６７８。"), "+61 412 345 678");
  assert.equal(stripSpeech(" John   Smith! "), "John Smith");
});

test("recognizes only one booking intent and avoids interpreting availability questions as a reservation", () => {
  assert.equal(parseIntent("我想预订明天下午三点的一号球场"), "book");
  assert.equal(parseIntent("帮我查询目前可用的时间段"), "query");
  assert.equal(parseIntent("明天还有空闲球场可以预订吗"), "query");
  assert.equal(parseIntent("修改我的预约"), "change");
  assert.equal(parseIntent("取消我的预订"), "cancel");
  assert.equal(parseIntent("查看我的预约"), "view");
  assert.equal(parseIntent("查询我的预约"), "view");
  assert.equal(parseIntent("不要取消"), null);
  assert.equal(parseIntent("修改或者取消我的预约"), null);
  assert.equal(parseIntent("给我讲个笑话再预约"), null);
});

test("relative dates and weekdays use the supplied Sydney calendar date", () => {
  const friday = "2026-11-06";
  assert.equal(parseCalendarDate("今天", friday), "2026-11-06");
  assert.equal(parseCalendarDate("我想约明天下午三点", friday), "2026-11-07");
  assert.equal(parseCalendarDate("后天", friday), "2026-11-08");
  assert.equal(parseCalendarDate("大后天", friday), "2026-11-09");
  assert.equal(parseCalendarDate("周六", friday), "2026-11-07");
  assert.equal(parseCalendarDate("星期日", friday), "2026-11-08");
  assert.equal(parseCalendarDate("下周一", friday), "2026-11-09");
  assert.equal(parseCalendarDate("下下周一", friday), "2026-11-16");
  assert.equal(parseCalendarDate("星期五", friday), friday);
  assert.equal(parseCalendarDate("周末", friday), null);
  assert.equal(parseCalendarDate("明天或者后天", friday), null);
});

test("calendar dates parse Chinese numerals, years and year boundaries without accepting impossible dates", () => {
  assert.equal(parseCalendarDate("十一月十日", "2026-11-06"), "2026-11-10");
  assert.equal(parseCalendarDate("2030年1月2日", "2026-11-06"), "2030-01-02");
  assert.equal(parseCalendarDate("2030年1月2", "2026-11-06"), "2030-01-02");
  assert.equal(
    parseCalendarDate("二零三零年一月二号", "2026-11-06"),
    "2030-01-02",
  );
  assert.equal(
    parseCalendarDate("两千零三十年十一月二十三日", "2026-11-06"),
    "2030-11-23",
  );
  assert.equal(parseCalendarDate("20300102", "2026-11-06"), "2030-01-02");
  assert.equal(parseCalendarDate("2030-01-02", "2026-11-06"), "2030-01-02");
  assert.equal(parseCalendarDate("一月二日", "2026-12-31"), "2027-01-02");
  assert.equal(parseCalendarDate("明天", "2026-12-31"), "2027-01-01");
  assert.equal(parseCalendarDate("下个月三号", "2026-12-31"), "2027-01-03");
  assert.equal(parseCalendarDate("2030年2月30日", "2026-11-06"), null);
  assert.equal(parseCalendarDate("2030-02-30", "2026-11-06"), null);
  assert.equal(parseCalendarDate("十三月十日", "2026-11-06"), null);
  assert.equal(parseCalendarDate("十一月十日或十一日", "2026-11-06"), null);
});

test("matching relative and explicit spoken dates describe one Sydney calendar day", () => {
  for (const text of [
    "明天11月13号",
    "明天十一月十三号",
    "明天，１１月１３號。",
    "明日十一月十三號",
    "11月13号，也就是明天",
    "明天2026年11月13日",
    "明天2026-11-13",
    "明天11月13号星期五",
    "明天十一月十三号禮拜五",
  ]) {
    assert.equal(parseCalendarDate(text, "2026-11-12"), "2026-11-13", text);
  }
  assert.equal(
    parseCalendarDate("下周一，11月16日", "2026-11-12"),
    "2026-11-16",
  );
  assert.equal(
    parseCalendarDate("明天2027年1月1日星期五", "2026-12-31"),
    "2027-01-01",
  );
  assert.equal(parseCalendarDate("明天一月一号", "2026-12-31"), "2027-01-01");
});

test("matching dates remain unselected when spoken as explicit alternatives", () => {
  for (const text of [
    "明天或11月13号",
    "明天或者十一月十三号",
    "明天还是11月13日",
    "明天還是十一月十三號",
    "明天、11月13号",
    "明天要不11月13号",
  ]) {
    assert.equal(parseCalendarDate(text, "2026-11-12"), null, text);
  }
});

test("conflicting and invalid date mentions cannot hide behind a valid date", () => {
  for (const text of [
    "明天11月14号",
    "明天11月13号星期六",
    "11月13号11月14号",
    "明天2027年11月13号",
    "明天13月13号",
    "13月13号明天",
    "明天11月31号",
    "11月31号明天",
    "明天2026年2月30号",
    "2026年2月30号明天",
    "明天2026-02-30",
    "2026-02-30明天",
  ]) {
    assert.equal(parseCalendarDate(text, "2026-11-12"), null, text);
  }
  assert.equal(parseCalendarDate("明天1月2日", "2026-12-31"), null);
  assert.equal(parseCalendarDate("明天1月1日星期六", "2026-12-31"), null);
  assert.equal(parseCalendarDate("不知道哪天", "2026-11-12"), null);
});

test("whole-hour parser understands Chinese AM/PM and rejects fractional or ambiguous ranges", () => {
  assert.equal(parseHourSpeech("下午三点"), "15");
  assert.equal(parseHourSpeech("晚上十一点"), "23");
  assert.equal(parseHourSpeech("零点"), "00");
  assert.equal(parseHourSpeech("凌晨十二点"), "00");
  assert.equal(parseHourSpeech("中午十二点整"), "12");
  assert.equal(parseHourSpeech("上午九点"), "09");
  assert.equal(parseHourSpeech("下午十五点"), "15");
  assert.equal(parseHourSpeech("15:00"), "15");
  assert.equal(parseHourSpeech("三点零分"), "03");
  assert.equal(parseHourSpeech("下午三点半"), null);
  assert.equal(parseHourSpeech("15:30"), null);
  assert.equal(parseHourSpeech("下午三点十五分"), null);
  assert.equal(parseHourSpeech("下午三点十五"), null);
  assert.equal(parseHourSpeech("三点过十分"), null);
  assert.equal(parseHourSpeech("三点后五分钟"), null);
  assert.equal(parseHourSpeech("三点一刻"), null);
  assert.equal(parseHourSpeech("下午三点到五点"), null);
  assert.equal(parseHourSpeech("24:00"), null);
  assert.equal(parseHourSpeech("晚上十二点"), null);
});

test("court selection accepts either-court preference but never silently chooses between conflicting court numbers", () => {
  assert.equal(parseCourtSpeech("一号场"), 1);
  assert.equal(parseCourtSpeech("我要二号球场"), 2);
  assert.equal(parseCourtSpeech("选择第一个场地"), 1);
  assert.equal(parseCourtSpeech("我想预订明天下午三点的一号球场"), 1);
  assert.equal(parseCourtSpeech("我要十一月一号下午三点"), null);
  assert.equal(parseCourtSpeech("两个场地"), 0);
  assert.equal(parseCourtSpeech("都可以"), 0);
  assert.equal(parseCourtSpeech("0"), 0);
  assert.equal(parseCourtSpeech("1号或者2号"), null);
  assert.equal(parseCourtSpeech("三号场"), null);
});

test("duration uses the two-hour default and rejects fractional, zero, excessive or conflicting requests", () => {
  assert.equal(parseDurationSpeech("默认"), 2);
  assert.equal(parseDurationSpeech("两个小时"), 2);
  assert.equal(parseDurationSpeech("我想打三个小时"), 3);
  assert.equal(parseDurationSpeech("8小时"), 8);
  assert.equal(parseDurationSpeech("一个半小时"), null);
  assert.equal(parseDurationSpeech("2.5小时"), null);
  assert.equal(parseDurationSpeech("90分钟"), null);
  assert.equal(parseDurationSpeech("0小时"), null);
  assert.equal(parseDurationSpeech("9小时"), null);
  assert.equal(parseDurationSpeech("默认三小时"), null);
  assert.equal(parseDurationSpeech("两小时或者三小时"), null);
});

test("an English name leaves Chinese schedule fields and their validation intact", () => {
  assert.equal(parseHourSpeech("下午三点，我叫O'Neil"), "15");
  assert.equal(parseDurationSpeech("两个小时，我叫O'Neil"), 2);
  assert.equal(parseHourSpeech("下午三点二分，我叫O'Neil"), null);
  assert.equal(parseHourSpeech("下午三点到五点，我叫O'Neil"), null);
  assert.equal(parseDurationSpeech("九个小时，我叫O'Neil"), null);
});

test("contact capture accepts spoken digits and explicit use of caller ID without inventing a number", () => {
  assert.equal(
    parsePhoneSpeech("联系电话是零四一二三四五六七八"),
    "0412345678",
  );
  assert.equal(
    parsePhoneSpeech("我的电话号码是加六一四一二三四五六七八"),
    "+61412345678",
  );
  assert.equal(parsePhoneSpeech("+61 412 345 678"), "+61412345678");
  assert.equal(
    parsePhoneSpeech("手机号码是零四幺二三四五六七八"),
    "0412345678",
  );
  assert.equal(parsePhoneSpeech("0412-345-678"), "0412345678");
  assert.equal(usesCallerNumber("使用来电号码"), true);
  assert.equal(usesCallerNumber("就用这个号码"), true);
  assert.equal(usesCallerNumber("不要使用来电号码"), false);
  assert.equal(parsePhoneSpeech("使用来电号码"), null);
  assert.equal(parsePhoneSpeech("我的邮箱是a@example.com"), null);
  assert.equal(parsePhoneSpeech("123"), null);
  assert.equal(parsePhoneSpeech("04123456781234567890"), null);
});

test("names require a naming phrase or plausible name; questions and casual chat are never stored as a customer name", () => {
  assert.equal(parseNameSpeech("我叫张三。"), "张三");
  assert.equal(parseNameSpeech("我的名字是王小明"), "王小明");
  assert.equal(parseNameSpeech("李四"), "李四");
  assert.equal(parseNameSpeech("欧阳娜娜"), "欧阳娜娜");
  assert.equal(parseNameSpeech("我叫阿卜杜拉"), "阿卜杜拉");
  assert.equal(parseNameSpeech("John Smith"), "John Smith");
  assert.equal(parseNameSpeech("my name is Alice"), "Alice");
  for (const text of [
    "你好",
    "你叫什么名字",
    "谢谢",
    "今天的天气怎么样",
    "能帮我预订吗",
    "工作人员",
    "明天",
    "How are you",
    "What time",
    "I want to book",
    "Good afternoon",
  ]) {
    assert.equal(parseNameSpeech(text), null, text);
  }
});

test("final mutation confirmation is explicit and negation wins over affirmative substrings", () => {
  for (const text of [
    "确认预约",
    "确认取消",
    "确认预订",
    "我确认修改",
    "是的，确认",
    "Confirm",
  ]) {
    assert.equal(explicitConfirmation(text), "confirm", text);
  }
  for (const text of [
    "不确认",
    "不确定",
    "不要",
    "返回主菜单",
    "算了",
    "取消",
    "no",
  ]) {
    assert.equal(explicitConfirmation(text), "reject", text);
  }
  for (const text of [
    "好的",
    "对",
    "是的",
    "确认吗",
    "确认？",
    "确认然后讲个笑话",
    "我还没想好",
  ]) {
    assert.equal(explicitConfirmation(text), null, text);
  }
});

test("unrelated questions are marked outside the booking domain while booking details remain accepted", () => {
  for (const text of [
    "今天天气怎么样",
    "你叫什么名字",
    "讲个笑话",
    "能跟我聊天吗",
    "帮我写代码",
    "Who are you",
  ]) {
    assert.equal(isOffTopic(text), true, text);
  }
  for (const text of [
    "预订明天下午三点",
    "我的名字是李四",
    "帮我查一下空闲场地",
    "取消我的预约",
    "你好",
  ]) {
    assert.equal(isOffTopic(text), false, text);
  }
});
