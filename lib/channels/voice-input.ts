import { Temporal } from "@js-temporal/polyfill";
import { TIME_ZONE } from "@/lib/domain";

export type VoiceIntent = "query" | "book" | "change" | "cancel" | "view";
export type VoiceConfirmation = "confirm" | "reject" | null;

/** Normalize speech punctuation without destroying phone numbers or HH:00. */
export function stripSpeech(input: string): string {
  return input
    .normalize("NFKC")
    .trim()
    .replace(/[，,。.!！?？；;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  "○": 0,
  一: 1,
  壹: 1,
  幺: 1,
  二: 2,
  贰: 2,
  貳: 2,
  两: 2,
  兩: 2,
  三: 3,
  叁: 3,
  參: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  陸: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9,
};
const NUMBER =
  "[0-9零〇○一壹幺二贰貳两兩三叁參四肆五伍六陆陸七柒八捌九玖十拾百佰千仟]+";

const ENGLISH_NUMBERS: Record<string, number> = {
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
};
const ENGLISH_NUMBER =
  "(?:twenty(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|thirty(?:[ -]one)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)";

function englishNumber(raw: string): number | null {
  if (/^\d+(?:st|nd|rd|th)?$/i.test(raw))
    return Number(raw.replace(/(?:st|nd|rd|th)$/i, ""));
  const parts = raw.toLowerCase().split(/[ -]+/);
  return parts.every((part) => part in ENGLISH_NUMBERS)
    ? parts.reduce((sum, part) => sum + ENGLISH_NUMBERS[part], 0)
    : null;
}

/** Digit-by-digit values stay strings so a leading zero is never lost. */
export function parseSpokenDigits(input: string): string | null {
  const value = stripSpeech(input)
    .toLowerCase()
    .replace(
      /\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g,
      (word) => String(ENGLISH_NUMBERS[word]),
    );
  const digits = [...value]
    .map((character) =>
      character in DIGITS ? String(DIGITS[character]) : character,
    )
    .join("")
    .replace(/[\s，,。.！!.-]/g, "");
  return /^\d+$/.test(digits) ? digits : null;
}

function numberValue(raw: string): number | null {
  const value = raw.replace(/\s/g, "");
  if (/^\d+$/.test(value)) return Number(value);
  if ([...value].every((character) => character in DIGITS)) {
    return Number([...value].map((character) => DIGITS[character]).join(""));
  }
  const units: Record<string, number> = {
    十: 10,
    拾: 10,
    百: 100,
    佰: 100,
    千: 1000,
    仟: 1000,
  };
  let total = 0;
  let current = 0;
  let previousUnit = Infinity;
  let lastWasDigit = false;
  for (const character of value) {
    if (character in DIGITS) {
      // Consecutive digits belong to the digit-by-digit form handled above.
      if (lastWasDigit && current !== 0) return null;
      current = DIGITS[character];
      lastWasDigit = true;
    } else if (character in units) {
      const unit = units[character];
      if (unit >= previousUnit) return null;
      total += (current || 1) * unit;
      current = 0;
      previousUnit = unit;
      lastWasDigit = false;
    } else return null;
  }
  return value ? total + current : null;
}

/** Only recognized out-of-scope requests are marked as off topic. Unknown input
 * remains unrecognized so the caller can be prompted for the current field. */
export function isOffTopic(input: string): boolean {
  const value = stripSpeech(input).toLowerCase();
  return /天气|气温|新闻|股票|彩票|讲.{0,4}(笑话|故事)|聊天|聊聊|唱歌|唱一首|你是谁|你叫什么|你的名字|你几岁|你的年龄|你是机器人|你是人工智能|吃什么|写代码|写程序|写诗|翻译一下|数学题|政治|总统|算命|weather|tell me (?:a )?(?:joke|story)|sing (?:a |me )|who are you|what(?:'s| is) your name|stock price|write (?:some )?code/i.test(
    value,
  );
}

// ASR frequently transcribes the same booking request as 预定 or 预订.
// Normalize only intent/confirmation text, never customer names or contacts.
function normalizeBookingTerms(input: string): string {
  return input.replace(/预定|預定|預訂/g, "预订").replace(/預約/g, "预约");
}

export function parseIntent(input: string): VoiceIntent | null {
  if (
    /\b(?:do not|don't|dont|not|never)\s+(?:(?:want|wish|need)\s+to\s+)?(?:book|reserve|cancel|change|reschedule|modify)\b/i.test(
      input,
    )
  )
    return null;
  const value = normalizeBookingTerms(stripSpeech(input))
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!value || isOffTopic(input)) return null;
  if (
    /不(?:想|要|需要)?(?:取消|预订|预约|修改)|别(?:取消|预订|预约|修改)/.test(
      value,
    )
  )
    return null;
  const intents = new Set<VoiceIntent>();
  if (/取消|退订|退約|退约|撤销|撤銷|cancel/.test(value)) intents.add("cancel");
  if (/修改|改约|改約|改期|更改|调整|調整|change|reschedule|modify/.test(value))
    intents.add("change");
  if (
    /查看(?:已有|我的|现有|現有)?(?:预约|預約|预订|預訂)|查询(?:我的|已有|现有)(?:预约|预订)|(?:view|lookup|find|check)(?:my|anexisting|existing)?(?:booking|reservation)|^(?:已有|我的|现有)(?:预约|預約|预订|預訂)$|^mybooking$/.test(
      value,
    )
  )
    intents.add("view");
  if (
    /可用|空闲|空閒|空档|空檔|空场|空場|有没有(?:空|场地|球场)|还有(?:空|场地)|查询|查一下|查场|查場|查可用|空位|availability|available|query/.test(
      value,
    )
  )
    intents.add("query");
  if (
    /预订|預訂|预约|預約|订场|訂場|订球场|訂球場|订个场|訂個場|book(?:ing)?|reserve/.test(
      value,
    )
  )
    intents.add("book");
  // Contextual modifiers of an existing booking are one intent, not a new booking.
  if (intents.has("cancel") || intents.has("change") || intents.has("view")) {
    intents.delete("book");
    if (intents.has("view")) intents.delete("query");
  }
  // Asking whether a booking is possible is a query; no mutation is inferred.
  if (intents.has("query")) intents.delete("book");
  return intents.size === 1 ? [...intents][0] : null;
}

function anchorDate(nowDate?: string): Temporal.PlainDate | null {
  try {
    return nowDate
      ? Temporal.PlainDate.from(nowDate, { overflow: "reject" })
      : Temporal.Now.zonedDateTimeISO(TIME_ZONE).toPlainDate();
  } catch {
    return null;
  }
}

function calendarDate(year: number, month: number, day: number): string | null {
  try {
    if (year < 1900 || year > 9999) return null;
    return Temporal.PlainDate.from(
      { year, month, day },
      { overflow: "reject" },
    ).toString();
  } catch {
    return null;
  }
}

/** Dates without a year mean the next occurrence. Bare weekday names include
 * today; 下周 means the next Monday-based calendar week, not always +7 days. */
export function parseCalendarDate(
  input: string,
  nowDate?: string,
): string | null {
  const today = anchorDate(nowDate);
  const value = stripSpeech(input).toLowerCase().replace(/\s+/g, " ");
  if (!today || !value || isOffTopic(value)) return null;
  if (/或|还是|還是|要不|、|\b(?:or|either)\b/.test(value)) return null;
  const candidates: { start: number; end: number; date: string | null }[] = [];
  const collect = (
    pattern: RegExp,
    convert: (match: RegExpExecArray) => string | null,
  ) => {
    for (const match of value.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (
        candidates.some(
          (candidate) => start < candidate.end && end > candidate.start,
        )
      )
        continue;
      candidates.push({ start, end, date: convert(match) });
    }
  };
  collect(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g, (match) =>
    calendarDate(Number(match[1]), Number(match[2]), Number(match[3])),
  );
  collect(
    new RegExp(`(${NUMBER})年(${NUMBER})月(${NUMBER})(?:日|号|號)?`, "g"),
    (match) =>
      calendarDate(
        numberValue(match[1]) ?? 0,
        numberValue(match[2]) ?? 0,
        numberValue(match[3]) ?? 0,
      ),
  );
  collect(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g, (match) =>
    calendarDate(Number(match[1]), Number(match[2]), Number(match[3])),
  );
  collect(new RegExp(`(${NUMBER})月(${NUMBER})(?:日|号|號)?`, "g"), (match) => {
    const month = numberValue(match[1]);
    const day = numberValue(match[2]);
    if (month === null || day === null) return null;
    // Allow the next leap day when a year was not spoken.
    for (let year = today.year; year <= today.year + 8; year += 1) {
      const date = calendarDate(year, month, day);
      if (date && Temporal.PlainDate.compare(date, today) >= 0) return date;
    }
    return null;
  });
  collect(
    new RegExp(`(本|这个|這個|下个|下個|下)月(${NUMBER})(?:日|号|號)`, "g"),
    (match) => {
      const month = /下/.test(match[1]) ? today.add({ months: 1 }) : today;
      return calendarDate(month.year, month.month, numberValue(match[2]) ?? 0);
    },
  );
  collect(
    /大后天|大後天|后天|後天|今天|今日|明天|明日|\b(?:the )?day after tomorrow\b|\btoday\b|\btomorrow\b/gi,
    (match) => {
      const offset = /大/.test(match[0])
        ? 3
        : /后|後|day after tomorrow/i.test(match[0])
          ? 2
          : /明|tomorrow/i.test(match[0])
            ? 1
            : 0;
      return today.add({ days: offset }).toString();
    },
  );
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const monthPattern =
    "(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)";
  const ordinalNames: Record<string, number> = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
    sixth: 6,
    seventh: 7,
    eighth: 8,
    ninth: 9,
    tenth: 10,
    eleventh: 11,
    twelfth: 12,
    thirteenth: 13,
    fourteenth: 14,
    fifteenth: 15,
    sixteenth: 16,
    seventeenth: 17,
    eighteenth: 18,
    nineteenth: 19,
    twentieth: 20,
    "twenty first": 21,
    "twenty second": 22,
    "twenty third": 23,
    "twenty fourth": 24,
    "twenty fifth": 25,
    "twenty sixth": 26,
    "twenty seventh": 27,
    "twenty eighth": 28,
    "twenty ninth": 29,
    thirtieth: 30,
    "thirty first": 31,
  };
  const ordinalPattern = `(?:${Object.keys(ordinalNames)
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/ /g, "[ -]"))
    .join("|")})`;
  const dayPattern = `(?:\\d{1,2}(?:st|nd|rd|th)?|${ordinalPattern}|${ENGLISH_NUMBER})`;
  const namedDate = (monthName: string, dayName: string, yearName?: string) => {
    const month =
      months.findIndex((name) =>
        name.startsWith(monthName.replace(/\.$/, "")),
      ) + 1;
    const day =
      ordinalNames[dayName.replace(/-/g, " ")] ?? englishNumber(dayName);
    if (!month || day === null) return null;
    if (yearName) return calendarDate(Number(yearName), month, day);
    for (let year = today.year; year <= today.year + 8; year += 1) {
      const date = calendarDate(year, month, day);
      if (date && Temporal.PlainDate.compare(date, today) >= 0) return date;
    }
    return null;
  };
  collect(
    new RegExp(
      `\\b(${monthPattern})\\.?\\s+(?:the\\s+)?(${dayPattern})(?:,?\\s+(\\d{4}))?\\b`,
      "g",
    ),
    (match) => namedDate(match[1], match[2], match[3]),
  );
  collect(
    new RegExp(
      `\\b(?:the\\s+)?(${dayPattern})(?:\\s+of)?\\s+(${monthPattern})\\.?(?:,?\\s+(\\d{4}))?\\b`,
      "g",
    ),
    (match) => namedDate(match[2], match[1], match[3]),
  );
  const weekdays = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];
  collect(
    /\b(?:(next|this)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g,
    (match) => {
      const day = weekdays.indexOf(match[2]) + 1;
      const offset =
        match[1] === "next"
          ? 7 - today.dayOfWeek + day
          : (day - today.dayOfWeek + 7) % 7;
      return today.add({ days: offset }).toString();
    },
  );
  collect(
    /(下下|下|这|這|本)?(?:周|週|星期|礼拜|禮拜)([一二三四五六日天1-7])/g,
    (match) => {
      const day = ["日", "天"].includes(match[2]) ? 7 : numberValue(match[2]);
      if (day === null || day < 1 || day > 7) return null;
      if (match[1] === "下下" || match[1] === "下") {
        return today
          .add({ days: (match[1] === "下下" ? 14 : 7) - today.dayOfWeek + day })
          .toString();
      }
      return today.add({ days: (day - today.dayOfWeek + 7) % 7 }).toString();
    },
  );
  collect(new RegExp(`(${NUMBER})天后`, "g"), (match) => {
    const count = numberValue(match[1]);
    return count !== null && count <= 365
      ? today.add({ days: count }).toString()
      : null;
  });
  // A caller may clarify one date in several ways, such as 明天十一月十三号.
  // Every mention must resolve successfully to that same calendar day.
  const date = candidates[0]?.date;
  return date && candidates.every((candidate) => candidate.date === date)
    ? date
    : null;
}

