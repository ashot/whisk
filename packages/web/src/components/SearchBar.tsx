import React from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import { HintPair } from "./KeyCap";

export function SearchBar(): React.ReactElement {
  const s = useTracked([(s) => s.searchQuery, (s) => s.searchStatus]);
  return (
    <div className="searchbar">
      <span className="searchbar-glyph" aria-hidden>
        /
      </span>
      <input
        className="searchbar-input"
        autoFocus
        value={s.searchQuery}
        placeholder="Search mail…"
        type="search"
        enterKeyHint="search"
        onChange={(e) => useMailStore.setState({ searchQuery: e.target.value })}
      />
      {s.searchStatus === "searching" && <span className="spin" aria-label="Searching" />}
      <span className="searchbar-hint">
        <HintPair clickable spec="enter">search all mail</HintPair>
        <HintPair clickable spec="escape">close</HintPair>
      </span>
    </div>
  );
}
