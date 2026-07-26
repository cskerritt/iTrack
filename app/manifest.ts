import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "License Lantern — CE & Renewal Tracker",
    short_name: "Lantern",
    description:
      "Track continuing-education credits, documents, deadlines, and renewal steps.",
    start_url: "/",
    display: "standalone",
    background_color: "#f6f4ee",
    theme_color: "#163f36",
    orientation: "portrait-primary",
    categories: ["productivity", "education", "business"],
  };
}
