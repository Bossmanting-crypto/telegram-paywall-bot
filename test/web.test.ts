import { beforeEach, describe, expect, it } from "vitest";
import { DASHBOARD_JS } from "../src/web/dashboard-client";
import { GUIDES } from "../src/web/guides";
import { esc } from "../src/web/pages";
import { call, envWith, mockFetch, resetDatabase } from "./helpers";

const HTML = { accept: "text/html,application/xhtml+xml" };

beforeEach(async () => {
  mockFetch();
  await resetDatabase();
});

describe("landing page", () => {
  it("serves HTML to browsers and JSON to API clients on /", async () => {
    const page = await call("GET", "/", { headers: HTML });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.text).toContain("Your Telegram group, now a <em>business</em>.");
    expect(page.text).toContain('href="/dashboard#signup"');

    const api = await call("GET", "/");
    expect(api.body.status).toBe("online");
    expect(api.body.dashboard).toBe("/dashboard");
  });

  it("shows the plan fees from the code, not hard-coded copy", async () => {
    const page = await call("GET", "/", { headers: HTML });
    expect(page.text).toContain('data-ladder="[[20000,0.06],[5000,0.08],[1000,0.1],[0,0.12]]"');
    expect(page.text).toContain("Fee by sales in the last 30 days: 12% to start, 10% from $1,000, 8% from $5,000, 6% from $20,000.");
    expect(page.text).not.toContain("trial");
  });

  it("uses the platform name and contact, escaped", async () => {
    const env = envWith({ PLATFORM_NAME: "Kofi <Paywall>", SUPPORT_CONTACT: '@kofi "support"' });
    const page = await call("GET", "/", { headers: HTML, env });
    expect(page.text).toContain("Kofi &lt;Paywall&gt;");
    expect(page.text).not.toContain("Kofi <Paywall>");
    expect(page.text).toContain("@kofi &quot;support&quot;");
  });

  it("hides the trial button when signups are closed", async () => {
    const page = await call("GET", "/", { headers: HTML, env: envWith({ ALLOW_SIGNUPS: "false" }) });
    expect(page.text).not.toContain("Start now</a>");
    expect(page.text).toContain("signups are paused");
  });
});

