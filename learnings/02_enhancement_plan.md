# Memory Locker: Implementation Plan v1.7.1 - Hybrid Date Parsing (Period Only)

**Version:** 1.7.1 (Reflects implemented state as of audit)

**Goal:** Implement a hybrid date parsing strategy in `store` mode leveraging upstream GPT normalization and targeted Netlify function logic. Maintain and refine the application-layer re-ranking in `query`/`combined` modes based on the reliably extracted date components. **Time component extraction was simplified to only store the `period` ('Morning', 'Afternoon', etc.).**

**Core Principles:**

*   **Leverage Upstream GPT:** Utilize the Custom GPT's ability to normalize common date expressions into a standard `"Month DD, YYYY"` format. For ranges, the GPT provides the normalized *start date*.
*   **Netlify Function Focus:** The Netlify function (`memory-action.ts`) focuses on:
    *   Parsing the standardized `"Month DD, YYYY"` format from the GPT using `date-fns` (`parseNormalizedDate`).
    *   Extracting *only the period* information (e.g., "Morning", "Evening") from the *original* user date string using targeted keyword matching (`extractTimeInfo`). **Does NOT store specific hours/minutes/seconds.**
    *   Handling cases where the GPT *cannot* normalize the date via a dedicated `parseOriginalStringDate` function, using only `date-fns` for date parsing.
    *   Storing only structured components (year, month, day, day_of_week, week_number, period) in metadata (no `original` string).
    *   Performing application-layer re-ranking (`rerankResults`) using the stored components.
*   **Query Relevance:** Ensure the stored components support effective date-based querying and the existing re-ranking strategy (hierarchical date match, period match, past date boost).

---

## Implementation Steps (General) - Completed

1.  **[x] Update Custom GPT Instructions (`learnings/02_gpt_instructions.md`):**
    *   Instructed the GPT to provide `{"original": "...", "normalized": "Month DD, YYYY"}` when possible, otherwise just the original string.

2.  **[x] Update OpenAPI Schema (`openapi.json`):**
    *   Modified `ExtractedEntities.dates` input schema to accept `string | {original: string, normalized?: string}`.
    *   Modified the `EnhancedNormalizedDate` response/storage schema to include only `year`, `month`, `day`, `day_of_week`, `week_number`, and `period`. **Removed `time_hour`, `time_minute`, `time_second`**. Removed `original` and `note` fields.

---

## Implementation Steps (`memory-action.ts`) - Completed

**1. [x] Update TypeScript Interfaces:**
    *   Defined `InputDateEntity` type alias.
    *   Refined `EnhancedNormalizedDate` interface to match the simplified OpenAPI schema (only date components + `period`).
    *   Updated `ContextObject` and `ProcessedEntities` to use the refined `EnhancedNormalizedDate`.

**2. [x] Refactor Main Date Processing Logic:**
    *   Iterates through `entities.dates` (`InputDateEntity` items).
    *   Calls `parseNormalizedDate` or `parseOriginalStringDate` to get date components.
    *   **Always** calls the simplified `extractTimeInfo` to get only the `period`.
    *   Combines date components and `period`.
    *   Stores combined components if core date info OR just `period` is present.
    *   Updated validation check to reflect removal of specific time components.

**3. [x] Implement/Refactor Helper Functions:**
    *   **`parseNormalizedDate`:** Implemented using `date-fns` to parse "Month DD, YYYY". Returns date components.
    *   **`extractTimeInfo`:** **Simplified** to use keyword/regex matching on the original string ONLY to find and return the `period` ('Morning', 'Afternoon', 'Evening', 'Night'). **Does not parse or return hour/minute/second.**
    *   **`parseOriginalStringDate`:** Implemented using ONLY `date-fns` to attempt parsing common formats from the original string when GPT provides no normalization. Returns date components.

**4. [x] `query`/`combined` Mode - Re-ranking (`rerankResults`) Verified (Post v1.7.1 Completion):**
    *   After the v1.7.1 date parsing refactor was complete, the existing `rerankResults` logic correctly used the newly structured stored components (`year`, `month`, `day`, `period`).
    *   Query date strings were also parsed into the same `EnhancedNormalizedDate` structure for comparison within `rerankResults`.
    *   *(Note: This verification applies to the state before the planned Phase 5 RRF/weighting enhancements)*.

**5. [x] Constants & Cleanup:**
    *   Obsolete constants, comments, and functions related to previous date/time parsing attempts were removed.

---

**Impact Statement (v1.7.1):**

*   The v1.7 hybrid approach was successfully implemented and refined.
*   Primary date normalization relies on upstream GPT for common cases.
*   Netlify function reliably parses `"Month DD, YYYY"` dates (`parseNormalizedDate`) and attempts simple original string date parsing (`parseOriginalStringDate`).
*   **Time processing was simplified to only extract and store the `period` (`extractTimeInfo`), improving reliability by removing error-prone hour/minute parsing.**
*   Maintains necessary structured components (`year`, `month`, `day`, `period`) for the query re-ranking mechanism.
*   Accepts the limitation that ambiguous date strings not normalized by GPT may not yield stored date components.

