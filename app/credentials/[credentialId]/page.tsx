import { ITrackApp } from "../../ITrackApp";

// The credential detail is a routed screen: the id is read on the client from the URL (app/lib/useNavigation.ts) and the same shell is served, so /credentials/:id survives a refresh or a cold deep link. Unknown ids are replaced by the credentials root in the client.
export const dynamic = "force-dynamic";

export default function CredentialDetailRoute() {
  return <ITrackApp />;
}
