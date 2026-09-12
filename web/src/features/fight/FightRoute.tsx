/**
 * Route "/fights/:raceId". Resolved fights render the settled view in a
 * scrolling page; live and upcoming fights render the fixed fight screen.
 */
import { useParams } from "react-router-dom";
import { ButtonLink, EmptyState, IconArrowLeft, Page } from "../../components";
import { formatFightNumber } from "../../lib/format";
import { SettledFight } from "../settled/SettledFight";
import { FightPage, FightPageSkeleton } from "./FightPage";
import { useFightStream } from "./useFightStream";

export function FightRoute() {
  const { raceId } = useParams<{ raceId: string }>();
  const { fight, priceHistory, status, error, notFound, streamStatus, refresh } = useFightStream(raceId);

  if (notFound || !raceId) {
    return (
      <Page title="Fight not found">
        <EmptyState
          title="Fight not found"
          description="This fight doesn’t exist or is no longer available."
          action={
            <ButtonLink to="/" variant="ghost" icon={<IconArrowLeft size={14} />}>
              Back to fights
            </ButtonLink>
          }
        />
      </Page>
    );
  }

  if (!fight) {
    return (
      <Page scroll={false} title="Fight">
        <FightPageSkeleton error={status === "error" ? error : null} onRetry={() => void refresh()} />
      </Page>
    );
  }

  const title = `Fight ${formatFightNumber(fight.number)}`;

  if (fight.status === "resolved") {
    return (
      <Page title={title}>
        <SettledFight key={fight.raceId} fight={fight} priceHistory={priceHistory} />
      </Page>
    );
  }

  return (
    <Page scroll={false} title={title}>
      <FightPage key={fight.raceId} fight={fight} priceHistory={priceHistory} streamStatus={streamStatus} />
    </Page>
  );
}
