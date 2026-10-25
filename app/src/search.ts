// Relay Chat — the GUI's pure search decisions (M4.3), DOM-free and
// socket-free so Node's test runner can exercise them
// (tests/gui-search.test.ts). The renderer owns the panel; the engine owns
// the query. A new request supersedes an older one: a search_result whose
// requestId is not the current one is stale and ignored.

/** A trimmed query is 1 to 200 characters — anything else is never sent. */
export function isSearchQueryValid(query: string): boolean {
  const trimmed = query.trim();
  return trimmed.length >= 1 && trimmed.length <= 200;
}

/** The exact protocol frames (SPEC table). The query goes out trimmed. */
export function searchFrame(requestId: string, query: string): { type: 'search'; requestId: string; query: string } {
  return { type: 'search', requestId, query: query.trim() };
}

export function exportFrame(requestId: string): { type: 'export'; requestId: string } {
  return { type: 'export', requestId };
}

/**
 * The short text around the first case-insensitive match: `radius` context
 * characters either side, ellipses where the body was cut. A body with no
 * match still shows its start — every result needs a preview.
 */
export function snippetAround(body: string, query: string, radius = 40): string {
  const at = body.toLowerCase().indexOf(query.trim().toLowerCase());
  const qLen = query.trim().length;
  if (at < 0) {
    return body.length <= radius * 2 ? body : `…${body.slice(0, radius * 2 - 1)}…`;
  }
  const start = Math.max(0, at - radius);
  const end = Math.min(body.length, at + qLen + radius);
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
}

/** One search hit as the panel shows it. */
export interface SearchHit {
  id: string;
  source: string;
  createdAt: string;
  body: string;
  snippet: string;
}

/** The panel's whole state — every transition is a pure function here. */
export interface SearchState {
  open: boolean;
  requestId: string | null;
  /** The live query, so a late result can build its own snippets. */
  query: string;
  results: SearchHit[];
  total: number;
}

export function emptySearchState(): SearchState {
  return { open: false, requestId: null, query: '', results: [], total: 0 };
}

/** A new query opens the panel and supersedes any in-flight request. */
export function startSearch(state: SearchState, requestId: string, query: string): SearchState {
  void state;
  return { open: true, requestId, results: [], total: 0, query };
}

/** Store a result — or null when its requestId is stale or the panel is
 *  closed. Hits are capped at the first 100 the engine sends. */
export function applySearchResult(
  state: SearchState,
  frame: { requestId?: unknown; total?: unknown; messages?: unknown },
): SearchState | null {
  if (!state.open || frame.requestId !== state.requestId) return null;
  const messages = Array.isArray(frame.messages) ? frame.messages as Array<Record<string, unknown>> : [];
  const query = state.query ?? '';
  const results: SearchHit[] = messages.slice(0, 100).map((message) => ({
    id: String(message.id ?? ''),
    source: String(message.source ?? ''),
    createdAt: String(message.createdAt ?? ''),
    body: String(message.body ?? ''),
    snippet: snippetAround(String(message.body ?? ''), query),
  }));
  return { ...state, results, total: typeof frame.total === 'number' ? frame.total : results.length };
}

/** Close clears everything, so a late result lands on a closed panel. */
export function closeSearch(state: SearchState): SearchState {
  void state;
  return emptySearchState();
}
