import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "COURTSIDE | Tennis court bookings",
  description:
    "Make time for your next game. Find an available tennis court, choose your date and time, and book your next match.",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-AU">
      <body>{children}</body>
    </html>
  );
}