export function parseCourtSpeech(input: string): 0 | 1 | 2 | null {
  const value = stripSpeech(input).toLowerCase().replace(/\s/g, "");
  if (!value || isOffTopic(value)) return null;
  if (
    /^(?:都可以|都行|均可|任意(?:球)?场(?:地)?|任何(?:球)?场(?:地)?|两个(?:球)?场(?:地)?|两片(?:球)?场(?:地)?|全部(?:球)?场(?:地)?|所有(?:球)?场(?:地)?|都查|both|either|all|0)$/.test(
      value,
    )
  )
    return 0;
  // A full booking sentence can contain date/hour numbers. Only an explicit
  // court noun makes its number eligible for prefilling a court selection.
  const namedCourts = [
    ...value.matchAll(
      /(?:第)?([一壹二贰两兩12])(?:号|號|个|個)?(?:球场|球場|场地|場地|场|場)|(?:球场|球場|场地|場地)([一壹二贰两兩12])/g,
    ),
  ];
  if (namedCourts.length) {
    const namedChoices = new Set(
      namedCourts.map((match) => numberValue(match[1] || match[2])),
    );
    if (namedChoices.size !== 1) return null;
    const choice = [...namedChoices][0];
    return choice === 1 || choice === 2 ? choice : null;
  }
  const mentions = [
    ...value.matchAll(
      /(?:第)?([一壹二贰两兩12])(?:号|號|个|個)?(?:球场|球場|场地|場地|场|場)?/g,
    ),
  ];
  const choices = new Set(mentions.map((match) => numberValue(match[1])));
  if (choices.size !== 1) return null;
  const choice = [...choices][0];
  const allowed =
    /^(?:(?:我)?(?:想要|想选|选择|選擇|选|選|要|就要|就选|用|预订|预约|查询|查)?)(?:第)?[一壹二贰两兩12](?:号|號|个|個)?(?:球场|球場|场地|場地|场|場)?(?:吧|就好|谢谢|謝謝)?$/;
  return allowed.test(value) && (choice === 1 || choice === 2) ? choice : null;
}

