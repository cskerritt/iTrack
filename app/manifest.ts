import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "iTrack — CE & Renewal Tracker",
    short_name: "iTrack",
    description:
      "Track continuing-education credits, documents, deadlines, and renewal steps.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // A manifest cannot answer to prefers-color-scheme: these two are read once,
    // at install, to paint the splash screen. They stay on the light scheme so
    // the installed icon and its splash match the marketing art, and the app
    // itself switches on first paint from the scheme-aware theme-color meta.
    background_color: "#f2f2f7",
    theme_color: "#f2f2f7",
    categories: ["productivity", "education", "business"],
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    prefer_related_applications: false,
  };
}
