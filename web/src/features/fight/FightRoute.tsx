/**
 * Route "/fights/:raceId". Resolved fights render the settled view in a
 * scrolling page; live and upcoming fights render the fixed fight screen. A
 * fight the lobby no longer has (pruned, or lost to a restart) falls back to
 * its stored final evaluation, read-only; "not found" only when neither
 * exists (see ./route).
 */
import { useParams } from "react-router-dom";
import { ButtonLink, EmptyState, IconArrowLeft, Page } from "../../components";
import { formatFightNumber } from "../../lib/format";
import { useFightEvaluation } from "../evaluation/useFightEvaluation";
import { ArchivedFight, ArchivedFightPlaceholder } from "../settled/ArchivedFight";
import { SettledFight } from "../settled/SettledFight";
import { FightPage, FightPageSkeleton } from "./FightPage";
import { fightRouteView } from "./route";
import { useFightStream } from "./useFightStream";

export function FightRoute() {
  const { raceId } = useParams<{ raceId: string }>();
  const { fight, priceHistory, status, error, notFound, streamStatus, refresh } = useFightStream(raceId);
  // The stored report is looked up only once the lobby says the fight is gone.
  const archive = useFightEvaluation(notFound ? raceId : null, null);
  const view = fightRouteView({ raceId, fightNotFound: notFound, fightStatus: fight?.status ?? null, archive: archive.status });

  if (view === "archived" && archive.evaluation) {
    return (
      <Page title={`Fight ${formatFightNumber(archive.evaluation.number)}`}>
        <ArchivedFight key={archive.evaluation.raceId} evaluation={archive.evaluation} report={archive} />
      </Page>
    );
  }

  if (view === "archive_loading" || view === "archive_error") {
    return (
      <Page title="Fight">
        <ArchivedFightPlaceholder error={view === "archive_error" ? archive.error : null} onRetry={archive.reload} />
      </Page>
    );
  }

  if (view === "not_found") {
    return (
      <Page title="Fight not found">
        <EmptyState
          title="Fight not found"
          description="This fight doesn’t exist, and no report was kept for it."
          action={
            <ButtonLink to="/fights" variant="ghost" icon={<IconArrowLeft size={14} />}>
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
        <SettledFight key={fight.raceId} fight={fight} priceHistory={priceHistory} evaluation={fight.evaluation ?? null} />
      </Page>
    );
  }

  return (
    <Page scroll={false} title={title}>
      <FightPage key={fight.raceId} fight={fight} priceHistory={priceHistory} streamStatus={streamStatus} />
    </Page>
  );
}
