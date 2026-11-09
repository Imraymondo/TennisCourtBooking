// Gather's ASR locale and Polly's TTS locale are different. The current official
// Twilio SDK lists cmn-Hans-CN for Gather; zh-CN belongs to Say's language list.
export const VOICE_CAPTURE = {
  version: "mandarin-gather-2",
  language: "cmn-Hans-CN",
  speechPauseSeconds: 2,
  startTimeoutSeconds: 7,
} as const;
