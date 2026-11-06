import { createBooking, listBookings } from "@/lib/store";
import { isAdmin, requireAdmin } from "@/lib/auth";
import {
  apiError,
  ensureSameOrigin,
  json,
  limitRequest,
  readJson,
} from "@/lib/http";
import type { BookingInput } from "@/lib/domain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try {
    requireAdmin(request);
    return json({
      bookings: listBookings(
        new URL(request.url).searchParams.get("date") || undefined,
      ),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    ensureSameOrigin(request);
    limitRequest(request, "create", 30);
    const input = await readJson<BookingInput>(request);
    const source = isAdmin(request) ? (input.source ?? "staff") : "web";
    return json(createBooking({ ...input, source }), 201);
  } catch (error) {
    return apiError(error);
  }
}