function qualifiedHour(hour: number, qualifier: string): number | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (/下午|傍晚|晚上|晚间|晚間|pm/i.test(qualifier)) {
    if (hour === 0) return null;
    if (hour < 12) return hour + 12;
    if (hour === 12 && /晚上|晚间|晚間/.test(qualifier)) return null;
    return hour;
  }
  if (/凌晨|午夜|am/i.test(qualifier))
    return hour === 12 ? 0 : hour < 12 ? hour : null;
  if (/上午|早上|早晨|清晨/.test(qualifier)) return hour < 12 ? hour : null;
  if (/中午/.test(qualifier))
    return hour >= 11 && hour <= 14
      ? hour
      : hour === 1 || hour === 2
        ? hour + 12
        : null;
  return hour;
}

function englishHour(input: string): string | null {
  const value = stripSpeech(input)
    .toLowerCase()
    .replace(/\b([ap])\.?\s*m\.?/g, "$1m");
  if (
    /\b(?:half|quarter|minutes?|hours?)\b|\d\.\d|\b(?:or|either)\b/.test(value)
  )
    return null;
  const matches: number[] = [];
  const occupied: { start: number; end: number }[] = [];
  const collect = (
    pattern: RegExp,
    convert: (match: RegExpExecArray) => number | null,
  ) => {
    for (const match of value.matchAll(pattern)) {
      if (
        occupied.some(
          (part) =>
            match.index < part.end &&
            match.index + match[0].length > part.start,
        )
      )
        continue;
      occupied.push({ start: match.index, end: match.index + match[0].length });
      matches.push(convert(match) ?? -1);
    }
  };
  const qualify = (hour: number | null, period = "") => {
    if (hour === null || hour < 0 || hour > 23) return null;
    if (/pm|afternoon|evening/.test(period))
      return hour === 0 ? null : hour < 12 ? hour + 12 : hour;
    if (/am|morning/.test(period))
      return hour === 12 ? 0 : hour < 12 ? hour : null;
    if (/night/.test(period))
      return hour === 12
        ? 0
        : hour >= 6 && hour < 12
          ? hour + 12
          : hour < 6 || hour >= 18
            ? hour
            : null;
    return hour;
  };
  const number = `(?:\\d{1,2}|${ENGLISH_NUMBER})`;
  collect(/\b(?:(?:12|twelve)\s+)?(noon|midnight)\b/g, (match) =>
    match[1] === "noon" ? 12 : 0,
  );
  collect(
    new RegExp(
      `\\b(${number})(?::(\\d{2}))?\\s*(?:o['’]?clock\\s*)?(am|pm|in\\s+the\\s+(?:morning|afternoon|evening)|at\\s+night)\\b`,
      "g",
    ),
    (match) =>
      // In "three fifteen pm", the qualified match starts at "fifteen".
      // Keep the preceding clock number from becoming an ignored minute.
      new RegExp(`\\b${number}\\s+$`).test(value.slice(0, match.index)) ||
      (match[2] && match[2] !== "00")
        ? null
        : qualify(englishNumber(match[1]), match[3]),
  );
  collect(/\b(\d{1,2}):(\d{2})\b/g, (match) =>
    match[2] === "00" ? qualify(Number(match[1])) : null,
  );
  collect(
    new RegExp(
      `\\b(?:at|from|start(?:ing)?(?:\\s+at)?)\\s+(${number})(?:\\s+o['’]?clock)?\\b|\\b(${number})\\s+o['’]?clock\\b`,
      "g",
    ),
    (match) => qualify(englishNumber(match[1] || match[2])),
  );
  if (!matches.length && new RegExp(`^${number}$`).test(value))
    matches.push(englishNumber(value) ?? -1);
  return matches.length === 1 && matches[0] >= 0
    ? String(matches[0]).padStart(2, "0")
    : null;
}

