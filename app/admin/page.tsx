import type { Metadata } from "next";
import AdminConsole from "./admin-console";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Staff console | COURTSIDE",
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) =>
    parts.find((part) => part.type === type)!.value;
  const today = `${value("year")}-${value("month")}-${value("day")}`;
  return <AdminConsole initialDate={today} />;
}
