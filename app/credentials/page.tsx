import { ITrackApp } from "../ITrackApp";

// A tab root from the URL contract in app/lib/navigation.ts: the client reads the URL (app/lib/useNavigation.ts) and renders the matching screen inside the shell; this page exists so a refresh or a deep link at this path is served rather than 404ed.
export const dynamic = "force-dynamic";

export default function CredentialsRoute() {
  return <ITrackApp />;
}