/** Returns a 24-hour HH string. Non-zero minutes are rejected, never rounded. */
export function parseHourSpeech(input: string): string | null {
  // An English name in a booking sentence does not change the clock language.
  if (
    /[a-z]/i.test(input) &&
    !/点|點|时|時|凌晨|午夜|清晨|早晨|早上|上午|中午|下午|傍晚|晚上|晚间|晚間/.test(
      input,
    )
  )
    return isOffTopic(input) ? null : englishHour(input);
  const value = stripSpeech(input).toLowerCase().replace(/\s/g, "");
  if (
    !value ||
    isOffTopic(value) ||
    /半|刻|小时|小時|钟头|鐘頭|\d\.\d/.test(value)
  )
    return null;
  const qualifiers = [
    ...value.matchAll(
      /凌晨|午夜|清晨|早晨|早上|上午|中午|下午|傍晚|晚上|晚间|晚間|am|pm/gi,
    ),
  ];
  if (qualifiers.length > 1) return null;
  const qualifier = qualifiers[0]?.[0] || "";
  const minuteClauses = [
    ...value.matchAll(new RegExp(`(${NUMBER})(?:分钟|分鐘|分)`, "g")),
  ];
  if (minuteClauses.some((match) => numberValue(match[1]) !== 0)) return null;
  const colons = [...value.matchAll(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g)];
  const spoken = [
    ...value.matchAll(
      new RegExp(`(${NUMBER})(?:点|點|时|時)(?:(${NUMBER})(?:分)?)?`, "g"),
    ),
  ];
  if (colons.length + spoken.length > 1) return null;
  let hour: number | null = null;
  if (colons.length === 1) {
    if (colons[0][2] !== "00") return null;
    hour = Number(colons[0][1]);
  } else if (spoken.length === 1) {
    const minute = spoken[0][2] ? numberValue(spoken[0][2]) : 0;
    if (minute !== 0) return null;
    hour = numberValue(spoken[0][1]);
  } else {
    const bare = value
      .replace(
        /^(?:开始(?:时间)?(?:是|为)?|就|从|选|選|定在|在)?(?:凌晨|午夜|清晨|早晨|早上|上午|中午|下午|傍晚|晚上|晚间|晚間)?/,
        "",
      )
      .replace(/(?:am|pm|整)$/i, "");
    hour = new RegExp(`^${NUMBER}$`).test(bare) ? numberValue(bare) : null;
  }
  if (hour === null) return null;
  const result = qualifiedHour(hour, qualifier);
  return result === null ? null : String(result).padStart(2, "0");
}

