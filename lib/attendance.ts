export type AttendanceCallStatus =
  | "requesting"
  | "queued"
  | "ringing"
  | "in-progress"
  | "attending"
  | "cancelled"
  | "unanswered"
  | "completed"
  | "failed"
  | "unknown"
  | "stale";

// Public administrator data deliberately excludes provider IDs and contact data.
export type AttendanceCallSummary = {
  id: string;
  bookingId: string;
  bookingVersion: number;
  status: AttendanceCallStatus;
  createdAt: number;
  updatedAt: number;
  canRetry: boolean;
};

/** Use an explicit international contact or an Australian local mobile only. */
export function attendanceRecipient(value: string): string | null {
  if (!/^[+\d ()-]+$/.test(value)) return null;
  let phone = value.replace(/[ ()-]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  else if (/^04\d{8}$/.test(phone)) phone = `+61${phone.slice(1)}`;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}
