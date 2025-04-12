# Task List: Phase 5 Query Enhancement (Hybrid Search + Weighted Re-ranking)

## I. `memory-action.ts` Implementation

### A. Constants and Setup
- [ ] Define constant `RRF_K = 60`.
- [ ] Define constant `ENTITY_WEIGHTS` object with agreed-upon initial weights:
  ```typescript
  const ENTITY_WEIGHTS = {
      people: 0.10,
      locations: 0.10,
      topics: 0.05,
      type: 0.05,
      sentiment: 0.05,
      date_day: 0.15,
      date_month: 0.10,
      date_year: 0.05,
      date_period: 0.05,
      fts_date_range: 0.10
  };
  ```
- [ ] Add optional `source?: 'vector' | 'fts'` property to `ContextObject` interface.
- [ ] Add `rrf_score?: number` property to `ContextObject` interface (for passing data internally).
- [ ] Add `rrf_score: number` property to `ScoredContextObject` interface.

### B. Concurrent Search Implementation
- [ ] Create helper function `executeVectorSearch(embedding, queryMetadata)`:
    - [ ] Takes query embedding and processed metadata.
    - [ ] Calls `search_memory_chunks` RPC with appropriate parameters.
    - [ ] Handles RPC errors gracefully (returns empty array or throws specific error).
    - [ ] Maps successful results to `ContextObject[]`, setting `source: 'vector'`, preserving `similarity`, `chunk_index`.
- [ ] Create helper function `executeFtsSearch(queryMetadata, originalQueryEntities)`:
    - [ ] Takes processed metadata and the *original* input entities (for accessing original date strings if needed for FTS query construction).
    - [ ] Constructs FTS query string from relevant entities (people, locations, topics, type, sentiment, original date strings).
    - [ ] Builds and executes the Supabase FTS query on `files` table, selecting `id`, `transcript_text`, `created_at`, `file_metadata`, and `rank: ts_rank_cd(...)`.
    - [ ] Handles query errors gracefully.
    - [ ] Maps successful results to `ContextObject[]`, setting `source: 'fts'`, preserving `rank`. **Note:** `rank` here is the raw FTS rank, not normalized yet.
- [ ] Refactor `query`/`combined` mode logic:
    - [ ] Generate query embedding as before.
    - [ ] Call `executeVectorSearch` and `executeFtsSearch` concurrently using `Promise.allSettled`.
    - [ ] Collect results from successful promises (or empty arrays if failed).

### C. RRF Implementation
- [ ] Create helper function `applyRRF(vectorResults: ContextObject[], ftsResults: ContextObject[], k: number): ContextObject[]`.
- [ ] Inside `applyRRF`:
    - [ ] Initialize `rrfScores: Map<string, { score: number; context: ContextObject }>` (key = `file_id`).
    - [ ] Process `vectorResults`: Iterate, calculate `1 / (k + rank)` (use index+1 as rank), add score to map entry for `file_id`. Prioritize storing the `ContextObject` from vector search if key collision occurs.
    - [ ] Process `ftsResults`: Iterate, calculate `1 / (k + rank)` (use index+1 as rank), add score to map entry for `file_id`. Store the `ContextObject` only if the `file_id` key doesn't already exist from vector results.
    - [ ] Convert map to array: `{ file_id: string, rrf_score: number, context: ContextObject }[]`.
    - [ ] Sort array by `rrf_score` descending.
    - [ ] Map sorted array back to `ContextObject[]`, adding the calculated `rrf_score` property to each object.

### D. RRF Integration
- [ ] After concurrent searches resolve, call `applyRRF` with the results.
- [ ] Determine `query_source` based on which searches succeeded/returned results (`'hybrid'`, `'vector_store'`, `'postgres_fallback_text'`, `'none'`, `'error'`).
- [ ] Pass the RRF-ranked list (candidates with `rrf_score`) to `rerankResults`.

### E. `rerankResults` Refinement
- [ ] Modify `rerankResults` signature: accept `candidates: ContextObject[]` (ensure `rrf_score` and `source` are present), remove `query_source` parameter.
- [ ] **Normalize RRF Score:**
    - [ ] Find `min_rrf_score` and `max_rrf_score` from candidates.
    - [ ] Handle edge case `max === min`.
    - [ ] Calculate `initial_score` using min-max scaling: `(candidate.rrf_score - min_rrf_score) / (max_rrf_score - min_rrf_score)`.
- [ ] **Implement Granular Additive Boosting:**
    - [ ] Initialize `metadata_boost_score = 0.0`.
    - [ ] Add weights from `ENTITY_WEIGHTS` for matching `people`, `locations`, `topics`, `type`, `sentiment`.
    - [ ] Implement hierarchical date matching logic, adding only the single highest applicable weight (`date_day` > `date_month` > `date_year`) per query/candidate date comparison. Accumulate across query dates.
    - [ ] Add weight for matching `date_period`.
    - [ ] If `candidate.source === 'fts'`, apply `fts_date_range` boost using existing timestamp logic and the corresponding weight.
- [ ] Calculate `final_score = Math.min(1.0, initial_score + metadata_boost_score)`.
- [ ] Update `ScoredContextObject` population in the mapping loop.
- [ ] In the final step before returning, map `ScoredContextObject[]` back to `ContextObject[]`, removing temporary properties (`rrf_score`, `initial_score`, `metadata_boost_score`, `final_score`, `source`).

## II. `openapi.json` Updates
- [ ] Modify `components.schemas.SuccessResponse.properties.query_source.enum`: Add `'hybrid'` to the list.

## III. `gpt_instructions.md` Updates
- [ ] Modify "Handling Action Responses" -> "[Concise Summary]" -> "If information was retrieved...":
    - [ ] Remove specific phrasing recommendations tied only to `vector_store` or `postgres_fallback_text`.
    - [ ] Add guidance for `hybrid`: Use general phrasing like "Based on your records..." or "Found information related to..."

## IV. Dependency & Configuration Checks
- [ ] Verify `package.json`: Confirm no new dependencies required.
- [ ] Verify `netlify.toml`: Confirm no configuration changes required.

## V. Testing (Post-Implementation)
- [ ] (Manual) Test with queries designed to trigger:
    - Only Vector results.
    - Only FTS results.
    - Hybrid results (both contribute).
    - Edge cases (no results, errors in one/both searches).
- [ ] (Manual) Verify re-ranking behavior by comparing results for queries with varying metadata overlap.
- [ ] (Future - Phase 6) Define formal benchmark queries and evaluation metrics for systematic tuning of `RRF_K` and `ENTITY_WEIGHTS`.