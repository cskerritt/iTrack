import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { ClientErrorBeacon } from "./components/ClientErrorBeacon";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/Toast";
import { FONT_PRELOADS } from "./lib/fonts";
import "./globals.css";

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
  // standalone status bar — not anything the app paints. Both schemes name
  // --paper-deep, the surface the rail and the phone app bar are painted
  // with (app/styles/tokens.css): on a phone the status bar sits directly on
  // that bar, so a chrome colour that is not the bar's reads as a stripe.
  // `light dark` lets the UA render form controls and scrollbars in the
  // matching scheme.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ebe7dc" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0e0b" },
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
      {/*
       * The four faces on every first paint — body 400/700, display 700/800 —
       * are preloaded; the rest (mono, the italic) load through @font-face in
       * app/styles/fonts.css with font-display: swap behind metric-matched
       * fallbacks, so no font request ever blocks paint. Font fetches are
       * CORS-mode even same-origin, hence crossOrigin on the preload. The
       * names come from app/lib/fonts.ts — never next/font, whose cache
       * tests/dist-hygiene.test.mjs forbids.
       */}
      <head>
        {FONT_PRELOADS.map((href) => (
          <link
            key={href}
            rel="preload"
            href={href}
            as="font"
            type="font/woff2"
            crossOrigin="anonymous"
          />
        ))}
      </head>
      <body>
        <ClientErrorBeacon />
        <ErrorBoundary>
          <ToastProvider>{children}</ToastProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
