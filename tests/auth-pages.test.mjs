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

test("landing page carries the agreed copy and links", () => {
  const html = page("landing.html");
  assert.match(html, /Free during beta/);
  assert.match(html, /\$9\.99\/mo/);
  assert.match(html, /\$79\/yr/);
  assert.match(html, /coming soon/i);
  assert.match(html, /href="\/signup"/);
  assert.match(html, /href="\/login"/);
  assert.doesNotMatch(html, /vigilo|lantern/i, "old product names must not appear");
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
