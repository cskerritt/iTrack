// Minimal Resend client. When unconfigured it fails soft with a distinct
// error code so callers can log the would-be link for manual onboarding.
export function createResendSender({ apiKey, from, fetchImpl = fetch }) {
  return async ({ to, subject, html, text }) => {
    if (!apiKey || !from) return { ok: false, error: "email-not-configured" };
    try {
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ from, to: [to], subject, html, text }),
      });
      if (!response.ok) {
        console.error(`[email] resend responded ${response.status}: ${(await response.text()).slice(0, 300)}`);
        return { ok: false, error: "send-failed" };
      }
      return { ok: true };
    } catch (error) {
      console.error("[email] resend request failed", error);
      return { ok: false, error: "send-failed" };
    }
  };
}
