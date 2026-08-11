import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
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
  // standalone status bar — not anything the app paints. Both schemes now
  // name the page itself (--paper), which is what the mobile header under the
  // bar is painted with at `rgb(var(--paper-rgb) / 0.9)`: on a platform where
  // the status bar sits *inside* the app's own canvas, any bar that is not
  // the page reads as a stripe. `light dark` lets the UA render form controls
  // and scrollbars in the matching scheme.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0e" },
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
       * No font className: the app is set in the platform UI face
       * (--font-ui in globals.css), so there is no webfont variable to hang
       * on the body and no font request on the critical path.
       */}
      <body>{children}</body>
    </html>
  );
}
