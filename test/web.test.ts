import { beforeEach, describe, expect, it } from "vitest";
import { DASHBOARD_JS } from "../src/web/dashboard-client";
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
    expect(page.text).toContain("Get paid for your Telegram group");
    expect(page.text).toContain('href="/dashboard#signup"');

    const api = await call("GET", "/");
    expect(api.body.status).toBe("online");
    expect(api.body.dashboard).toBe("/dashboard");
  });

  it("shows the plan fees from the code, not hard-coded copy", async () => {
    const page = await call("GET", "/", { headers: HTML });
    expect(page.text).toContain("15% <small>per sale");
    expect(page.text).toContain("8% <small>per sale");
    expect(page.text).toContain("14 days");
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
    expect(page.text).not.toContain("free trial</a>");
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
