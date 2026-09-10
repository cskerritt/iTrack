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

test("login page: next field, generic error, and a resend form with its own email input", () => {
  const html = page("login.html");
  assert.match(html, /action="\/auth\/login"/);
  assert.match(html, /name="email"/);
  assert.match(html, /name="password"/);
  assert.match(html, /<input type="hidden" name="next" id="next">/);
  assert.match(html, /href="\/reset"/);
  assert.doesNotMatch(html, /flash-unverified/, "no unverified-specific state");
  assert.match(html, /id="flash-sent">If that address can be used, we've sent an email to it\./);
  assert.match(html, /id="flash-mail-unconfigured">Email delivery is not set up yet; contact support@itrackceu\.com/,
    "the resend form lands here, so the unconfigured-mail copy lives here too");
  assert.match(html, /params\.get\("mail"\) === "unconfigured" \? "flash-mail-unconfigured" : "flash-sent"/);
  const resendForm = html.match(/<form action="\/auth\/resend" method="post"[\s\S]*?<\/form>/);
  assert.ok(resendForm, "resend form present");
  assert.match(resendForm[0], /<input id="resend-email" name="email" type="email" required/, "resend has its own visible email input");
  assert.doesNotMatch(resendForm[0], /type="hidden" name="email"/);
});

test("verify page: the confirm form posts the token AND the current password; problem view has resend", () => {
  const html = page("verify.html");
  const confirmForm = html.match(/<form action="\/auth\/verify" method="post">[\s\S]*?<\/form>/);
  assert.ok(confirmForm, "confirm form present");
  assert.match(confirmForm[0], /<input type="hidden" name="token" id="token">/);
  assert.match(confirmForm[0], /<input id="password" name="password" type="password" required autocomplete="current-password"/,
    "a bare link must not confirm a password the inbox owner never set");
  assert.match(confirmForm[0], />Confirm my email</);
  assert.match(html, /id="confirm-flash-password">That password doesn't match this account\./);
  assert.match(html, /id="confirm-flash-rate-limited">Too many attempts\./);
  assert.match(html, /href="\/signup"/, "the way out of a replaced password is to sign up again");
  assert.match(html, /error === "password" \|\| error === "rate-limited"/, "retryable errors keep the confirm view and its token");
  assert.match(html, /If you already confirmed, just log in\./);
  assert.match(html, /action="\/auth\/resend"/);
  assert.match(html, /href="\/login"/);
  // The resend form redirects to /login, and the route's rate-limited answer
  // always carries the token (which selects the confirm view), so the problem
  // view can never show a sent or rate-limited state.
  const problemView = html.match(/<div id="problem-view"[\s\S]*?<\/main>/)[0];
  assert.doesNotMatch(problemView, /id="flash-sent"|id="flash-rate-limited"/, "unreachable flash elements removed");
  assert.match(problemView, /id="flash-expired"/);
});

test("signup sent state names the address, shows neutral copy, and offers resend", () => {
  const html = page("signup.html");
  assert.match(html, /id="flash-sent">If that address can be used, we've sent an email to it\./);
  assert.match(html, /id="flash-mail-unconfigured">Email delivery is not set up yet; contact support@itrackceu\.com/);
  assert.doesNotMatch(html, /email-taken|already has an account/i);
  // A delivery failure never reaches the copy: only the branch with an
  // account to mail can fail to send, so a "couldn't send" state would name it.
  assert.doesNotMatch(html, /flash-mail-failed|couldn't send the email/i);
  assert.match(html, /params\.get\("mail"\) === "unconfigured" \? "flash-mail-unconfigured" : "flash-sent"/);
  assert.match(html, /<form action="\/auth\/resend" method="post" id="resend-form"/);
  assert.match(html, /<input type="hidden" name="return" value="signup">/);
});

test("reset page uses the neutral sent copy and the unconfigured-mail copy with the support line", () => {
  const html = page("reset.html");
  assert.match(html, /id="flash-sent">If that address can be used, we've sent an email to it\./);
  assert.match(html, /id="flash-mail-unconfigured">Email delivery is not set up yet; contact support@itrackceu\.com/);
  assert.match(html, /params\.get\("mail"\) === "unconfigured" \? "flash-mail-unconfigured" : "flash-sent"/);
});

test("reset page has both request and set-password forms", () => {
  const html = page("reset.html");
  assert.match(html, /action="\/auth\/request-reset"/);
  assert.match(html, /action="\/auth\/reset"/);
  assert.match(html, /name="token"/);
});
