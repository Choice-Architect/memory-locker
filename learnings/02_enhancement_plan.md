# Memory Locker: Implementation Plan v1.8 - Hybrid Date Parsing & Query Enhancements

**Version:** 1.8 (Reflects implemented state including Phase 5 Query Enhancements)

**Goal:** Implement a hybrid date parsing strategy (v1.7.1) and enhance query retrieval with concurrent vector/FTS search, Reciprocal Rank Fusion (RRF), and weighted metadata re-ranking (v1.8).

**Core Principles (Date Parsing - v1.7.1 - Completed):**

*   **Leverage Upstream GPT:** Utilize the Custom GPT's ability to normalize common date expressions into a standard `"Month DD, YYYY"` format. For ranges, the GPT provides the normalized *start date*.
*   **Netlify Function Focus (Date Parsing):**
    *   Parses the standardized `"Month DD, YYYY"` format from the GPT using `date-fns` (`parseNormalizedDate`).
    *   Extracts *only the period* information (e.g., "Morning", "Evening") from the *original* user date string using targeted keyword matching (`extractTimeInfo`). **Does NOT store specific hours/minutes/seconds.**
    *   Handles cases where the GPT *cannot* normalize the date via a dedicated `parseOriginalStringDate` function, using only `date-fns` for date parsing.
    *   Stores only structured components (year, month, day, day_of_week, week_number, period) in metadata (no `original` string).
*   **Query Relevance (Date Parsing):** Ensure the stored date components support effective querying and re-ranking.

**Core Principles (Query Enhancement - v1.8 - Completed):**

*   **Hybrid Initial Retrieval:** Leverages both vector (semantic) search (`executeVectorSearch`) and FTS (keyword) search (`executeFtsSearch`) concurrently using `Promise.allSettled` to generate a richer set of initial candidates.
*   **Reciprocal Rank Fusion (RRF):** Uses RRF (`applyRRF` function with `k = 60`) to effectively combine the ranked lists from vector and FTS searches into a single, improved candidate list based on `file_id`.
*   **Weighted Re-ranking:** Applies refined re-ranking logic (`rerankResults`) to the RRF-fused list. The final score is calculated as `Math.min(1.0, initial_score + metadata_boost_score)` where:
    *   `initial_score` is the min-max normalized RRF score (0-1).
    *   `metadata_boost_score` is the sum of granular, additive weights (`ENTITY_WEIGHTS` constant) for matching entity types (people, locations, topics, type, sentiment, hierarchical date components, period, FTS date range) between the query and candidate.
*   **Simplified Query Source Reporting:** Reports `query_source` as `'hybrid'` if results are found from either search, `'none'` if no results, or `'error'` if issues occurred.

---

## Implementation Steps (General - Date Parsing v1.7.1) - Completed

1.  **[x] Update Custom GPT Instructions (`learnings/02_gpt_instructions.md`):**
    *   Instructed the GPT to provide `{"original": "...", "normalized": "Month DD, YYYY"}` when possible, otherwise just the original string.

2.  **[x] Update OpenAPI Schema (`openapi.json`):**
    *   Modified `ExtractedEntities.dates` input schema to accept `string | {original: string, normalized?: string}`.
    *   Modified the `EnhancedNormalizedDate` response/storage schema to include only `year`, `month`, `day`, `day_of_week`, `week_number`, and `period`. **Removed `time_hour`, `time_minute`, `time_second`**. Removed `original` and `note` fields.

---

## Implementation Steps (`memory-action.ts` - Date Parsing v1.7.1) - Completed

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
    *   *(Note: This verification applies to the state before the Phase 5 RRF/weighting enhancements were implemented in v1.8)*.

**5. [x] Constants & Cleanup:**
    *   Obsolete constants, comments, and functions related to previous date/time parsing attempts were removed.

---

**Impact Statement (v1.7.1 - Date Parsing):**

*   The v1.7 hybrid date parsing approach was successfully implemented and refined.
*   Primary date normalization relies on upstream GPT for common cases.
*   Netlify function reliably parses `"Month DD, YYYY"` dates (`parseNormalizedDate`) and attempts simple original string date parsing (`parseOriginalStringDate`).
*   **Time processing was simplified to only extract and store the `period` (`extractTimeInfo`), improving reliability by removing error-prone hour/minute parsing.**
*   Maintains necessary structured components (`year`, `month`, `day`, `period`) for the query re-ranking mechanism.
*   Accepts the limitation that ambiguous date strings not normalized by GPT may not yield stored date components.