export function parseDurationSpeech(input: string): number | null {
  if (
    /[a-z]/i.test(input) &&
    !/小时|小時|钟头|鐘頭|分钟|分鐘|默认|默認/.test(input)
  ) {
    const value = stripSpeech(input).toLowerCase();
    if (
      isOffTopic(value) ||
      /\b(?:half|quarter|minutes?|or|either)\b|\d\.\d/.test(value)
    )
      return null;
    const matches = [
      ...value.matchAll(
        new RegExp(`\\b(\\d+|${ENGLISH_NUMBER})\\s*(?:hours?|h)\\b`, "g"),
      ),
    ];
    if (matches.length > 1) return null;
    const explicit = matches.length
      ? englishNumber(matches[0][1])
      : englishNumber(value);
    if (/\bdefault\b/.test(value))
      return explicit === null || explicit === 2 ? 2 : null;
    return explicit !== null && explicit >= 1 && explicit <= 8
      ? explicit
      : null;
  }
  const value = stripSpeech(input).toLowerCase().replace(/\s/g, "");
  if (!value || isOffTopic(value) || /半|刻|分钟|分鐘|\d\.\d/.test(value))
    return null;
  const matches = [
    ...value.matchAll(
      new RegExp(
        `(${NUMBER})(?:个|個)?(?:小时|小時|钟头|鐘頭|hours?|h)(?![a-z])`,
        "gi",
      ),
    ),
  ];
  if (matches.length > 1) return null;
  const explicit =
    matches.length === 1
      ? numberValue(matches[0][1])
      : new RegExp(`^${NUMBER}$`).test(value)
        ? numberValue(value)
        : null;
  if (/默认|默認|default/.test(value))
    return explicit === null || explicit === 2 ? 2 : null;
  return explicit !== null && explicit >= 1 && explicit <= 8 ? explicit : null;
}

