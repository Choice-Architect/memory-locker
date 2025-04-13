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

**Core Principles (Query Enhancement - v1.8 - Revised Post-v1.8 "Upstream Splitting")**

*   **GPT-Handled Intent Splitting:** The Custom GPT is instructed to recognize combined intents (store + query) and make separate, sequential `store` and `query` calls. The `combined` mode is removed from the action schema and middleware.
*   **Hybrid Initial Retrieval:** Leverages both vector (semantic) search (`executeVectorSearch`) and FTS (keyword) search (`executeFtsSearch`) concurrently using `Promise.allSettled`.
*   **Broad Database Retrieval:** The underlying SQL functions (`search_memory_chunks`, `fts_search_files`) are simplified to retrieve results based *only* on the core search mechanism (vector similarity threshold or FTS text match against the full query text). Metadata filters are removed from the initial database query.
*   **Reciprocal Rank Fusion (RRF):** Uses RRF (`applyRRF` function with `k = 60`) to effectively combine the ranked lists from vector and FTS searches.
*   **Weighted Re-ranking for Augmentation:** Applies refined re-ranking logic (`rerankResults`) to the RRF-fused list. Metadata is used *here* to augment relevance. Boosts for `people`, `locations`, `topics` are applied based on **stemmed** overlap. Date boosts use granular component matching.
*   **Simplified Query Source Reporting:** Reports `query_source` as `'hybrid'`, `'none'`, or `'error'`.

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

## Query Enhancements (Phase 5 / v1.8 & Post-v1.8 Revisions "Upstream Splitting") - Revised

Building upon the completed v1.7.1 date handling, the query retrieval process was fundamentally revised based on testing and a strategic shift:

**Goal:** Improve relevance and simplify logic by having the GPT handle combined intents (making separate store/query calls), removing the `combined` mode, broadening database retrieval, and using metadata purely for augmentation during middleware re-ranking.

**Implementation Steps (`memory-action.ts`, `sql/schema.sql`, `gpt_instructions.md`, `openapi.json`) - Revised**

1.  **[x] Update GPT Instructions (`gpt_instructions.md` - Revision):**
    *   Removed references to `combined` mode.
    *   Added logic for GPT to detect dual intent and make sequential `store` then `query` calls.

2.  **[x] Update OpenAPI Schema (`openapi.json` - Revision):**
    *   Removed `"combined"` from the `mode` enum in `RequestPayload`.

3.  **[x] Simplify SQL Retrieval Functions (`sql/schema.sql` - Revision):**
    *   Modified `search_memory_chunks` to remove all metadata filter parameters/logic.
    *   Modified `fts_search_files` to remove internal filters and rely only on `websearch_to_tsquery` match.

4.  **[x] Update Function Calls (`memory-action.ts` - Revision):**
    *   Call to `search_memory_chunks` simplified.
    *   Call to `fts_search_files` modified to pass `payload.query_text`.

5.  **[x] Implement Concurrent Search (`memory-action.ts`):** (No change in core execution)
    *   Executes simplified `executeVectorSearch` and `executeFtsSearch` concurrently.

6.  **[x] Implement RRF Function (`memory-action.ts`):** (No change in function logic)
    *   `applyRRF` combines results based on `file_id`.

7.  **[x] Integrate RRF (`memory-action.ts`):** (No change in integration logic)
    *   Called after concurrent searches resolve.

8.  **[x] Refine `rerankResults` with Stemming & Weighting (`memory-action.ts` - Revision):**
    *   Implemented **stemming** for people/locations/topics comparison.
    *   Boosts applied based on stemmed overlap and date component matching using `ENTITY_WEIGHTS`.

9.  **[x] Remove `combined` Mode Logic (`memory-action.ts` - Revision):**
    *   Removed conditional handling for the obsolete `combined` mode.

10. **[x] Implement Enhanced Logging (`memory-action.ts`):** (Status: **Completed**)
    *   Detailed logging for debugging and tuning added.

11. **[ ] Evaluation and Tuning:** (Status: **Pending / Next Step - Requires Testing Data**)
    *   Constants (`ENTITY_WEIGHTS`, `RRF_K`, `VECTOR_MATCH_THRESHOLD`, `_MATCH_COUNT`) require tuning.

**Rationale (Revised "Upstream Splitting"):** This approach simplifies the action's responsibility by delegating intent splitting to the GPT. It ensures broad initial data retrieval and uses metadata appropriately for augmentation during re-ranking in the middleware, leading to a cleaner, more robust, and potentially more accurate system.

---

**Overall Status:** **v1.8 Enhancements Implemented.** Core logic, stemming, and enhanced logging are complete. Ready for testing and tuning.

---

### Post-v1.8 Considerations / Known Issues

*   **Full File Retrieval Limitation:** As implemented, the context returned to the GPT is limited by chunk size (vector) or truncation (FTS, currently 3000 chars). For queries requesting large original documents (like long emails), the full text cannot be retrieved. A future enhancement could add a specific mode or mechanism to retrieve the full `transcript_text` from the `files` table when needed.
*   **Tuning:** Constants (`RRF_K`, `ENTITY_WEIGHTS`, `VECTOR_MATCH_THRESHOLD`, `_MATCH_COUNT`) require evaluation and tuning, facilitated by enhanced logging.