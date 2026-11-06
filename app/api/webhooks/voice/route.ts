import { handleVoice } from "@/lib/channels/voice";
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
    if (turn && !/^[a-f0-9-]{36}$/.test(turn))
      throw new AppError("无效的电话会话", 400);
    const xml = runChannelEvent(`voice:${callSid}:${turn ?? "initial"}`, () => {
      rateLimit(`voice:${form.get("From")}`, 200, 3_600_000);
      return handleVoice(
        callSid,
        form.get("From")!,
        turn,
        form.get("Digits") || "",
        form.get("SpeechResult") || "",
      );
    });
    return xmlResponse(xml);
  } catch (error) {
    return webhookFailure(error);
  }
}
