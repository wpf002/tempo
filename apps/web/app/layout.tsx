import type { Metadata, Viewport } from "next";
import { Fraunces, Geist } from "next/font/google";
import "./globals.css";

// Self-hosted at build time, so the panel makes no third-party requests.
const sans = Geist({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-sans", display: "swap" });
const display = Fraunces({ subsets: ["latin"], weight: ["500", "700"], variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  title: "Tempo",
  description: "Chess coach for Chess.app and Lichess",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}
