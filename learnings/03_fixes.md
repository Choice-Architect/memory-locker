# Memory Locker: Fix Log (Post v1.8.0)

This log tracks fixes applied after the v1.8.0 feature completion (Hybrid Date Parsing & Query Enhancements).

## Fixes Applied (April 12, 2025)

Based on the analysis of `learnings/test-1-results.csv` and Supabase Edge Logs (`testing/supabase-edge-logs-vmmpodvzidqucxgizpoi.csv`), the following issues were identified and addressed in `netlify/functions/memory-action/memory-action.ts`:

1.  **Critical FTS Query Failure:**
    *   **Issue:** All Full-Text Search (FTS) queries were failing with a Supabase `PGRST100` error ("failed to parse select parameter"). This was visible in both Netlify function logs within `test-1-results.csv` and confirmed by 400 errors in the Supabase edge logs.
    *   **Cause:** Incorrect syntax in the `.select()` clause within the `executeFtsSearch` function. Explicitly calculating `ts_rank_cd` conflicted with the implicit ranking mechanism of `supabase-js`'s `.textSearch()` and `.order('rank', ...)` methods.
    *   **Fix:** Simplified the `.select()` call in `executeFtsSearch` to only request necessary columns (`id`, `transcript_text`, `created_at`, `file_metadata`), removing the explicit `rank:ts_rank_cd(...)` calculation. Ranking is now handled implicitly by `.order('rank', { ascending: false })` after `.textSearch()`.
    *   **Commit:** `656dd98`

2.  **Inconsistent Vector Search Results:**
    *   **Issue:** Vector search (`executeVectorSearch` calling the `search_memory_chunks` RPC) returned no results for test queries Q1-Q4, despite relevant data existing and the RPC call succeeding (Status 200 in Supabase logs). Test C1 did return one result.
    *   **Probable Cause:** The `VECTOR_MATCH_THRESHOLD` of `0.5` was likely too high for the `text-embedding-3-small` model in this context. External sources suggest similarity scores are generally lower for this model compared to older ones.
    *   **Fix/Tuning:**
        *   Lowered `VECTOR_MATCH_THRESHOLD` constant from `0.5` to `0.4`.
        *   Added diagnostic `console.log` statements in `executeVectorSearch` to log the filters being applied and the raw count of results returned by the `search_memory_chunks` function *before* any application-layer processing.
    *   **Commit:** `656dd98`

**Next Steps:**

*   Re-run tests (`test-1-results.csv`) to confirm both FTS and Vector Search are now functioning as expected.
*   Evaluate the new `VECTOR_MATCH_THRESHOLD` (0.4) - adjust if needed based on the balance of relevant vs. irrelevant results.
*   Consider removing or reducing diagnostic logging once functionality is confirmed.

---

## Analysis of Test Run 2 (`test-2-results.csv`) (April 12, 2025)

After applying the fixes above (Commit `656dd98`), a second test run (`test-2-results.csv`) revealed the following:

1.  **New FTS Query Failure:**
    *   **Issue:** While the previous `PGRST100` syntax error was resolved, FTS queries are now consistently failing with a new PostgreSQL error: `code: '42809', message: 'WITHIN GROUP is required for ordered-set aggregate rank'`. This is visible in the Netlify logs for all tests involving a query component (Q1-Q4, C1).
    *   **Cause:** This error suggests an incompatibility between how `supabase-js` handles the `.order('rank', { ascending: false })` method after `.textSearch()` and how PostgreSQL expects ordered-set aggregate functions (like `rank`) to be used.
    *   **Status:** **Blocker.** Prevents FTS from returning any results.

2.  **Vector Search Still Inconsistent:**
    *   **Issue:** Despite lowering `VECTOR_MATCH_THRESHOLD` to `0.4`, vector search still returned 0 raw results for test queries Q1-Q4 according to the new diagnostic logs.
    *   **Observation:** Test C1 *did* successfully return 1 raw result via vector search, confirming the threshold isn't universally too high but might be for Q1-Q4 specifically.
    *   **Status:** Needs further investigation *after* the FTS blocker is resolved.

