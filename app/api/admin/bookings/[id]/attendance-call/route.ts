import { requireAdmin } from "@/lib/auth";
import { startAttendanceCall } from "@/lib/channels/attendance";
import {
  apiError,
  ensureSameOrigin,
  json,
  limitRequest,
  readJson,
} from "@/lib/http";
import { AppError } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    requireAdmin(request);
    ensureSameOrigin(request);
    limitRequest(request, "attendance-call", 30);
    const { id } = await context.params;
    if (!/^\d{8}$/.test(id)) throw new AppError("预约编号无效", 400);
    const input = await readJson<{ version: number; requestId: string }>(
      request,
    );
    if (
      Object.keys(input).some((key) => !["version", "requestId"].includes(key))
    )
      throw new AppError("回访请求包含不支持的字段", 400);
    const attendanceCall = await startAttendanceCall(
      id,
      input.version,
      input.requestId,
    );
    return json({ attendanceCall }, 202);
  } catch (error) {
    return apiError(error);
  }
}
