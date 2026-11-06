import { getAvailability } from "@/lib/store";
import { apiError, json, limitRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try {
    limitRequest(request, "availability", 240);
    const query = new URL(request.url).searchParams;
    const duration = query.has("durationHours")
      ? Number(query.get("durationHours"))
      : 2;
    return json(getAvailability(query.get("date") || "", duration));
  } catch (error) {
    return apiError(error);
  }
}
