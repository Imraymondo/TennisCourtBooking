export const TIME_ZONE = "Australia/Sydney";
export const COURTS = [
  { id: 1, name: "Court 1", subtitle: "COURT ONE" },
  { id: 2, name: "Court 2", subtitle: "COURT TWO" },
] as const;

export type Channel = "web" | "phone" | "sms" | "email" | "staff";
export type Booking = {
  id: string;
  courtId: number;
  customerName: string;
  email: string;
  phone: string;
  startsAt: string;
  endsAt: string;
  durationHours: number;
  source: Channel;
  status: "confirmed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type BookingInput = {
  courtId: number;
  startLocal: string;
  durationHours?: number;
  customerName: string;
  email?: string;
  phone?: string;
  source?: Channel;
};

export type PublicBooking = Pick<
  Booking,
  "id" | "courtId" | "startsAt" | "endsAt" | "customerName"
>;
export type AvailabilitySlot = {
  courtId: number;
  startLocal: string;
  startsAt?: string;
  endsAt?: string;
  available: boolean;
  // Actual occupancy of this one-hour cell is separate from whether a booking
  // of the selected duration can start here.
  occupied: boolean;
  maxDurationHours: number;
  reason?: string;
};
export type Availability = {
  date: string;
  timeZone: string;
  durationHours: number;
  courts: { id: number; name: string; bookings: PublicBooking[] }[];
  slots: AvailabilitySlot[];
};
