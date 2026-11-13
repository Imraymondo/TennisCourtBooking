import { apiError, json, readJson } from "@/lib/http";
import { timingSafeText } from "@/lib/channels/security";
import {
  handleRealtimeRequest,
  parseRealtimeRequest,
  realtimeVoiceEnabled,
} from "@/lib/channels/realtime";
import { AppError } from "@/lib/store";
import { finalizePhoneBookingSms } from "@/lib/channels/phone-sms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server bridge only: this route is never exposed by the public HTTP relay. */
export async function POST(request: Request) {
  try {
    const expected = process.env.REALTIME_BRIDGE_SECRET?.trim();
    if (
      !expected ||
      !timingSafeText(
        request.headers.get("authorization") || "",
        `Bearer ${expected}`,
      )
    )
      throw new AppError("Invalid Realtime call credentials.", 403);
    if (!realtimeVoiceEnabled())
      throw new AppError("The Realtime phone channel is not configured.", 503);
    const input = parseRealtimeRequest(await readJson(request));
    const result = handleRealtimeRequest(input);
    // handleRealtimeRequest has completed its synchronous transaction. SMS
    // delivery is separate so provider failures cannot undo a reservation.
    return json({
      ...result,
      prompt: await finalizePhoneBookingSms(input.callSid, result.prompt),
    });
  } catch (error) {
    return apiError(error);
  }
}
