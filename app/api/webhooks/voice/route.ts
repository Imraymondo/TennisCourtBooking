import {
  handleVoice,
  recoverVoiceTurn,
  voiceProgress,
} from "@/lib/channels/voice";
import { logVoiceCallback } from "@/lib/channels/voice-diagnostics";
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

export async function POST(request: Request) {
  try {
    const form = await verifiedTwilioForm(request);
    const callSid = form.get("CallSid");
    if (!callSid || !/^[A-Za-z0-9]{10,64}$/.test(callSid))
      throw new AppError("缺少通话编号", 400);
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
    const cached = diagnostic && getChannelEvent(key) !== null;
    const xml = runChannelEvent(key, () => {
      rateLimit(`voice:${form.get("From")}`, 200, 3_600_000);
      return handleVoice(callSid, form.get("From")!, turn, digits, speech);
    });
    if (diagnostic)
      logVoiceCallback(form, {
        turn,
        before,
        after: voiceProgress(callSid),
        handling: "routed",
        cached,
        responseXml: xml,
      });
    return xmlResponse(xml);
  } catch (error) {
    return webhookFailure(error);
  }
}
