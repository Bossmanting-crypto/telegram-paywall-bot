/** Public web pages: landing page, creator dashboard and their static assets. */

import { Hono } from "hono";
import { starterPrice } from "../billing";
import { baseUrl, type AppContext } from "../lib/http";
import { llmsTxt, openApi, type AgentInfo } from "../web/agents";
import { DASHBOARD_JS } from "../web/dashboard-client";
import { FONT_FILES } from "../web/fonts";
import { GUIDES, findGuide, guidePage, guidesIndexPage, robotsTxt, sitemapXml } from "../web/guides";
import { dashboardPage, landingPage, platformInfo, type SiteContext } from "../web/pages";
import { APP_CSS } from "../web/styles";

/** Strict policy: no inline script or style, nothing loaded from elsewhere. */
export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; " +
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

function siteContext(c: Parameters<typeof baseUrl>[0]): SiteContext {
  return { ...platformInfo(c.env), baseUrl: baseUrl(c), starterPrice: starterPrice(c.env) };
}
const agentInfo = (c: Parameters<typeof baseUrl>[0]): AgentInfo => siteContext(c);
const guideLinks = GUIDES.map((g) => ({ slug: g.slug, short: g.short }));

// Public pages can be cached briefly at the edge; they hold no personal data.
const PUBLIC_PAGE_HEADERS = { ...PAGE_HEADERS, "cache-control": "public, max-age=300" };

/** The homepage, for browsers that ask for / (API clients still get JSON). */
web.get("/", async (c, next) => {
  if (!wantsHtml(c.req.header("accept"))) return next();
  return c.html(landingPage(siteContext(c), guideLinks), 200, PUBLIC_PAGE_HEADERS);
});

web.get("/guides", (c) => c.html(guidesIndexPage(siteContext(c)), 200, PUBLIC_PAGE_HEADERS));
web.get("/guides/", (c) => c.redirect("/guides", 301));
web.get("/guides/:slug", (c) => {
  const guide = findGuide(c.req.param("slug"));
  if (!guide) return c.redirect("/guides", 302);
  return c.html(guidePage(siteContext(c), guide), 200, PUBLIC_PAGE_HEADERS);
});

web.get("/sitemap.xml", (c) =>
  c.body(sitemapXml(siteContext(c)), 200, { ...ASSET_HEADERS, "content-type": "application/xml; charset=utf-8" }),
);
web.get("/robots.txt", (c) =>
  c.body(robotsTxt(siteContext(c)), 200, { ...ASSET_HEADERS, "content-type": "text/plain; charset=utf-8" }),
);

// Fonts, decoded once per isolate.
const fontCache = new Map<string, ArrayBuffer>();
web.get("/assets/fonts/:file", (c) => {
  const name = c.req.param("file");
  const encoded = FONT_FILES[name];
  if (!encoded) return c.json({ detail: "Not found" }, 404);
  let bytes = fontCache.get(name);
  if (!bytes) {
    bytes = Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)).buffer;
    fontCache.set(name, bytes);
  }
  return c.body(bytes, 200, {
    "content-type": "font/woff2",
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
  });
});

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
