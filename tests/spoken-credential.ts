/** Decode the once-spoken, grouped reference a caller would enter on the keypad. */
export function spokenCredential(text: string, label = "管理码"): string {
  const raw = text.match(new RegExp(`${label}：([^。]+)`))?.[1] || "";
  return raw
    .replace(/[零〇一二三四五六七八九]/g, (value) => {
      if (value === "〇") return "0";
      return String("零一二三四五六七八九".indexOf(value));
    })
    .replace(/[，,\s]/g, "");
}
