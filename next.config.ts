import type { NextConfig } from "next";

// Extra hosts allowed to load the dev server (e.g. LAN or Tailscale addresses),
// comma-separated in ALLOWED_DEV_ORIGINS in .env.local.
const allowedDevOrigins = (process.env.ALLOWED_DEV_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins,
};

export default nextConfig;
