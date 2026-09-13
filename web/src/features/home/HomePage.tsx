/**
 * Fights (home). Route "/", `?filter=live|upcoming|resolved&q=`.
 *
 * A filter row (All / Live / Upcoming / Resolved, and search) over the
 * lobby: the featured fight, then every other fight as a card, one section
 * per status: every live fight (trading open or frozen), what is coming up,
 * and the latest resolved fights (see ./lobby for what each filter shows).
 * The rail on the right is the compact read: standings, the next few fights,
 * and everything settled.
 *
 * The featured card is one fight, large and fully live (Kalshi-style
 * outcomes, Yes / No and a probability chart), picked and kept by ./featured
 * so it never changes mid-race.
 */
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigationType, useSearchParams } from "react-router-dom";
import { Button, ButtonLink, EmptyState, ErrorBanner, Page } from "../../components";
import { cx } from "../../lib/cx";
import { formatNumber } from "../../lib/format";
import { useFights } from "../../state/fights";
import { SEARCH_PARAM, useSetSearchQuery } from "../../state/search";
import { FeaturedFightCard, FeaturedFightEmpty, FeaturedFightSkeleton } from "./FeaturedFightCard";
import { FightCardList, FightCardListSkeleton } from "./FightCard";
import { useFeaturedFight } from "./featured";
import { FILTER_PARAM, parseFightFilter, type FightFilter } from "./filter";
import { buildLobby, buildRail, type LobbySection } from "./lobby";
import { LobbyRail } from "./LobbyRail";
import { LobbyToolbar } from "./LobbyToolbar";
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

  // The filter and the search live in the URL, so a filtered lobby can be
  // linked to (the Resolved screen's "Watch live fights") and survives Back.
  const [params, setParams] = useSearchParams();
  const filter = parseFightFilter(params.get(FILTER_PARAM));
  const rawQuery = params.get(SEARCH_PARAM) ?? "";
  const query = rawQuery.trim();
  const setQuery = useSetSearchQuery();
  const setFilter = useCallback(
    (next: FightFilter) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          if (next === "all") updated.delete(FILTER_PARAM);
          else updated.set(FILTER_PARAM, next);
          return updated;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  // "See all" keeps the search: all resolved fights that match it.
  const seeAllResolved = useMemo(() => {
    const next = new URLSearchParams(params);
    next.set(FILTER_PARAM, "resolved");
    return `?${next.toString()}`;
  }, [params]);

  // A link to another filter ("See all") starts that list at the top; the
  // page stays mounted, so nothing else would move it. Back is restored by <Page>.
  const navigationType = useNavigationType();
  const topRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (navigationType === "PUSH") topRef.current?.scrollIntoView({ block: "nearest" });
  }, [filter, navigationType]);

  // One fight, kept while it runs: never swapped for a newer one mid-race.
  const featured = useFeaturedFight(fights);

  const lobby = useMemo(() => buildLobby({ fights, featured, filter, query }), [fights, featured, filter, query]);
  const rail = useMemo(() => buildRail({ fights, loaded }), [fights, loaded]);

  // The lobby has no fight at all: the featured slot says so.
  const noFights = !lobby.hero && filter === "all" && !query;
  const nothingShown = !lobby.hero && lobby.sections.every((s) => s.fights.length === 0);

  return (
    <Page title="Fights">
      <div className={styles.layout}>
        <div className={styles.main}>
          <div ref={topRef} className={styles.top}>
            <LobbyToolbar
              filter={filter}
              onFilter={setFilter}
              counts={loaded ? lobby.counts : null}
              query={rawQuery}
              onQuery={setQuery}
            />
          </div>

          {/* A dropped stream after the first load is the global connection banner's job. */}
          {error && !loaded && (
            <ErrorBanner
              error={error}
              title="Couldn’t load fights."
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
              {lobby.hero ? <FeaturedFightCard fight={lobby.hero} /> : noFights ? <FeaturedFightEmpty /> : null}
              {nothingShown && !noFights ? (
                <LobbyEmpty
                  filter={filter}
                  query={query}
                  onClearQuery={() => setQuery("")}
                  onFilter={setFilter}
                />
              ) : (
                lobby.sections.map((section) =>
                  section.fights.length > 0 ? (
                    <LobbySectionView
                      key={section.status}
                      section={section}
                      title={sectionTitle(section, lobby.hero?.status === "live")}
                      seeAllTo={seeAllResolved}
                    />
                  ) : null,
                )
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

function LobbySectionView({ section, title, seeAllTo }: { section: LobbySection; title: string; seeAllTo: string }) {
  const headingId = useId();
  // Only the All view caps a section (its resolved fights).
  const capped = section.total > section.fights.length;
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <div className={styles.sectionHead}>
        <h2 id={headingId} className={cx("label", styles.sectionTitle)}>
          {title}
        </h2>
        {capped && (
          <ButtonLink to={seeAllTo} variant="subtle" size="sm" className={styles.sectionMore}>
            See all <span className="num">{formatNumber(section.total)}</span>
          </ButtonLink>
        )}
      </div>
      <FightCardList fights={section.fights} label={`${title} fights`} />
    </section>
  );
}

const EMPTY_COPY: Readonly<Record<Exclude<FightFilter, "all">, { title: string; description: string }>> = {
  live: {
    title: "No live fights right now",
    description: "Upcoming fights go live on their own; this list fills as soon as one starts.",
  },
  upcoming: {
    title: "Nothing scheduled",
    description: "Fights are listed here before they open, with the sabotage they will face.",
  },
  resolved: {
    title: "No resolved fights yet",
    description: "When a fight settles, its winner, final prices and volume are listed here.",
  },
};

/** Nothing matches the filter or the search. */
function LobbyEmpty({
  filter,
  query,
  onClearQuery,
  onFilter,
}: {
  filter: FightFilter;
  query: string;
  onClearQuery: () => void;
  onFilter: (filter: FightFilter) => void;
}) {
  if (query) {
    return (
      <EmptyState
        title={`No fights match “${query}”`}
        description={
          filter === "all"
            ? "Search by task, agent name or fight number."
            : "Nothing under this filter matches. Try All, or another search."
        }
        action={
          <Button size="sm" onClick={onClearQuery}>
            Clear search
          </Button>
        }
      />
    );
  }
  if (filter === "all") return null;
  const copy = EMPTY_COPY[filter];
  return (
    <EmptyState
      title={copy.title}
      description={copy.description}
      action={
        filter === "live" ? (
          <Button size="sm" onClick={() => onFilter("upcoming")}>
            See upcoming fights
          </Button>
        ) : undefined
      }
    />
  );
}
