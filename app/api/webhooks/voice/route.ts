import {
  handleVoice,
  recoverVoiceTurn,
  voiceAIContext,
  voiceProgress,
} from "@/lib/channels/voice";
import {
  bookingAIEnabled,
  interpretBookingText,
} from "@/lib/channels/booking-ai";
import { logVoiceCallback } from "@/lib/channels/voice-diagnostics";
import { finalizePhoneBookingSms } from "@/lib/channels/phone-sms";
import {
  createRealtimeVoice,
  realtimeVoiceEnabled,
} from "@/lib/channels/realtime";
import {
  verifiedTwilioForm,
  webhookFailure,
  xmlResponse,
} from "@/lib/channels/security";
import {
  AppError,
  getChannelEvent,
  rateLimit,
  runChannelEvent,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Twilio can retry while understanding is still in flight. Share the whole
// result for that turn, then retain its exact XML in channel_events.
const pendingTurns = new Map<string, Promise<string>>();

export async function POST(request: Request) {
  try {
    const form = await verifiedTwilioForm(request);
    const callSid = form.get("CallSid");
    if (!callSid || !/^[A-Za-z0-9]{10,64}$/.test(callSid))
      throw new AppError("Missing call ID.", 400);
    if (process.env.VOICE_MODE === "realtime") {
      if (!realtimeVoiceEnabled())
        throw new AppError(
          "The Realtime phone channel is not configured.",
          503,
        );
      return xmlResponse(
        runChannelEvent(`voice:${callSid}:initial`, () => {
          rateLimit(`voice:${form.get("From")}`, 200, 3_600_000);
          return createRealtimeVoice(callSid, form.get("From")!);
        }),
      );
    }
    const turn = new URL(request.url).searchParams.get("turn");
    const digits = form.get("Digits") || "";
    const speech = form.get("SpeechResult") || "";
    const recovery =
      (!turn && Boolean(digits.trim() || speech.trim())) ||
      Boolean(turn && !/^[a-f0-9-]{36}$/.test(turn));
    const diagnostic = process.env.VOICE_DEBUG === "1";
    const before = diagnostic ? voiceProgress(callSid) : null;
    if (recovery) {
      rateLimit(`voice:${form.get("From")}`, 200, 3_600_000);
      const xml = recoverVoiceTurn(callSid);
      if (diagnostic)
        logVoiceCallback(form, {
          turn,
          before,
          after: voiceProgress(callSid),
          handling: "recovery",
          cached: false,
          responseXml: xml,
        });
      return xmlResponse(xml);
    }
    const key = `voice:${callSid}:${turn ?? "initial"}`;
    const saved = getChannelEvent(key);
    const cached = saved !== null || pendingTurns.has(key);
    let xml: string;
    if (saved !== null) xml = JSON.parse(saved) as string;
    else {
      let pending = pendingTurns.get(key);
      if (!pending) {
        pending = (async () => {
          rateLimit(`voice:${form.get("From")}`, 200, 3_600_000);
          const context = bookingAIEnabled()
            ? voiceAIContext(callSid, turn, digits, speech)
            : null;
          // Never hold SQLite's synchronous transaction across an API request.
          const interpretation = context
            ? await interpretBookingText(speech, context)
            : null;
          return runChannelEvent(key, () =>
            // handleVoice checks the current turn again after the await. A late
            // answer can only repeat the current question, never replace it.
            handleVoice(
              callSid,
              form.get("From")!,
              turn,
              digits,
              speech,
              interpretation,
            ),
          );
        })();
        pendingTurns.set(key, pending);
      }
      try {
        xml = await pending;
      } finally {
        if (pendingTurns.get(key) === pending) pendingTurns.delete(key);
      }
    }
    // The booking and notification are committed before any provider request.
    // A failed text message changes only the spoken receipt, never the booking.
    const responseXml = await finalizePhoneBookingSms(callSid, xml);
    if (diagnostic)
      logVoiceCallback(form, {
        turn,
        before,
        after: voiceProgress(callSid),
        handling: "routed",
        cached,
        responseXml,
      });
    return xmlResponse(responseXml);
  } catch (error) {
    return webhookFailure(error);
  }
}
