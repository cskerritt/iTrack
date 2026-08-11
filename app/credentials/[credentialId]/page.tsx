import { ITrackApp } from "../../ITrackApp";

// The pushed credential detail screen. The id is read on the client from
// `window.location` via parseRoute, so this route only has to serve the same
// shell; it exists so `/credentials/:id` survives a refresh or a cold deep
// link. Unknown ids fall back to the credentials root in the client.
export const dynamic = "force-dynamic";

export default function CredentialDetailRoute() {
  return <ITrackApp />;
}
