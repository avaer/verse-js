import type { NextConfig } from "next";

// GITHUB_PAGES=true produces a fully static export under `out/`, rooted at
// /verse-js (project pages are served from https://<user>.github.io/verse-js/).
// The normal dev server / `pnpm build` are unaffected. The base path is also
// exposed to client code (NEXT_PUBLIC_BASE_PATH) for fetching public/ assets.
const githubPages = process.env.GITHUB_PAGES === "true";
const basePath = githubPages ? "/verse-js" : "";

const nextConfig: NextConfig = {
  ...(githubPages
    ? {
        output: "export",
        basePath,
        // Directory-style URLs (editor/index.html) so GitHub Pages serves
        // /verse-js/editor/ without any redirect rules.
        trailingSlash: true,
      }
    : {}),
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
