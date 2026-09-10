// One place that turns a fetch Response into something the UI can reason
// about. A lapsed session is a state, not a parse error; a proxy error page
// is "unexpected", not a SyntaxError in a banner.
export const UNEXPECTED_RESPONSE_MESSAGE = "The server returned an unexpected response.";
export const SESSION_ENDED_MESSAGE = "Your sign-in needs to be refreshed.";

export type ApiResult<T> =
  | { kind: "json"; ok: boolean; status: number; data: T }
  | { kind: "session-ended"; status: 401 }
  | { kind: "unexpected"; status: number; text: string };

export async function readApiResponse<T>(response: Response): Promise<ApiResult<T>> {
  if (response.status === 401) return { kind: "session-ended", status: 401 };
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType)) {
    return { kind: "unexpected", status: response.status, text: (await response.text()).slice(0, 500) };
  }
  const text = await response.text();
  try {
    return { kind: "json", ok: response.ok, status: response.status, data: JSON.parse(text) as T };
  } catch {
    return { kind: "unexpected", status: response.status, text: text.slice(0, 500) };
  }
}
