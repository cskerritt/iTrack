import type { Metadata, Viewport } from "next";
import { Manrope, Newsreader } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  const title = "iTrack — A clear path to renewal";
  const description =
    "A calm continuing-education companion for tracking credits, proof, deadlines, and professional license or certification renewals.";
  const socialImage = new URL("/og.png", metadataBase).toString();

  return {
    metadataBase,
    title: {
      default: title,
      template: "%s · iTrack",
    },
    description,
    applicationName: "iTrack",
    manifest: "/manifest.webmanifest",
    icons: {
      icon: [
        { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      apple: [
        {
          url: "/apple-touch-icon.png",
          sizes: "180x180",
          type: "image/png",
        },
      ],
    },
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: "iTrack",
    },
    formatDetection: {
      telephone: false,
    },
    openGraph: {
      type: "website",
      title,
      description,
      images: [
        {
          url: socialImage,
          width: 2400,
          height: 1260,
          alt: "iTrack — A clear path to renewal",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [socialImage],
    },
  };
}

export const viewport: Viewport = {
  // This colours the browser and OS chrome — the address bar and the
  // standalone status bar — not anything the app paints: the mobile header
  // below it is cream, `rgb(var(--paper-rgb) / 0.9)`. Light keeps the brand
  // green it has always been so the installed app is still recognisably
  // iTrack; dark names the page itself, because a green bar over a near-black
  // page would read as a stripe. `light dark` lets the UA render form controls
  // and scrollbars in the matching scheme.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#163f36" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1917" },
  ],
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${manrope.variable} ${newsreader.variable}`}>
        {children}
      </body>
    </html>
  );
}
