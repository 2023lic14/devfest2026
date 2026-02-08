import type { Metadata } from "next";
import { Cinzel, Inter, Roboto_Mono } from "next/font/google";
import "./globals.css";
import StartupSplash from "./StartupSplash";

const cinzel = Cinzel({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-heading",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-body",
});

const robotoMono = Roboto_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Overture",
  description: "Turn your hum into a cinematic score.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${cinzel.variable} ${inter.variable} ${robotoMono.variable}`}
    >
      <body>
        <StartupSplash />
        {children}
      </body>
    </html>
  );
}