---

## Query Enhancements (Phase 5 / v1.8) - Completed

Building upon the completed v1.7.1 date handling, the query retrieval and ranking logic was enhanced as follows:

**Goal:** Improve the relevance and accuracy of `query`/`combined` mode retrieval by implementing a true hybrid search strategy combined with weighted re-ranking based on metadata.

**Implementation Steps (`memory-action.ts` - Query Enhancement v1.8) - Completed**

1.  **[x] Implement Concurrent Search:**
    *   Modified `memory-action.ts` to execute vector search (`executeVectorSearch`) and FTS search (`executeFtsSearch` on `files` table) concurrently using `Promise.allSettled()`.
    *   Error handling allows one search to fail while the other potentially succeeds.
    *   Results mapped to `ContextObject` arrays, preserving original scores/ranks and adding `source` ('vector' or 'fts').

2.  **[x] Implement RRF Function:**
    *   Created the `applyRRF(vectorResults, ftsResults, k)` helper function.
    *   Implemented RRF logic using `k = 60`, summing `1 / (k + rank)` for vector and FTS results based on shared `file_id`.
    *   Returns a single list of `ContextObject`s sorted by descending RRF score, with `rrf_score` added.

3.  **[x] Integrate RRF:**
    *   Called `applyRRF` after concurrent searches resolve.
    *   Passed the RRF-ranked list (`rrf_score` included) as `candidates` to the `rerankResults` function.
    *   Updated `query_source` reporting logic to use `'hybrid'`, `'none'`, or `'error'` based on search success and result presence.

4.  **[x] Refine `rerankResults` with Weighting:**
    *   Used the **Normalized RRF Score** (min-max scaled 0-1) as the `initial_score`.
    *   Implemented **granular, additive weighting** for metadata boosts using the `ENTITY_WEIGHTS` constant.
    *   Calculated `metadata_boost_score` by summing weights for matching entity types (people, locations, topics, type, sentiment, date_day/month/year, date_period, fts_date_range).
    *   Calculated `final_score = Math.min(1.0, initial_score + metadata_boost_score)`.
    *   Removed temporary scores (`rrf_score`, `initial_score`, `metadata_boost_score`, `final_score`, `source`) before returning final results.

5.  **[x] Update API Schema & GPT Instructions:**
    *   Modified `openapi.json`: Updated the `enum` for `SuccessResponse.properties.query_source` to only include `'hybrid'`, `'none'`, `'error'`.
    *   Modified `gpt_instructions.md`: Updated the "Handling Action Responses" section to remove specific phrasing for obsolete sources (`vector_store`, `postgres_fallback_text`) and use general phrasing.

6.  **[ ] Evaluation and Tuning:** (Status: **Pending / Future Task**) 
    *   Initial weights in `ENTITY_WEIGHTS` and `RRF_K=60` are set.
    *   Future work involves defining benchmarks and iteratively tuning these constants based on evaluation.

**Rationale:** This approach combines the strengths of both search methods early via RRF, providing a better candidate list for the final, metadata-focused re-ranking step. Using the Normalized RRF score as the basis leverages combined confidence. Granular, additive weights provide direct control over entity importance, aligning with the journaling use case. Simplified `query_source` reporting matches the unified hybrid retrieval logic.

---

**Overall Status:** **v1.8 Enhancements Complete.** Date parsing (v1.7.1) and Query Enhancement (v1.8 - RRF + Weighted Re-ranking) logic implemented. Ready for testing and potential tuning.

---

### Post-v1.8 Considerations / Known Issues

*   **Full File Retrieval Limitation:** As implemented, the context returned to the GPT is limited by chunk size (vector) or truncation (FTS, currently 3000 chars). For queries requesting large original documents (like long emails), the full text cannot be retrieved. A future enhancement could add a specific mode or mechanism to retrieve the full `transcript_text` from the `files` table when needed.
*   **Tuning:** The `RRF_K` and `ENTITY_WEIGHTS` values require evaluation and tuning.