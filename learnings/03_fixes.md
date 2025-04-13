# Memory Locker: Fix Log & Current Plan (Post v1.8.0)

## Background Summary

Initial attempts to fix query retrieval issues after v1.8.0 focused on resolving SQL errors in the Full-Text Search (FTS) implementation. Syntax errors (`PGRST100`) and PostgreSQL logical errors (`42809 WITHIN GROUP`) were addressed by refactoring the FTS query to use a dedicated RPC function (`fts_search_files`).

However, subsequent testing (`test-3-results.csv`) revealed that while the RPC executed without error, it consistently returned zero results. Concurrently, vector search performance remained unreliable, and specific issues were identified:

*   **Overly Strict Filtering:** Metadata fields used as filters in the initial SQL queries prevented relevant results from being returned due to slight mismatches.
*   **Combined Mode Pollution:** The `combined` mode query logic was incorrectly using entities from the entire input, contaminating the search filters.

Further analysis led to a fundamental shift in strategy: instead of using metadata for strict initial filtering, the database retrieval (Vector & FTS) should be broad, based only on core similarity/text match. Metadata should be used *exclusively* within the middleware's re-ranking step to augment relevance, using techniques like stemming.

Additionally, the handling of combined user intents (store + query) was identified as a source of complexity and potential error in the middleware. The ideal solution is to delegate this intent splitting to the upstream Custom GPT, instructing it to make separate, sequential `store` and `query` calls.

This understanding directly informs the current plan, which aims to simplify database retrieval, remove the `combined` mode from the middleware, enhance the middleware's re-ranking capabilities, and update the GPT's instructions for intent handling.

---

## Final Plan (April 13, 2025 - Agreed "Upstream Splitting")

Based on Test Run 3 analysis and discussion, the following plan focuses on instructing the GPT to handle combined intents via sequential calls, removing the `combined` mode from the middleware, simplifying database retrieval, and using metadata purely for augmenting relevance during re-ranking:

1.  **Update GPT Instructions (`gpt_instructions.md`):**
    *   **Action:** Remove `combined` mode. Instruct GPT to recognize dual intent and make sequential `store` then `query` calls. Update examples.

2.  **Update OpenAPI Schema (`openapi.json`):**
    *   **Action:** Remove `"combined"` from the `mode` enum in `RequestPayload`.

3.  **Simplify `search_memory_chunks` SQL Function (`sql/schema.sql`):**
    *   **Action:** Remove **all** metadata filter parameters and `AND` clauses. `WHERE` clause only checks vector similarity.
    *   **Action:** Deploy change to Supabase.

4.  **Simplify `fts_search_files` SQL Function (`sql/schema.sql`):**
    *   **Action:** Ensure `WHERE` clause **only** contains the FTS match condition. Remove other internal filters.
    *   **Action:** Deploy change to Supabase.

5.  **Update `executeVectorSearch` (`memory-action.ts`):**
    *   **Action:** Remove arguments corresponding to the removed metadata filter parameters in the RPC call.

6.  **Update `executeFtsSearch` (`memory-action.ts`):**
    *   **Action:** Pass the **original user query text** (`payload.query_text`) as the `query_string` argument in the RPC call.

7.  **Enhance Re-ranking (`rerankResults` in `memory-action.ts`):**
    *   **Action:** Implement stemming for `people`, `locations`, `topics` before checking overlaps.
    *   **Action:** Apply boosts based on **stemmed** overlap using `ENTITY_WEIGHTS`.
    *   **Action:** Keep granular date component matching logic.

8.  **Remove `combined` Mode Logic (`memory-action.ts`):**
    *   **Action:** Delete conditional logic specifically handling `payload.mode === 'combined'`.

9.  **Implement Enhanced Logging (`memory-action.ts`):**
    *   **Action:** Add detailed logging for debugging/tuning (metadata used, raw counts, RRF scores, stemmed entities, boosts, final scores).

10. **Re-evaluate Counts & Thresholds:**
    *   **Action:** Keep initial values. Tune after testing the new logic based on performance and result quality.

11. **Update Documentation:**
    *   **Action:** Ensure all learning files (`01`, `02`, `03`, `04`) reflect this final plan. (Completed in this session). 