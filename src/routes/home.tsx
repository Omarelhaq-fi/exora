import { createFileRoute } from "@tanstack/react-router";

import { Landing, landingHead } from "./index";

// Alias of the landing page. vercel.json rewrites "/" -> "/home" so the
// site root always renders the landing even if a stray static file ever
// shadows "/" in the deployment output (rewrites run before static files).
export const Route = createFileRoute("/home")({
  head: landingHead,
  component: Landing,
});
