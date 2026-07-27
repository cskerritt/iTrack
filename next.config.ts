import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Evidence uploads POST `multipart/form-data` to /api/evidence. The app
    // router screens every such POST as a progressive server action *before*
    // route matching, so this cap — not the route handler — decides whether
    // the request survives. The 1 MiB default rejected every realistic
    // certificate scan or phone photo with a bare `text/plain` 413. Keep this
    // above the evidence route's own budget (MAX_EVIDENCE_BYTES of 10 MiB plus
    // 1 MiB of multipart overhead) so oversized uploads still fail with the
    // route's descriptive JSON `file_too_large` response.
    serverActions: { bodySizeLimit: "12mb" },
  },
};

export default nextConfig;
