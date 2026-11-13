import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cashflow Genius — See money before it moves",
  description:
    "Cashflow Genius — The Living Ledger. One calm home for your money: cashflow, what's due, savings goals, invoices with GST, a scam check for suspicious UPI messages, and an AI CFO that answers from your real numbers.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Cashflow Genius", statusBarStyle: "default" },
  icons: {
    icon: "/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#7c3aed",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
