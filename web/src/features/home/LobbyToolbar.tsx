/**
 * The lobby's filter row: All / Live / Upcoming / Resolved, with a count of
 * represented fights on each, and a search box. Both live in the URL (`?filter=`,
 * `?q=`), so a filtered lobby can be linked to and survives Back.
 */
import { useEffect, useRef, useState } from "react";
import { IconSearch, SegmentedControl } from "../../components";
import { FIGHT_FILTERS, type FightFilter } from "./filter";
import styles from "./LobbyToolbar.module.css";

const FILTER_LABEL: Readonly<Record<FightFilter, string>> = {
  all: "All",
  live: "Live",
  upcoming: "Upcoming",
  resolved: "Resolved",
};

export type LobbyToolbarProps = {
  filter: FightFilter;
  onFilter: (filter: FightFilter) => void;
  /** Displayed fights per filter; null while the lobby loads. */
  counts: Record<FightFilter, number> | null;
  /** The current `?q=`, untrimmed. */
  query: string;
  onQuery: (query: string) => void;
};

export function LobbyToolbar({ filter, onFilter, counts, query, onQuery }: LobbyToolbarProps) {
  const options = FIGHT_FILTERS.map((value) => ({
    value,
    label: FILTER_LABEL[value],
    count: counts && value !== "all" ? counts[value] : undefined,
  }));
  return (
    <div className={styles.toolbar}>
      <SegmentedControl options={options} value={filter} onChange={onFilter} aria-label="Show fights" />
      <SearchField value={query} onChange={onQuery} />
    </div>
  );
}

/**
 * Typing edits a local draft: the URL updates in a transition, and an input
 * bound straight to it would lose keystrokes. The draft follows the URL only
 * while the field isn't focused (Back, a link, a cleared search).
 */
function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(value);
  }, [value]);

  return (
    <label className={styles.search}>
      <IconSearch size={14} className={styles.searchIcon} />
      <span className="sr-only">Search fights by task, agent or number</span>
      <input
        ref={inputRef}
        type="search"
        className={styles.searchInput}
        value={draft}
        placeholder="Search fights"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange(event.target.value);
        }}
      />
    </label>
  );
}