export function usesCallerNumber(input: string): boolean {
  const english = stripSpeech(input).toLowerCase();
  if (/\b(?:not|don't|dont|never|cancel|no)\b/.test(english)) return false;
  if (
    /^(?:please\s+)?(?:just\s+)?(?:use|keep)(?:\s+my)?\s+(?:calling (?:phone )?number|caller (?:id|number)|current (?:phone )?number|this (?:phone )?number|same (?:phone )?number)(?:\s+please)?$/.test(
      english,
    )
  )
    return true;
  const value = stripSpeech(input).replace(/\s/g, "");
  if (/不|别|別|不要|不用|取消/.test(value)) return false;
  return /^(?:(?:请|請)?(?:就)?(?:使用|用|采用|採用))?(?:我的)?(?:来电(?:显示)?号码|來電(?:顯示)?號碼|来电号码|来电显示|本机号码|本機號碼|当前号码|當前號碼|这个(?:电话)?号码|這個(?:電話)?號碼|该号码|同来电号码)(?:就好|即可)?$/.test(
    value,
  );
}

export function parsePhoneSpeech(input: string): string | null {
  if (usesCallerNumber(input) || isOffTopic(input)) return null;
  let value = stripSpeech(input)
    .replace(
      /^(?:我的)?(?:联系(?:电话|方式)|聯繫(?:電話|方式)|手机(?:号码)?|手機(?:號碼)?|电话(?:号码)?|電話(?:號碼)?|号码|號碼)(?:是|为|為)?[：:]?\s*/,
      "",
    )
    .replace(/^my (?:phone )?number is\s*/i, "")
    .replace(
      /^(?:(?:my|the)\s+)?(?:(?:contact|mobile|telephone|phone)\s+)?number(?:\s+is)?\s*[:：]?\s*/i,
      "",
    )
    .replace(/^plus\s+/i, "+")
    .replace(/^加(?:号|號)?/, "+");
  value = value.replace(
    /\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/gi,
    (word) => String(ENGLISH_NUMBERS[word.toLowerCase()]),
  );
  value = value.replace(/[\s()（）.，,、-]/g, "");
  value = [...value]
    .map((character) =>
      character in DIGITS ? String(DIGITS[character]) : character,
    )
    .join("");
  if (/^\+[1-9]\d{7,14}$/.test(value) || /^\d{8,15}$/.test(value)) return value;
  return null;
}

const SURNAMES = new Set(
  "赵錢钱孙孫李周吴吳郑鄭王冯馮陈陳褚卫衛蒋蔣沈韩韓杨楊朱秦尤许許何吕呂施张張孔曹严嚴华華金魏陶姜戚谢謝邹鄒喻柏水窦竇章云雲苏蘇潘葛奚范彭郎鲁魯韦韋昌马馬苗凤鳳花方俞任袁柳鲍鮑史唐费費廉岑薛雷贺賀倪汤湯滕殷罗羅毕畢郝安常傅卞齐齊元顾顧孟平黄黃和穆萧蕭尹姚邵湛汪祁毛禹狄米贝貝明臧计計伏成戴谈談宋茅庞龐熊纪紀舒屈项項祝董梁杜阮蓝藍闵閔席季麻强強贾賈路娄婁危江童颜顏郭梅盛林刁钟鐘徐邱骆駱高夏蔡田樊胡凌霍虞万萬支柯管卢盧莫经經房裘缪繆解应應宗丁宣邓鄧郁单單杭洪包诸諸左石崔吉龚龔程邢裴陆陸荣榮翁荀甄曲封芮储儲靳汲邴糜松井段富巫乌烏焦巴弓牧隗山谷车車侯宓蓬全班仰秋仲伊宫宮宁寧仇栾欒甘钭鈄厉厲戎祖武符刘劉景詹束龙龍叶葉幸司韶郜黎蓟薊薄印宿白怀懷蒲台臺从從鄂索咸籍赖賴卓蔺藺屠蒙池乔喬阴陰胥能苍蒼双雙闻聞莘党黨翟谭譚贡貢劳勞逄姬申扶堵冉宰郦酈雍郤璩桑桂濮牛寿壽通边邊扈燕冀郏郟浦尚农農温溫别別庄莊晏柴瞿阎閻充慕连連茹习習艾鱼魚容向古易慎戈廖庾终終暨居衡步耿满滿弘匡文寇广廣禄祿阙闕东東欧歐殳沃利蔚越夔隆师師巩鞏厍厙聂聶晁勾敖融冷訾辛阚闞那简簡饶饒空曾毋沙乜养養鞠须須丰豐巢关關蒯相查后後荆荊红紅游竺权權逯盖蓋益桓公万俟司马上官欧阳夏侯诸葛闻人东方赫连皇甫尉迟公羊澹台公冶宗政濮阳淳于单于太叔申屠公孙仲孙轩辕令狐钟离宇文长孙慕容鲜于闾丘司徒司空亓官司寇南宫西门百里第五".split(
    "",
  ),
);

/** A name is accepted only as a naming phrase or a plausible short name.
 * Whole sentences and casual questions are never recorded as customer names. */
export function parseNameSpeech(input: string): string | null {
  if (/[?？]/.test(input) || isOffTopic(input)) return null;
  const value = stripSpeech(input);
  const introduced =
    /^(?:我的(?:姓名|名字)(?:是|叫)|姓名(?:是|叫|为)|名字(?:是|叫)|我叫|叫我|我是|my name is\s+|i(?:'m| am)\s+)/i;
  const explicit = introduced.test(value);
  const name = value.replace(introduced, "").trim();
  if (
    /\b(?:want to|like to|need to|book a|book the|change my|cancel my|phone number|contact number|don't know|do not know)\b/i.test(
      name,
    )
  )
    return null;
  if (
    /吗|嗎|么|麼|呢|什么|什麼|怎么|怎麼|怎么样|怎麼樣|谢谢|謝謝|你好|再见|再見|帮我|幫我|预约|預約|预订|預訂|球场|球場|查询|查詢|修改|取消|今天|明天|后天|後天|下午|上午|中午|晚上|凌晨|小时|小時|电话|電話|号码|號碼|邮箱|郵箱|工作人员|工作人員|不告诉|不知道/.test(
      name,
    )
  )
    return null;
  if (/^[\p{Script=Han}·]{2,16}$/u.test(name)) {
    return explicit || (name.length <= 6 && SURNAMES.has(name[0]))
      ? name
      : null;
  }
  if (
    /^[A-Za-z][A-Za-z'-]{0,24}(?: [A-Za-z][A-Za-z'-]{0,24}){0,3}$/.test(name) &&
    name.length >= 2 &&
    name.length <= 60
  ) {
    if (
      /^(?:hello|hi|yes|no|ok|okay|thanks|thank you|good morning|good afternoon|good evening|book|booking|cancel|court|today|tomorrow|test)$/i.test(
        name,
      )
    )
      return null;
    if (
      !explicit &&
      /^(?:how|what|where|when|why|can|could|would|please|tell|do|is|are|i|you|we|it|let|the|not|my)\b/i.test(
        name,
      )
    )
      return null;
    return name;
  }
  return null;
}

/** Final mutations require an explicit confirmation phrase, not casual assent. */
export function explicitConfirmation(input: string): VoiceConfirmation {
  if (/[?？]|吗|嗎|么|麼|是否/.test(input) || isOffTopic(input)) return null;
  const english = stripSpeech(input).toLowerCase();
  if (
    /\b(?:do not|don't|dont|not|never)\s+(?:confirm|cancel|book|proceed)\b/.test(
      english,
    ) ||
    /^(?:no(?: thank you)?|reject|stop|cancel|go back|start again)$/.test(
      english,
    )
  )
    return "reject";
  if (
    /^(?:(?:yes[, ]+)?(?:i\s+)?confirm)(?:\s+(?:the\s+)?(?:booking|reservation|cancellation|cancel|change|changes|details))?$/.test(
      english,
    )
  )
    return "confirm";
  const value = normalizeBookingTerms(stripSpeech(input))
    .toLowerCase()
    .replace(/[\s，,]/g, "");
  if (
    /^(?:不|不要|不用|不对|不對|不确认|不確認|不确定|不確定|取消|算了|返回|返回主菜单|返回主菜單|重新选择|重新選擇|拒绝|拒絕|否|no|reject|stop)$/.test(
      value,
    )
  )
    return "reject";
  if (
    /^(?:(?:是的|没错|沒錯|对|對|我|好的|yes)[，,]?)?(?:确认|確認|确定|確定)(?:预订|預訂|预约|預約|修改|取消|以上信息|以上資訊)?$/.test(
      value,
    ) ||
    /^(?:confirm|iconfirm|yesconfirm)$/.test(value)
  )
    return "confirm";
  return null;
}
