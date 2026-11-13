import { parseSpokenDigits } from "../lib/channels/voice-input";

/** Decode the once-spoken, grouped reference a caller would enter on the keypad. */
export function spokenCredential(text: string, label = "Access code"): string {
  const labels = /管理码|management code|access code/i.test(label)
    ? "Access code|Management code|管理码"
    : /预约编号|booking reference|booking id/i.test(label)
      ? "Booking reference|Booking ID|预约编号"
      : label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const raw =
    text.match(new RegExp(`(?:${labels})[:：]\\s*([^。.<]+)`, "i"))?.[1] || "";
  return parseSpokenDigits(raw) || "";
}
