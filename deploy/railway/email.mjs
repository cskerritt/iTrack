// Minimal Resend client. When unconfigured it reports `mail_unconfigured`
// so the caller can show the support address instead of pretending to send.
export function createResendSender({ apiKey, from, fetchImpl = fetch }) {
  return async ({ to, subject, html, text }) => {
    if (!apiKey || !from) return { ok: false, error: "mail_unconfigured" };
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
        return { ok: false, error: "send_failed" };
      }
      return { ok: true };
    } catch (error) {
      console.error("[email] resend request failed", error);
      return { ok: false, error: "send_failed" };
    }
  };
}
