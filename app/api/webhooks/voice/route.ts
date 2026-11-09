import { handleVoice, recoverVoiceTurn } from "@/lib/channels/voice";
import {
  verifiedTwilioForm,
  webhookFailure,
  xmlResponse,
} from "@/lib/channels/security";
import { AppError, rateLimit, runChannelEvent } from "@/lib/store";

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
    if (process.env.VOICE_DEBUG === "1") {
      console.info(
        "Voice callback:",
        JSON.stringify({
          turn: turn ? "present" : "missing",
          input: speech.trim() ? "speech" : digits.trim() ? "digits" : "empty",
          handling: recovery ? "recovery" : "routed",
        }),
      );
    }
    if (recovery) {
      rateLimit(`voice:${form.get("From")}`, 200, 3_600_000);
      return xmlResponse(recoverVoiceTurn(callSid));
    }
    const xml = runChannelEvent(`voice:${callSid}:${turn ?? "initial"}`, () => {
      rateLimit(`voice:${form.get("From")}`, 200, 3_600_000);
      return handleVoice(callSid, form.get("From")!, turn, digits, speech);
    });
    return xmlResponse(xml);
  } catch (error) {
    return webhookFailure(error);
  }
}
