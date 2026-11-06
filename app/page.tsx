import BookingHome, { type DateOption } from "./booking-home";

export const dynamic = "force-dynamic";

export default function Home() {
  // Resolve the club's calendar day on the server, then pass stable values to the
  // client. UTC arithmetic keeps the seven calendar dates correct across DST.
  const sydneyParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = Number(sydneyParts.find((part) => part.type === "year")!.value);
  const month = Number(
    sydneyParts.find((part) => part.type === "month")!.value,
  );
  const day = Number(sydneyParts.find((part) => part.type === "day")!.value);
  const today = Date.UTC(year, month - 1, day);
  const weekdayFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "UTC",
    weekday: "short",
  });
  const labelFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
  });
  const monthLabel = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
  }).format(new Date(today));
  const dates: DateOption[] = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today + index * 24 * 60 * 60 * 1000);
    const weekday = weekdayFormatter.format(date);
    return {
      key: date.toISOString().slice(0, 10),
      day: weekday,
      number: String(date.getUTCDate()).padStart(2, "0"),
      label: `${labelFormatter.format(date)}，${weekday}`,
      isToday: index === 0,
      isWeekend: date.getUTCDay() === 0 || date.getUTCDay() === 6,
    };
  });

  return <BookingHome dates={dates} monthLabel={monthLabel} />;
}
