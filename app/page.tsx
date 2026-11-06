import BookingHome from "./booking-home";
import { TIME_ZONE } from "@/lib/domain";

export const dynamic = "force-dynamic";

export default function Home() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) =>
    parts.find((value) => value.type === type)!.value;
  return (
    <BookingHome today={`${part("year")}-${part("month")}-${part("day")}`} />
  );
}
