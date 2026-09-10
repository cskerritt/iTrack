import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pagesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "deploy", "railway", "pages",
);
const page = (name) => readFileSync(path.join(pagesDir, name), "utf8");

test("all five pages exist and are self-contained", () => {
  for (const name of ["landing.html", "signup.html", "login.html", "verify.html", "reset.html"]) {
    assert.ok(existsSync(path.join(pagesDir, name)), `${name} missing`);
    const html = page(name);
    assert.match(html, /^<!doctype html>/i);
    assert.doesNotMatch(html, /src="http/i, `${name} must not load external scripts`);
    assert.doesNotMatch(html, /href="http.*\.css/i, `${name} must not load external styles`);
    assert.match(html, /<style>/, `${name} must inline its CSS`);
  }
});

test("landing page carries no pricing, tier, or beta copy and keeps its links", () => {
  const html = page("landing.html");
  assert.doesNotMatch(html, /\$\d/, "no prices");
  assert.doesNotMatch(html, /\bbeta\b/i, "no beta copy");
  assert.doesNotMatch(html, /ad-supported/i, "no ad tier");
  assert.doesNotMatch(html, /coming soon/i, "no Pro teaser");
  assert.doesNotMatch(html, /<h3>Pro\b/, "no Pro tier");
  assert.doesNotMatch(html, /class="tier"|class="pricing"/, "pricing section removed");
  assert.match(html, /href="\/signup"/);
  assert.match(html, /href="\/login"/);
  assert.match(html, /mailto:support@itrackceu\.com/);
  assert.doesNotMatch(html, /name="robots"/, "landing is indexable");
  assert.doesNotMatch(html, /vigilo|lantern/i, "old product names must not appear");
});

test("auth pages are noindex and signup carries no beta copy", () => {
  for (const name of ["signup.html", "login.html", "verify.html", "reset.html"]) {
    assert.match(page(name), /<meta name="robots" content="noindex">/, `${name} must be noindex`);
  }
  assert.doesNotMatch(page("signup.html"), /\bbeta\b/i);
  assert.match(page("signup.html"), /No card required\./);
});

test("robots.txt and sitemap.xml exist and name only the public routes", () => {
  const publicDir = path.join(pagesDir, "..", "..", "..", "public");
  const robots = readFileSync(path.join(publicDir, "robots.txt"), "utf8");
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.match(robots, /^Sitemap: https:\/\/itrackceu\.com\/sitemap\.xml$/m);
  const sitemap = readFileSync(path.join(publicDir, "sitemap.xml"), "utf8");
  for (const loc of ["https://itrackceu.com/", "https://itrackceu.com/login", "https://itrackceu.com/signup"]) {
    assert.match(sitemap, new RegExp(`<loc>${loc.replace(/[/.]/g, "\\$&")}</loc>`));
  }
  assert.doesNotMatch(sitemap, /credentials|history|profile/);
  const favicon = readFileSync(path.join(publicDir, "favicon.ico"));
  assert.equal(favicon.readUInt16LE(2), 1, "favicon.ico is an ICO container (type 1)");
});

test("signup form posts the fields auth-routes reads", () => {
  const html = page("signup.html");
  assert.match(html, /action="\/auth\/signup"/);
  assert.match(html, /method="post"/i);
  for (const field of ['name="name"', 'name="email"', 'name="password"']) {
    assert.match(html, new RegExp(field));
  }
  assert.match(html, /minlength="10"/);
});

test("login form posts credentials and links to reset + resend", () => {
  const html = page("login.html");
  assert.match(html, /action="\/auth\/login"/);
  assert.match(html, /name="email"/);
  assert.match(html, /name="password"/);
  assert.match(html, /href="\/reset"/);
  assert.match(html, /action="\/auth\/resend"/);
});

test("reset page has both request and set-password forms", () => {
  const html = page("reset.html");
  assert.match(html, /action="\/auth\/request-reset"/);
  assert.match(html, /action="\/auth\/reset"/);
  assert.match(html, /name="token"/);
});

test("verify page links back into the app and to login", () => {
  const html = page("verify.html");
  assert.match(html, /href="\/login"/);
});
