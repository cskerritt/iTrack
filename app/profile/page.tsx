import { ITrackApp } from "../ITrackApp";

// Tab root — see app/credentials/page.tsx for why every route in the URL
// contract needs its own server-rendered entry.
export const dynamic = "force-dynamic";

export default function ProfileRoute() {
  return <ITrackApp />;
}
