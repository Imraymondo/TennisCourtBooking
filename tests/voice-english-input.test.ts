import { test } from "node:test";
import assert from "node:assert/strict";
import {
  explicitConfirmation,
  isOffTopic,
  parseCalendarDate,
  parseDurationSpeech,
  parseHourSpeech,
  parseIntent,
  parseNameSpeech,
  parsePhoneSpeech,
  parseSpokenDigits,
  usesCallerNumber,
} from "../lib/channels/voice-input";

const TODAY = "2026-11-13";

test("English requests distinguish availability and existing reservations from a new booking", () => {
  const cases = [
    ["I would like to book a court tomorrow", "book"],
    ["Please reserve a court", "book"],
    ["What courts are available tomorrow?", "query"],
    ["Can I book an available court tomorrow?", "query"],
    ["Check availability", "query"],
    ["Change my booking", "change"],
    ["Reschedule my reservation", "change"],
    ["Cancel my booking", "cancel"],
    ["View my booking", "view"],
    ["Find my reservation", "view"],
    ["Don't book a court", null],
    ["Do not cancel my reservation", null],
    ["I do not want to change my booking", null],
    ["Change or cancel my booking", null],
    ["Tell me a joke and book a court", null],
    ["Hello there", null],
  ] as const;
  for (const [text, expected] of cases) {
    assert.equal(parseIntent(text), expected, text);
  }
});

test("English relative dates and weekdays use the supplied calendar date", () => {
  const cases = [
    ["today", TODAY],
    ["Book a court tomorrow", "2026-11-14"],
    ["the day after tomorrow", "2026-11-15"],
    ["Friday", TODAY],
    ["Saturday", "2026-11-14"],
    ["next Monday", "2026-11-16"],
    ["next Friday", "2026-11-20"],
    ["next Sunday", "2026-11-22"],
  ] as const;
  for (const [text, expected] of cases) {
    assert.equal(parseCalendarDate(text, TODAY), expected, text);
  }
  assert.equal(parseCalendarDate("tomorrow", "2026-12-31"), "2027-01-01");
});

test("English month dates accept both spoken orders, ordinals, abbreviations and explicit years", () => {
  for (const text of [
    "November 14",
    "November 14th",
    "November the fourteenth",
    "14 November",
    "the fourteenth of November",
    "Nov. 14, 2026",
    "14th November 2026",
  ]) {
    assert.equal(parseCalendarDate(text, TODAY), "2026-11-14", text);
  }
  assert.equal(parseCalendarDate("November twenty-first", TODAY), "2026-11-21");
  assert.equal(parseCalendarDate("January first", "2026-12-31"), "2027-01-01");
  assert.equal(parseCalendarDate("January 2, 2030", TODAY), "2030-01-02");
  assert.equal(parseCalendarDate("February 29", TODAY), "2028-02-29");
});

test("English date clarification must consistently describe one valid day", () => {
  for (const text of [
    "tomorrow, November 14th",
    "November fourteenth, that is tomorrow",
    "tomorrow, 14 November 2026, Saturday",
    "next Monday, November 16th",
  ]) {
    const expected = text.startsWith("next") ? "2026-11-16" : "2026-11-14";
    assert.equal(parseCalendarDate(text, TODAY), expected, text);
  }
  assert.equal(
    parseCalendarDate("tomorrow, January 1st 2027, Friday", "2026-12-31"),
    "2027-01-01",
  );
  for (const text of [
    "tomorrow or November 14",
    "either tomorrow or Saturday",
    "tomorrow or the day after tomorrow",
    "tomorrow November 15",
    "tomorrow November 14 Sunday",
    "November 14 and November 15",
    "tomorrow November 14 2027",
    "February 30 2027",
    "tomorrow November 31",
    "November 31 tomorrow",
    "February 29 2027 tomorrow",
    "not sure which day",
  ]) {
    assert.equal(parseCalendarDate(text, TODAY), null, text);
  }
});

test("English whole-hour times preserve AM/PM, named times and spoken clock qualifiers", () => {
  const cases = [
    ["three pm", "15"],
    ["3 p.m.", "15"],
    ["three in the afternoon", "15"],
    ["nine in the morning", "09"],
    ["three o'clock", "03"],
    ["three o’clock in the afternoon", "15"],
    ["at three", "03"],
    ["noon", "12"],
    ["twelve noon", "12"],
    ["midnight", "00"],
    ["12 am", "00"],
    ["12 pm", "12"],
    ["3:00 PM", "15"],
    ["23:00", "23"],
  ] as const;
  for (const [text, expected] of cases) {
    assert.equal(parseHourSpeech(text), expected, text);
  }
});

