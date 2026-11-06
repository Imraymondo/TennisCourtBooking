import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "COURTSIDE | 网球场预约",
  description:
    "把时间留给球场。发现心仪的网球场，选择日期和时段，开启下一场精彩对打。",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
