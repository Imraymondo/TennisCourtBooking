import { apiError, json, readJson } from "@/lib/http";
import { timingSafeText } from "@/lib/channels/security";
import {
  handleRealtimeRequest,
  parseRealtimeRequest,
  realtimeVoiceEnabled,
} from "@/lib/channels/realtime";
import { AppError } from "@/lib/store";

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
      throw new AppError("无效的实时通话凭据", 403);
    if (!realtimeVoiceEnabled())
      throw new AppError("实时电话渠道尚未配置", 503);
    const input = parseRealtimeRequest(await readJson(request));
    return json(handleRealtimeRequest(input));
  } catch (error) {
    return apiError(error);
  }
}
