import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Kalam, Shadows_Into_Light, Caveat } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Handwriting fonts a node can switch to (see lib/node-fonts.ts); only downloaded once a node uses one.
// The Hebrew ones are just their Hebrew-letter files from Google Fonts (OFL), limited to Hebrew characters,
// so in mixed text everything else falls through to the English handwriting font after them.
// (next/font needs every option written out as a literal, hence the repetition)
const playpenHebrew = localFont({ src: "./fonts/playpen-sans-hebrew-hebrew.woff2", weight: "100 800", variable: "--font-playpen-hebrew", preload: false, adjustFontFallback: false, declarations: [{ prop: "unicode-range", value: "U+0590-05FF, U+FB1D-FB4F, U+20AA" }] });
const amatic = localFont({
  src: [
    { path: "./fonts/amatic-sc-400-hebrew.woff2", weight: "400" },
    { path: "./fonts/amatic-sc-700-hebrew.woff2", weight: "700" },
  ],
  variable: "--font-amatic",
  preload: false,
  adjustFontFallback: false,
  // Amatic's letters run small next to Shadows Into Light's
  declarations: [{ prop: "unicode-range", value: "U+0590-05FF, U+FB1D-FB4F, U+20AA" }, { prop: "size-adjust", value: "120%" }],
});
const solitreo = localFont({ src: "./fonts/solitreo-hebrew.woff2", weight: "400", variable: "--font-solitreo", preload: false, adjustFontFallback: false, declarations: [{ prop: "unicode-range", value: "U+0590-05FF, U+FB1D-FB4F, U+20AA" }] });
const kalam = Kalam({ variable: "--font-kalam", weight: ["400", "700"], subsets: ["latin"], preload: false });
const shadows = Shadows_Into_Light({ variable: "--font-shadows", weight: "400", subsets: ["latin"], preload: false });
const caveat = Caveat({ variable: "--font-caveat", subsets: ["latin"], preload: false });

export const metadata: Metadata = {
  title: "Mind Map",
  description: "Study mind maps",
  // "Add to Home Screen" on iPad opens it full screen, without Safari's toolbars
  appleWebApp: {
    capable: true,
    title: "Mind Map",
    statusBarStyle: "black-translucent",
  },
};

// The canvas handles pinch-zoom itself; page zoom (and iOS auto-zoom on input focus) would fight it.
// viewport-fit=cover lets the app use the full screen; safe-area insets are handled in CSS.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0f172a",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${playpenHebrew.variable} ${amatic.variable} ${solitreo.variable} ${kalam.variable} ${shadows.variable} ${caveat.variable}`}>
      <body>{children}</body>
    </html>
  );
}
