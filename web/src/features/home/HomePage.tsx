/**
 * Fights (home). Route "/".
 *
 * Demo layout: the first fight from the backend is the featured card, large
 * and fully live (Kalshi-style outcomes, Yes / No and a probability chart).
 * The cards beneath it are hardcoded previews (./placeholders) that look like
 * real fights but are not interactive.
 *
 * Each status has one home: the featured card is the live fight, the grid
 * holds what is coming up, and the rail on the right carries the standings
 * and everything already settled.
 */
import { useCallback, useMemo, useState } from "react";
import { EmptyState, ErrorBanner, Page } from "../../components";
import { cx } from "../../lib/cx";
import { useSearchQuery } from "../../state/search";
import { useFights } from "../../state/fights";
import { FeaturedFightCard, FeaturedFightEmpty, FeaturedFightSkeleton } from "./FeaturedFightCard";
import { FightCardList, FightCardListSkeleton } from "./FightCard";
import { filterFights } from "./filter";
import { buildPlaceholderFights } from "./placeholders";
import { LobbyRail } from "./LobbyRail";
import styles from "./HomePage.module.css";

/** Number the previews around when the backend has no fight yet. */
const DEFAULT_FEATURED_NUMBER = 412;

export function HomePage() {
  const { fights, error, loaded, refresh } = useFights();
  const query = useSearchQuery().trim();
  const [retrying, setRetrying] = useState(false);

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await refresh();
    } finally {
      setRetrying(false);
    }
  }, [refresh]);

  // The backend lists live fights first, so the demo's real fight leads.
  const featured = fights[0] ?? null;
  const featuredNumber = featured?.number ?? DEFAULT_FEATURED_NUMBER;
  const [anchor] = useState(() => Date.now());
  const previews = useMemo(() => buildPlaceholderFights(anchor, featuredNumber), [anchor, featuredNumber]);

  const matching = useMemo(() => filterFights(previews, "all", query), [previews, query]);
  const upcoming = useMemo(() => matching.filter((f) => f.status === "upcoming"), [matching]);

  // Real settled fights fill the rail once the backend has any; the demo's
  // previews stand in only while it has none.
  const settled = useMemo(() => fights.filter((f) => f.status === "resolved"), [fights]);
  const previewResolved = useMemo(() => matching.filter((f) => f.status === "resolved"), [matching]);
  const resolved = settled.length > 0 ? settled : previewResolved;

  return (
    <Page title="Fights">
      <div className={styles.layout}>
        <div className={styles.main}>
          {error && (
            <ErrorBanner
              error={error}
              title={loaded ? "Live updates interrupted." : "Couldn’t load fights."}
              onRetry={() => void retry()}
              retrying={retrying}
            />
          )}

          {!loaded ? <FeaturedFightSkeleton /> : featured ? <FeaturedFightCard fight={featured} /> : <FeaturedFightEmpty />}

          <section className={styles.section} aria-labelledby="upcoming-heading">
            <h2 id="upcoming-heading" className={cx("label", styles.sectionHead)}>
              Upcoming
            </h2>
            {!loaded ? (
              <FightCardListSkeleton count={2} />
            ) : upcoming.length === 0 ? (
              <EmptyState
                title="Nothing scheduled"
                description="Fights are listed here before they open, with the sabotage they will face."
              />
            ) : (
              <FightCardList fights={upcoming} label="Upcoming fights" preview />
            )}
          </section>
        </div>

        <LobbyRail resolved={resolved} preview={settled.length === 0} />
      </div>
    </Page>
  );
}