**Overall Status:** **v1.7.1 Enhancement Complete.** The date parsing logic aligns with the refined plan, focusing on reliable date components and period extraction.
**Verification:** Confirmed that both `store` and `query`/`combined` modes utilize the same centralized date processing logic and the consistent `EnhancedNormalizedDate` structure, ensuring alignment between data storage and query-time comparison/re-ranking.

---

## Future Enhancements (Phase 5 - Query Mode) - Proposed Plan

Building upon the completed v1.7.1 date handling enhancements, this section outlines the proposed plan for the next phase of improvements focused on the query retrieval and ranking logic.

**Goal:** Improve the relevance and accuracy of `query`/`combined` mode retrieval by implementing a true hybrid search strategy combined with weighted re-ranking based on metadata.

**Core Principles:**

*   **Hybrid Initial Retrieval:** Leverage both vector (semantic) search and FTS (keyword) search simultaneously to generate a richer set of initial candidates.
*   **Reciprocal Rank Fusion (RRF):** Use RRF to effectively combine the ranked lists from vector and FTS searches into a single, improved candidate list.
*   **Weighted Re-ranking:** Apply the existing custom re-ranking logic (`rerankResults`) to the RRF-fused list, but introduce a multiplier weight to increase the influence of metadata matches (including dates, people, topics, etc.) on the final score.
*   **Iterative Tuning:** Use benchmark queries and evaluation to determine an appropriate value for the metadata weight multiplier.

**Proposed Implementation Steps:**

1.  **[ ] Implement Concurrent Search:**
    *   Modify `memory-action.ts` to execute vector search (`search_memory_chunks`) and FTS search (`files` table) concurrently using `Promise.all()`.
    *   Handle errors gracefully for each search.
    *   Map results from each source into separate `ContextObject` arrays, preserving original scores.

2.  **[ ] Implement RRF Function:**
    *   Create a new `applyRRF(vectorResults, ftsResults, k)` helper function in `memory-action.ts`. *(Note: Decision made to use initial k = 60)*.
    *   Implement the RRF logic: calculate `1 / (k + rank)` for each item in each list and sum scores for common items using a map.
    *   Return a single list of `ContextObject`s sorted by descending RRF score.

3.  **[ ] Integrate RRF:**
    *   Call `applyRRF` after the concurrent searches resolve.
    *   Pass the RRF-ranked list as the `candidates` to the `rerankResults` function.
    *   Update `query_source` reporting logic in the response to use `'hybrid'` source type when applicable.

4.  **[ ] Refine `rerankResults` with Weighting:**
    *   **Decision:** Use the **Normalized RRF Score** as the `initial_score`. Normalize the `rrf_score` values from the candidate list using **min-max scaling** (`(score - min_score) / (max_score - min_score)`) before using them as the base `initial_score` (ranging 0-1).
    *   **Decision:** Implement **granular weighting** for metadata boosts. Define constants for each entity type's contribution to the boost score (using `ENTITY_WEIGHTS = { people: 0.10, locations: 0.10, topics: 0.05, type: 0.05, sentiment: 0.05, date_day: 0.15, date_month: 0.10, date_year: 0.05, date_period: 0.05, fts_date_range: 0.10 }`).
    *   Modify `rerankResults` to calculate `metadata_boost_score` by summing the applicable weights for each matching entity type between the query and the candidate.
    *   Modify the `final_score` calculation to: `final_score = initial_score + metadata_boost_score`. Ensure clamping (`Math.min(1.0, ...)`).

5.  **[ ] Update API Schema & GPT Instructions:**
    *   Modify `openapi.json`: Update the `enum` for `SuccessResponse.properties.query_source` to include `'hybrid'`.
    *   Modify `gpt_instructions.md`: Update the "Handling Action Responses" section to remove phrasing specific to `vector_store` or `postgres_fallback_text`. Instruct the GPT to use general phrasing for the `'hybrid'` source type.

6.  **[ ] Evaluation and Tuning:**
    *   Define a benchmark set of diverse queries and expected results.
    *   Execute benchmarks and evaluate results using appropriate metrics.
    *   Iteratively adjust `METADATA_WEIGHT` based on evaluation outcomes.
    *   Document the final chosen weight and rationale.

**Rationale:** This approach combines the strengths of both search methods early via RRF (using `k=60`), providing a better candidate list for the final, metadata-focused re-ranking step. Using the **Normalized RRF score** as the basis for re-ranking leverages the combined confidence from the hybrid retrieval. Using **granular, additive weights** for metadata matching provides direct control over the importance of specific entity types, aligning better with the journaling use case where specific entity recall is often crucial. Adjusting the `query_source` reporting ensures accurate communication back to the GPT.