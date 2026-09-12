/**
 * Fights (home, handoff 2.1). Route "/".
 *
 * Demo layout: the first fight from the backend is the featured card, large
 * and fully live (Kalshi-style outcomes, Yes / No and a probability chart).
 * The cards beneath it are hardcoded previews (./placeholders) that look like
 * real fights but are not interactive. The filter row (`?filter=`) and the
 * top-bar search (`?q=`) apply to that list; the featured fight always shows.
 */
import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, EmptyState, ErrorBanner, Page, PageHeader, SegmentedControl, type SegmentedOption } from "../../components";
import { cx } from "../../lib/cx";
import { FIGHT_STATUS_LABEL } from "../../lib/labels";
import { HOME_STATUS_PARAM, useSearchQuery, useSetSearchQuery } from "../../state/search";
import { useFights } from "../../state/fights";
import { FeaturedFightCard, FeaturedFightEmpty, FeaturedFightSkeleton } from "./FeaturedFightCard";
import { FightCardList, FightCardListSkeleton } from "./FightCard";
import { FILTER_PARAM, countByFilter, filterFights, parseFightFilter, type FightFilter } from "./filter";
import { buildPlaceholderFights } from "./placeholders";
import styles from "./HomePage.module.css";

const FILTER_LABEL: Readonly<Record<FightFilter, string>> = { all: "All", ...FIGHT_STATUS_LABEL };
const FILTER_ORDER: readonly FightFilter[] = ["all", "live", "upcoming", "resolved"];
/** Number the previews around when the backend has no fight yet. */
const DEFAULT_FEATURED_NUMBER = 412;

export function HomePage() {
  const { fights, error, loaded, refresh } = useFights();
  const [params, setParams] = useSearchParams();
  // `?status=` is the foundation's name for the same filter; read it as a fallback.
  const filter = parseFightFilter(params.get(FILTER_PARAM) ?? params.get(HOME_STATUS_PARAM));
  const query = useSearchQuery().trim();
  const setQuery = useSetSearchQuery();
  const [retrying, setRetrying] = useState(false);

  const setFilter = useCallback(
    (next: FightFilter) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next === "all") p.delete(FILTER_PARAM);
          else p.set(FILTER_PARAM, next);
          p.delete(HOME_STATUS_PARAM);
          return p;
        },
        { replace: true },
      );
    },
    [setParams],
  );

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

  const totals = useMemo(() => countByFilter(featured ? [featured, ...previews] : previews), [featured, previews]);
  const matching = useMemo(() => filterFights(previews, "all", query), [previews, query]);
  const counts = useMemo(() => countByFilter(matching), [matching]);
  const visible = useMemo(() => (filter === "all" ? matching : matching.filter((f) => f.status === filter)), [matching, filter]);

  const options: SegmentedOption<FightFilter>[] = FILTER_ORDER.map((value) => ({
    value,
    label: FILTER_LABEL[value],
    count: counts[value],
  }));

  const subtitle = loaded ? (
    <span className="num">
      {totals.live} live · {totals.upcoming} upcoming · {totals.resolved} resolved
    </span>
  ) : (
    "Agents race a real web task while a master agent sabotages them."
  );

  return (
    <Page title="Fights">
      <PageHeader title="Fights" subtitle={subtitle} />

      <div className={cx(styles.body, styles.featuredSection)}>
        {error && (
          <ErrorBanner
            error={error}
            title={loaded ? "Live updates interrupted." : "Couldn’t load fights."}
            onRetry={() => void retry()}
            retrying={retrying}
          />
        )}

        {!loaded ? <FeaturedFightSkeleton /> : featured ? <FeaturedFightCard fight={featured} /> : <FeaturedFightEmpty />}
      </div>

      <div className={styles.toolbar}>
        <SegmentedControl options={options} value={filter} onChange={setFilter} aria-label="Filter fights by status" />
        {query && (
          <div className={styles.searchNote}>
            <span>
              <span className="num">{visible.length}</span> {visible.length === 1 ? "result" : "results"} for “{query}”
            </span>
            <Button size="sm" variant="subtle" onClick={() => setQuery("")}>
              Clear
            </Button>
          </div>
        )}
      </div>

      <div className={styles.body}>
        {!loaded ? (
          <FightCardListSkeleton count={3} />
        ) : visible.length === 0 ? (
          <HomeEmpty filter={filter} query={query} counts={counts} onFilter={setFilter} onClearQuery={() => setQuery("")} />
        ) : (
          <FightCardList fights={visible} label={`${FILTER_LABEL[filter]} fights`} preview />
        )}
      </div>
    </Page>
  );
}

type HomeEmptyProps = {
  filter: FightFilter;
  query: string;
  counts: Record<FightFilter, number>;
  onFilter: (filter: FightFilter) => void;
  onClearQuery: () => void;
};

function HomeEmpty({ filter, query, counts, onFilter, onClearQuery }: HomeEmptyProps) {
  if (query) {
    return (
      <EmptyState
        title={`No ${filter === "all" ? "" : `${FILTER_LABEL[filter].toLowerCase()} `}fights match “${query}”`}
        description={
          filter !== "all" && counts.all > 0
            ? `${counts.all} ${counts.all === 1 ? "fight matches" : "fights match"} in other states.`
            : "Search matches task titles, fight numbers and agent names."
        }
        action={
          <div className={styles.emptyActions}>
            {filter !== "all" && counts.all > 0 && (
              <Button size="sm" onClick={() => onFilter("all")}>
                Show all
              </Button>
            )}
            <Button size="sm" onClick={onClearQuery}>
              Clear search
            </Button>
          </div>
        }
      />
    );
  }

  switch (filter) {
    case "live":
      return <EmptyState title="No other live fights right now" description="New fights appear here as soon as they open." />;
    case "upcoming":
      return <EmptyState title="Nothing scheduled" description="Fights are listed here before they open, with the sabotage they will face." />;
    case "resolved":
      return <EmptyState title="No resolved fights yet" description="Settled fights and their winners are listed here." />;
    default:
      return <EmptyState title="No other fights yet" description="Fights appear here as soon as they are scheduled." />;
  }
}
