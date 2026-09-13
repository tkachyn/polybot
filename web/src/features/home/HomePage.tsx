/**
 * Fights (home). Route "/".
 *
 * The featured card is one fight, large and fully live (Kalshi-style
 * outcomes, Yes / No and a probability chart), picked and kept by ./featured
 * so it never changes mid-race. Preview cards (./placeholders) stand in,
 * marked as such, while the backend has no upcoming fights.
 *
 * The featured card is the live fight and the grid beneath it is what is
 * coming up, in full. The rail on the right is the compact read: standings,
 * the next few fights, and everything already settled.
 */
import { useCallback, useMemo, useState } from "react";
import { EmptyState, ErrorBanner, Page } from "../../components";
import { cx } from "../../lib/cx";
import { serverNow } from "../../state/clock";
import { useSearchQuery } from "../../state/search";
import { useFights } from "../../state/fights";
import { FeaturedFightCard, FeaturedFightEmpty, FeaturedFightSkeleton } from "./FeaturedFightCard";
import { FightCardList, FightCardListSkeleton } from "./FightCard";
import { useFeaturedFight } from "./featured";
import { filterFights } from "./filter";
import { buildPlaceholderFights, previewsAllowed } from "./placeholders";
import { LobbyRail } from "./LobbyRail";
import styles from "./HomePage.module.css";

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

  // One fight, kept while it runs: never swapped for a newer one mid-race.
  const featured = useFeaturedFight(fights);
  const [anchor] = useState(() => serverNow());
  // Previews stand in only on a loaded, healthy lobby (never behind a skeleton
  // or beside an error), numbered clear of every real fight.
  const allowPreviews = previewsAllowed({ loaded, error });
  const previews = useMemo(
    () => (allowPreviews ? buildPlaceholderFights(anchor, fights.map((f) => f.number)) : []),
    [allowPreviews, anchor, fights],
  );

  const matching = useMemo(() => filterFights(previews, "all", query), [previews, query]);

  // Real fights fill the rail once the backend has any of that status; the
  // demo's previews stand in only while it has none.
  const scheduled = useMemo(() => fights.filter((f) => f.status === "upcoming"), [fights]);
  const previewUpcoming = useMemo(() => matching.filter((f) => f.status === "upcoming"), [matching]);
  const upcoming = scheduled.length > 0 ? scheduled : previewUpcoming;

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
              <FightCardList fights={upcoming} label="Upcoming fights" preview={scheduled.length === 0} />
            )}
          </section>
        </div>

        <LobbyRail
          upcoming={upcoming}
          resolved={resolved}
          preview={settled.length === 0 && resolved.length > 0}
          upcomingPreview={scheduled.length === 0 && upcoming.length > 0}
        />
      </div>
    </Page>
  );
}
