import { ITrackApp } from "../ITrackApp";

// A tab root from the URL contract in app/lib/navigation.ts. The client router
// only ever replaces the address bar, but a refresh, a deep link, or the iOS
// shell reloading its `server.url` all hit the server at this path — without a
// page here they would 404 instead of restoring the tab.
export const dynamic = "force-dynamic";

export default function CredentialsRoute() {
  return <ITrackApp />;
}
