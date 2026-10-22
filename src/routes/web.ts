/** Public web pages: landing page, creator dashboard and their static assets. */

import { Hono } from "hono";
import { starterPrice } from "../billing";
import { baseUrl, type AppContext } from "../lib/http";
import { llmsTxt, openApi, type AgentInfo } from "../web/agents";
import { DASHBOARD_JS } from "../web/dashboard-client";
import { dashboardPage, landingPage, platformInfo } from "../web/pages";
import { APP_CSS } from "../web/styles";

/** Strict policy: no inline script or style, nothing loaded from elsewhere. */
export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const PAGE_HEADERS = {
  "content-security-policy": PAGE_CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
};

const ASSET_HEADERS = {
  "x-content-type-options": "nosniff",
  "cache-control": "public, max-age=300",
};

export function wantsHtml(accept: string | undefined): boolean {
  return /\btext\/html\b/.test(accept ?? "");
}

export const web = new Hono<AppContext>();

/** The landing page, for browsers that ask for / (API clients still get JSON). */
web.get("/", async (c, next) => {
  if (!wantsHtml(c.req.header("accept"))) return next();
  return c.html(landingPage(platformInfo(c.env), starterPrice(c.env)), 200, PAGE_HEADERS);
});

function agentInfo(c: Parameters<typeof baseUrl>[0]): AgentInfo {
  return { ...platformInfo(c.env), baseUrl: baseUrl(c), starterPrice: starterPrice(c.env) };
}

// For AI agents and other bots: what this is and how to sign up.
web.get("/llms.txt", (c) =>
  c.body(llmsTxt(agentInfo(c)), 200, { ...ASSET_HEADERS, "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" }),
);
web.get("/openapi.json", (c) =>
  c.json(openApi(agentInfo(c)), 200, { ...ASSET_HEADERS, "access-control-allow-origin": "*" }),
);

web.get("/dashboard", (c) => c.html(dashboardPage(platformInfo(c.env)), 200, PAGE_HEADERS));
web.get("/signup", (c) => c.redirect("/dashboard#signup", 302));

web.get("/assets/app.css", (c) =>
  c.body(APP_CSS, 200, { ...ASSET_HEADERS, "content-type": "text/css; charset=utf-8" }),
);
web.get("/assets/dashboard.js", (c) =>
  c.body(DASHBOARD_JS, 200, { ...ASSET_HEADERS, "content-type": "text/javascript; charset=utf-8" }),
);
