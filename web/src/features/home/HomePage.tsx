/**
 * Fights (home). Route "/".
 *
 * The featured fight, then every other fight as a card, one section per
 * status: every live fight (trading open or frozen), what is coming up, and
 * the latest resolved fights (see ./lobby). The rail on the right is the
 * compact read: standings, the next few fights, and everything settled.
 *
 * The featured card is one fight, large and fully live (Kalshi-style
 * outcomes, Yes / No and a probability chart), picked and kept by ./featured
 * so it never changes mid-race. Preview cards (./placeholders) stand in,
 * marked as such, while the backend has no upcoming fights.
 */
import { useCallback, useId, useMemo, useState } from "react";
import { ButtonLink, ErrorBanner, Page, Tag } from "../../components";
import { cx } from "../../lib/cx";
import { formatNumber } from "../../lib/format";
import { serverNow } from "../../state/clock";
import { useFights } from "../../state/fights";
import { FeaturedFightCard, FeaturedFightEmpty, FeaturedFightSkeleton } from "./FeaturedFightCard";
import { FightCardList, FightCardListSkeleton } from "./FightCard";
import { useFeaturedFight } from "./featured";
import { buildLobby, buildRail, type LobbySection } from "./lobby";
import { LobbyRail } from "./LobbyRail";
import { PREVIEW_FIGHT_HINT, buildPlaceholderFights, previewsAllowed } from "./placeholders";
import styles from "./HomePage.module.css";

export function HomePage() {
  const { fights, error, loaded, refresh } = useFights();
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

  const lobby = useMemo(
    () => buildLobby({ fights, featured, filter: "all", query: "", previews }),
    [fights, featured, previews],
  );
  const rail = useMemo(() => buildRail({ fights, loaded, previews }), [fights, loaded, previews]);

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

          {!loaded ? (
            <>
              <FeaturedFightSkeleton />
              <FightCardListSkeleton count={2} />
            </>
          ) : (
            <>
              {lobby.hero ? <FeaturedFightCard fight={lobby.hero} /> : <FeaturedFightEmpty />}
              {lobby.sections.map((section) =>
                section.fights.length > 0 ? (
                  <LobbySectionView key={section.status} section={section} title={sectionTitle(section, lobby.hero?.status === "live")} />
                ) : null,
              )}
            </>
          )}
        </div>

        <LobbyRail upcoming={rail.upcoming} resolved={rail.resolved} />
      </div>
    </Page>
  );
}

function sectionTitle(section: LobbySection, heroIsLive: boolean): string {
  if (section.status === "live") return heroIsLive ? "More live fights" : "Live now";
  if (section.status === "upcoming") return "Upcoming";
  return section.total > section.fights.length ? "Recently resolved" : "Resolved";
}

function LobbySectionView({ section, title }: { section: LobbySection; title: string }) {
  const headingId = useId();
  const capped = section.total > section.fights.length;
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <div className={styles.sectionHead}>
        <h2 id={headingId} className={cx("label", styles.sectionTitle)}>
          {title}
        </h2>
        {section.preview && (
          <Tag tone="edge" title={PREVIEW_FIGHT_HINT}>
            Preview
          </Tag>
        )}
        {capped && (
          <ButtonLink to="/resolved" variant="subtle" size="sm" className={styles.sectionMore}>
            See all <span className="num">{formatNumber(section.total)}</span>
          </ButtonLink>
        )}
      </div>
      {section.preview && (
        <p className={styles.previewNote}>
          Nothing is scheduled yet, so these sample fights show what’s coming. They can’t be opened or traded.
        </p>
      )}
      <FightCardList fights={section.fights} label={`${title} fights`} preview={section.preview} />
    </section>
  );
}
