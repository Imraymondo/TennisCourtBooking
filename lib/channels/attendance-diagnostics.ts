export const ATTENDANCE_VERSION = "attendance-input-3";

export function logAttendanceCallback(
  form: URLSearchParams,
  info: {
    turn: string | null;
    event: string | null;
    responseXml: string;
  },
) {
  if (process.env.VOICE_DEBUG !== "1") return;
  const digits = form.get("Digits")?.trim() || "";
  const speech = form.get("SpeechResult")?.trim() || "";
  const confidenceText = form.get("Confidence")?.trim();
  const confidence = confidenceText ? Number(confidenceText) : NaN;
  console.info(
    "Attendance callback:",
    JSON.stringify({
      version: ATTENDANCE_VERSION,
      input:
        digits && speech
          ? "both"
          : digits
            ? "digits"
            : speech
              ? "speech"
              : "empty",
      digits:
        digits === "1" || digits === "2" ? digits : digits ? "other" : "absent",
      speechLength: speech.length,
      confidence:
        Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
          ? confidence
          : null,
      turn: info.turn === null ? "missing" : "present",
      event: info.event === "status" ? "status" : "voice",
      outcome: /<Gather\b/.test(info.responseXml) ? "gather" : "end",
    }),
  );
}