**Revised Plan (April 12, 2025):**

1.  **Fix FTS `42809` Error:** Prioritize resolving the `WITHIN GROUP` error. This likely requires finding an alternative way to order by FTS relevance using `supabase-js` or adjusting the query structure.
2.  **Re-test:** Run tests again after fixing FTS.
3.  **Re-evaluate Vector Search:** If queries (especially Q1-Q4) still fail to retrieve relevant information via vector or the fixed FTS, investigate the vector search threshold and filtering further.

---

## FTS Error (`42809`) Diagnosis & Confirmed Plan (April 12, 2025)

Further investigation and online searches confirmed the following regarding the FTS `42809 WITHIN GROUP` error:

*   **Online Findings:**
    *   Using `.order('rank', { ascending: false })` directly after `.textSearch()` in `supabase-js` to sort by FTS relevance is known to be problematic (Ref: GitHub Discussion #14959). It appears the client library does not correctly translate this specific chain into SQL that PostgreSQL accepts for ordered-set aggregates like rank.
    *   No straightforward client-side modification to the `.textSearch().order()` chain was identified to resolve the `42809` error.
*   **Diagnosis:** The error stems from an incompatibility between the `supabase-js` client library's handling of `.order('rank', ...)` after `.textSearch()` and PostgreSQL's requirements for ordering by relevance rank in this manner.

*   **Confirmed Plan (To be implemented in next session):**
    1.  **Confirmed Plan (Implemented April 12, 2025 - Testing Pending):**
        *   **Confirmed Plan (Implemented April 12, 2025 - Testing Pending):**
        1.  **[x] Create PostgreSQL RPC Function:**
            *   Defined a new function in `sql/schema.sql` (e.g., `fts_search_files`).
            *   This function will accept parameters: `query_string TEXT`, `match_count INTEGER`.
        2.  **Update `memory-action.ts`:**
            *   Modify the `executeFtsSearch` function.
            *   Replace the current `.from('files').select().textSearch().order().limit()` chain with a call to the new RPC function: `supabase.rpc('fts_search_files', { query_string: ftsQueryString, match_count: FALLBACK_MATCH_COUNT })`.
        3.  **Update this Document:** Reflect the implementation details (e.g., function name, commit hash) once completed.
        4.  **Update this Document:** Reflected the implementation details.
        5.  **Re-test:** Execute tests (`test-2-results.csv` or a new set) to validate the FTS fix.
        6.  **Re-evaluate Vector Search:** Based on test results, address the vector search inconsistencies (threshold, filtering) if they persist.

**Implementation Notes (April 12, 2025):**
*   The `fts_search_files` function was added to `sql/schema.sql`.
*   The `executeFtsSearch` function within `netlify/functions/memory-action/memory-action.ts` was updated to call `supabase.rpc('fts_search_files', ...)`.
*   The SQL for `fts_search_files` was successfully executed on the Supabase database. 

--- 

## Planned Refactoring (Post-FTS Fix Validation) 

**Objective:** Improve code maintainability in `netlify/functions/memory-action/memory-action.ts` by adhering to DRY principles. 

1.  **Consolidate Search Result Mapping:** 
    *   **Plan:** Create a new helper function (e.g., `mapRawResultToContextObject`) that takes a raw result object (either `SearchResultItem` from vector search or `FallbackResultItem` from FTS) and the source (`'vector'` or `'fts'`) as input. 
    *   This function will contain the common logic for converting the raw result into the standard `ContextObject` structure (mapping fields, handling timestamps, calling `mapDbMetadataToProcessedEntities`, setting defaults, etc.). 
    *   Modify `executeVectorSearch` and `executeFtsSearch` to call this new helper function within their `.map()` operations instead of duplicating the mapping logic. 
    *   **Rationale:** Reduces code duplication, makes the `ContextObject` creation logic consistent and easier to update in one place. 
    *   **Status:** **Planned.** To be implemented after confirming the FTS fix via testing. 