import { getBooking } from "@/lib/store";
import { isAdmin } from "@/lib/auth";
import {
  apiError,
  ensureSameOrigin,
  json,
  limitRequest,
  readJson,
} from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    ensureSameOrigin(request);
    limitRequest(request, "lookup", 20);
    const input = await readJson<{ id: string; accessCode?: string }>(request);
    return json({
      booking: getBooking(input.id, input.accessCode, isAdmin(request)),
    });
  } catch (error) {
    return apiError(error);
  }
}