test("English fractional, conflicting and invalid start times require clarification", () => {
  for (const text of [
    "half past three",
    "quarter past three pm",
    "quarter to four",
    "three fifteen pm",
    "3:30 pm",
    "3.5 pm",
    "three pm or four pm",
    "three pm and four pm",
    "from three pm to five pm",
    "noon and midnight",
    "24:00",
    "25 pm",
    "zero pm",
  ]) {
    assert.equal(parseHourSpeech(text), null, text);
  }
});

test("English duration accepts one to eight whole hours and the two-hour default", () => {
  const words = [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
  ];
  for (const [index, word] of words.entries()) {
    const hours = index + 1;
    assert.equal(parseDurationSpeech(word), hours, word);
    assert.equal(parseDurationSpeech(`${word} hours`), hours, word);
    assert.equal(parseDurationSpeech(`${hours} hours`), hours, String(hours));
  }
  assert.equal(parseDurationSpeech("one hour"), 1);
  assert.equal(parseDurationSpeech("I want to play for two hours"), 2);
  assert.equal(parseDurationSpeech("default"), 2);
  assert.equal(parseDurationSpeech("use the default duration"), 2);
  assert.equal(parseDurationSpeech("default two hours"), 2);
  for (const text of [
    "half an hour",
    "one and a half hours",
    "2.5 hours",
    "ninety minutes",
    "zero hours",
    "nine hours",
    "9 hours",
    "two or three hours",
    "two hours and three hours",
    "default three hours",
  ]) {
    assert.equal(parseDurationSpeech(text), null, text);
  }
});

test("English customer names preserve capitalization, apostrophes and hyphens", () => {
  const cases = [
    ["John Smith", "John Smith"],
    ["My name is Alice", "Alice"],
    ["I'm Mary-Jane O'Neill", "Mary-Jane O'Neill"],
    ["I am Alex Chen", "Alex Chen"],
    ["my name is McKenzie Lee", "McKenzie Lee"],
  ] as const;
  for (const [text, expected] of cases) {
    assert.equal(parseNameSpeech(text), expected, text);
  }
  for (const text of [
    "How are you",
    "What is your name?",
    "Good afternoon",
    "I want to book",
    "My name is Alice?",
    "My phone number is 0412345678",
  ]) {
    assert.equal(parseNameSpeech(text), null, text);
  }
});

test("English phone capture preserves leading zeroes and requires explicit caller-number consent", () => {
  for (const text of [
    "zero four one two three four five six seven eight",
    "My phone number is oh four one two three four five six seven eight",
    "my mobile number is 0412 345 678",
    "contact number is 0412-345-678",
  ]) {
    assert.equal(parsePhoneSpeech(text), "0412345678", text);
  }
  assert.equal(
    parsePhoneSpeech(
      "my number is plus six one four one two three four five six seven eight",
    ),
    "+61412345678",
  );
  for (const text of [
    "use my caller number",
    "please use this phone number",
    "keep my current number",
    "use caller ID please",
  ]) {
    assert.equal(usesCallerNumber(text), true, text);
    assert.equal(parsePhoneSpeech(text), null, text);
  }
  for (const text of [
    "don't use my caller number",
    "do not use this number",
    "no",
  ]) {
    assert.equal(usesCallerNumber(text), false, text);
  }
  for (const text of [
    "one two three",
    "my email is alice@example.com",
    "04123456781234567890",
  ]) {
    assert.equal(parsePhoneSpeech(text), null, text);
  }
  assert.equal(parseSpokenDigits("zero zero one two"), "0012");
  assert.equal(parseSpokenDigits("oh four one two"), "0412");
  assert.equal(parseSpokenDigits("0 0 1 2"), "0012");
  assert.equal(parseSpokenDigits("zero four hello"), null);
});

test("English mutation confirmation requires explicit action and gives negation priority", () => {
  for (const text of [
    "confirm booking",
    "Confirm the reservation",
    "confirm cancellation",
    "I confirm the changes",
    "yes, confirm booking",
  ]) {
    assert.equal(explicitConfirmation(text), "confirm", text);
  }
  for (const text of [
    "don't confirm booking",
    "do not confirm cancellation",
    "never confirm booking",
    "confirm booking but do not proceed",
    "no thank you",
    "go back",
  ]) {
    assert.equal(explicitConfirmation(text), "reject", text);
  }
  for (const text of [
    "yes",
    "okay",
    "that's right",
    "confirm booking?",
    "Can I confirm cancellation",
    "I might confirm booking",
    "confirm booking and tell me a joke",
  ]) {
    assert.equal(explicitConfirmation(text), null, text);
  }
});

test("English off-topic requests stay outside the booking workflow", () => {
  for (const text of [
    "What is the weather tomorrow?",
    "Tell me a joke",
    "Who are you",
    "Write some code",
  ]) {
    assert.equal(isOffTopic(text), true, text);
  }
  for (const text of [
    "Book a court tomorrow",
    "Cancel my reservation",
    "My name is Alice",
    "Hello",
  ]) {
    assert.equal(isOffTopic(text), false, text);
  }
});
