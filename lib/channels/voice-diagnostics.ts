import { parseCalendarDate, parseIntent } from "./voice-input";
import { VOICE_CAPTURE } from "./voice-capture";

type Progress = { step: string; turn: string } | null;
const STEPS = new Set([
  "menu",
  "date",
  "court",
  "hour",
  "duration",
  "name",
  "contact",
  "id",
  "code",
  "confirm",
]);
const step = (progress: Progress) =>
  progress && STEPS.has(progress.step) ? progress.step : null;

export function logVoiceCallback(
  form: URLSearchParams,
  info: {
    turn: string | null;
    before: Progress;
    after: Progress;
    handling: "recovery" | "routed";
    cached: boolean;
    responseXml: string;
  },
) {
  if (process.env.VOICE_DEBUG !== "1") return;
  const speech = (form.get("SpeechResult") || "").trim();
  const partial = (form.get("UnstableSpeechResult") || "").trim();
  const confidenceText = form.get("Confidence");
  const confidence = confidenceText?.trim() ? Number(confidenceText) : NaN;
  const error =
    form.get("ErrorCode") || form.get("SpeechRecognitionErrorCode") || "";
  const responseLanguage = info.responseXml.match(
    /<Gather\b[^>]*\blanguage="([^"]+)"/,
  )?.[1];
  const turnState = !info.turn
    ? info.before
      ? "missing"
      : "initial"
    : !/^[a-f0-9-]{36}$/.test(info.turn)
      ? "invalid"
      : !info.before
        ? "no-session"
        : info.before.turn === info.turn
          ? "current"
          : "stale";
  console.info(
    "Voice callback:",
    JSON.stringify({
      version: VOICE_CAPTURE.version,
      turn: info.turn ? "present" : "missing",
      turnState,
      input: speech
        ? "speech"
        : form.get("Digits")?.trim()
          ? "digits"
          : "empty",
      handling: info.handling,
      stepBefore: step(info.before),
      stepAfter: step(info.after),
      cached: info.cached,
      speechField: form.has("SpeechResult")
        ? speech
          ? "present"
          : "empty"
        : "absent",
      speechLength: speech.length,
      partialFieldPresent: form.has("UnstableSpeechResult"),
      partialLength: partial.length,
      confidence:
        Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
          ? Math.round(confidence * 100) / 100
          : null,
      providerErrorCode: /^\d{3,7}$/.test(error) ? error : null,
      recognizedIntent:
        step(info.before) === "menu" && speech ? parseIntent(speech) : null,
      dateRecognized:
        step(info.before) === "date" && speech
          ? Boolean(parseCalendarDate(speech))
          : null,
      configuredLanguage: VOICE_CAPTURE.language,
      responseLanguage:
        responseLanguage === "cmn-Hans-CN" || responseLanguage === "zh-CN"
          ? responseLanguage
          : "other",
    }),
  );
}