describe("dashboard", () => {
  it("is served under a strict content security policy with no inline script", async () => {
    const page = await call("GET", "/dashboard");
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    // Every <script> loads from a file; no inline code and no inline styles.
    expect(page.text).toMatch(/<script src="\/assets\/dashboard\.js" defer><\/script>/);
    expect(page.text).not.toMatch(/<script>|<script [^>]*>[^<]+<\/script>/);
    expect(page.text).not.toMatch(/style="/);
    expect(page.text).toContain('name="robots" content="noindex"');
  });

  it("passes platform settings to the script through meta tags", async () => {
    const env = envWith({ SUPPORT_CONTACT: "@owner", ALLOW_SIGNUPS: "false" });
    const page = await call("GET", "/dashboard", { env });
    expect(page.text).toContain('<meta name="pb-contact" content="@owner">');
    expect(page.text).toContain('<meta name="pb-signups" content="closed">');
  });

  it("redirects /signup to the signup form", async () => {
    const res = await call("GET", "/signup");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard#signup");
  });

  it("serves the script and stylesheet with the right types", async () => {
    const js = await call("GET", "/assets/dashboard.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect(js.text).toBe(DASHBOARD_JS);

    const css = await call("GET", "/assets/app.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.text).toContain("prefers-color-scheme: dark");
  });

  it("never writes server data into the page as HTML", () => {
    // The script builds every element with createElement/textContent.
    expect(DASHBOARD_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(DASHBOARD_JS).not.toMatch(/\beval\(|new Function/);
  });

  it("only calls endpoints that exist", async () => {
    const paths = new Set<string>();
    for (const m of DASHBOARD_JS.matchAll(/api\("(GET|POST|PATCH|DELETE)", "([^"]+)"/g)) paths.add(`${m[1]} ${m[2]}`);
    expect(paths.size).toBeGreaterThan(5);
    for (const entry of paths) {
      const [method, path] = entry.split(" ") as [string, string];
      const res = await call(method, path.split("?")[0]!, { json: method === "GET" ? undefined : {} });
      // Unauthenticated calls must be refused, never "Not found".
      expect(res.status, entry).not.toBe(404);
    }
  });
});

describe("esc", () => {
  it("escapes text and attribute characters", () => {
    expect(esc(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });
});

describe("public site", () => {
  it("says you only pay when you get paid only when Starter has no price", async () => {
    const page = await call("GET", "/", { headers: HTML });
    expect(page.text).toContain("You only pay when you get paid: 12% of each sale, falling to 6% as you grow.");
    expect(page.text).toContain(">Start now</a>");
    expect(page.text).not.toContain("7 minutes");
    expect(page.text.match(/in minutes/g)).toHaveLength(1); // speed, mentioned once
    expect(page.text).not.toMatch(/\bdemo\b/i);
    expect(page.text).toContain('<link rel="canonical" href="https://paywall.test/">');
    expect(page.headers.get("content-security-policy")).toContain("font-src 'self'");
  });

  it("serves every guide, linked from the index, the homepage and the sitemap", async () => {
    const index = await call("GET", "/guides");
    expect(index.status).toBe(200);
    const sitemap = await call("GET", "/sitemap.xml");
    expect(sitemap.headers.get("content-type")).toContain("application/xml");
    for (const g of GUIDES) {
      const res = await call("GET", `/guides/${g.slug}`);
      expect(res.status, g.slug).toBe(200);
      expect(res.text).toContain(`<link rel="canonical" href="https://paywall.test/guides/${g.slug}">`);
      expect(res.text).toContain(`<meta name="description" content="${esc(g.description)}">`);
      expect(index.text).toContain(`href="/guides/${g.slug}"`);
      expect(sitemap.text).toContain(`<loc>https://paywall.test/guides/${g.slug}</loc>`);
      for (const r of g.related) expect(GUIDES.some((x) => x.slug === r), `${g.slug} → ${r}`).toBe(true);
    }
    // Every guide link on the homepage points at a real guide.
    const home = await call("GET", "/", { headers: HTML });
    for (const m of home.text.matchAll(/href="\/guides\/([a-z0-9-]+)"/g)) {
      expect(GUIDES.some((g) => g.slug === m[1]), m[1]).toBe(true);
    }
  });

  it("sends unknown guides back to the index", async () => {
    const res = await call("GET", "/guides/nope");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/guides");
  });

  it("tells crawlers what to index", async () => {
    const robots = await call("GET", "/robots.txt");
    expect(robots.text).toContain("Disallow: /dashboard");
    expect(robots.text).toContain("Sitemap: https://paywall.test/sitemap.xml");
  });

  it("serves its own fonts", async () => {
    for (const f of ["newsreader.woff2", "newsreader-italic.woff2", "hanken-grotesk.woff2"]) {
      const res = await call("GET", `/assets/fonts/${f}`);
      expect(res.status, f).toBe(200);
      expect(res.headers.get("content-type")).toBe("font/woff2");
      expect(res.text.startsWith("wOF2")).toBe(true);
    }
    expect((await call("GET", "/assets/fonts/other.woff2")).status).toBe(404);
  });

  it("is honest with agents about the steps that need a person", async () => {
    const guide = await call("GET", "/llms.txt");
    expect(guide.text).not.toMatch(/no human/i);
    expect(guide.text).toContain("ask your human for");
    expect(guide.text).toContain("@BotFather");
    for (const g of GUIDES) expect(guide.text).toContain(`/guides/${g.slug}`);
  });

  it("shows a worked earnings example without script, and serves the calculator", async () => {
    const page = await call("GET", "/", { headers: HTML });
    // 60 members × $5 = $300 a month; the 12% fee leaves $264.
    expect(page.text).toContain('<span class="calc-keep" id="calc-keep">$264</span>');
    expect(page.text).toContain('data-currency="KES"');
    expect(page.text).toContain('data-period="day"');
    expect(page.text).toContain('<script src="/assets/home.js" defer></script>');
    const js = await call("GET", "/assets/home.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.text).toContain("data-calc");
    expect(js.text).toContain("KSh ");
    expect(js.text).not.toMatch(/innerHTML|eval\(/);
  });

  it("adds a 'See what members see' button only for a valid preview bot", async () => {
    expect((await call("GET", "/", { headers: HTML })).text).not.toContain("See what members see");
    const withBot = await call("GET", "/", { headers: HTML, env: envWith({ PREVIEW_BOT_USERNAME: "@StudioPreviewBot" }) });
    expect(withBot.text).toContain('href="https://t.me/StudioPreviewBot"');
    expect(withBot.text).toContain("See what members see");
    const bad = await call("GET", "/", { headers: HTML, env: envWith({ PREVIEW_BOT_USERNAME: "x\"><script>" }) });
    expect(bad.text).not.toContain("See what members see");
  });
});
