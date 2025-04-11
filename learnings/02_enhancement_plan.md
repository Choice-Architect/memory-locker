# Memory Locker: Enhancement Implementation Plan v1.3 - Query Mode Re-ranking

**Version:** 1.3 (Revised)

**Goal:** Implement the revised query and relevance enhancement strategy (v1.3) within the `memory-action.ts` Netlify function. This involves simplifying the fallback mechanism and implementing application-layer relevance re-ranking that incorporates FTS rank scores, vector similarity scores, and dynamic date range boosting.

**Summary of Approach:**
The query logic will follow this sequence:
1.  **Primary Retrieval:** Attempt Vector Search using the `search_memory_chunks` RPC, retrieving `VECTOR_MATCH_COUNT` candidates. Assume the RPC returns a `similarity` score.
2.  **Fallback Retrieval:** If Vector Search yields no results or fails, perform an FTS query against the `files` table using relevant query entities (excluding language), retrieving `FALLBACK_MATCH_COUNT` candidates. Ensure the query selects the `ts_rank_cd` score aliased as `rank`.
3.  **Mapping & Truncation:** Map results from Step 1 or 2 to `ContextObject`s.
    *   For FTS results, truncate the `transcript_text` to 3000 characters when placing it in the `chunk` field.
    *   Ensure `similarity` (from vector) and `rank` (from FTS) scores are preserved during mapping (e.g., by adding optional fields to `ContextObject`).
4.  **Re-ranking:** Take the candidates retrieved and mapped from Step 1 or 2, calculate a `final_score` based on the initial score (`similarity` or `rank`) plus a `metadata_boost_score` (additive score based on metadata overlap and date range matching, excluding language), sort by `final_score`, and return the top `FINAL_MATCH_COUNT` results.

---

## Implementation Steps (`memory-action.ts`)

The following steps detail the required modifications within the `netlify/functions/memory-action/memory-action.ts` file.

**0. Prerequisite: Confirm Supabase Setup:**
    *   Before modifying the TypeScript code, confirm the following in your Supabase project:
        *   The `search_memory_chunks` RPC function returns the `similarity` score alongside other chunk data.
        *   The `files` table allows selecting `ts_rank_cd(...)` aliased as `rank` in FTS queries.
        *   Verify that appropriate GIN indexes exist on `files.file_metadata` and `transcript_embeddings.metadata` covering relevant date component paths (e.g., `dates[*].year`, `dates[*].month`, `dates[*].day`, `dates[*].week_number`) for efficient querying.
    *   *(Modify Supabase SQL if necessary, outside the scope of this specific TypeScript plan)*

**1. Update Retrieval Constants:**
    *   Adjust constants controlling the number of results fetched and returned:
        ```typescript
        const VECTOR_MATCH_COUNT = 15;
        const FALLBACK_MATCH_COUNT = 20;
        const FINAL_MATCH_COUNT = 5;
        ```

**2. Update TypeScript Interfaces:**
    *   Add `similarity?: number;` to `SearchResultItem`.
    *   Add `rank?: number;` to `FallbackResultItem`.
    *   Add `similarity?: number;` and `rank?: number;` to `ContextObject`.
    *   Define the `ScoredContextObject` interface extending `ContextObject` with `initial_score`, `metadata_boost_score`, and `final_score`.
    *   **(Date Parsing Related):** Ensure the `EnhancedNormalizedDate` interface includes `week_number?: number;` (required for relative week logic). Optionally, consider removing the `normalized?: string | null;` field if it's confirmed to be unused downstream, per the revised strategy.

**3. Modify FTS Query Logic (`query`/`combined` modes):**
    *   Ensure the FTS fallback query (`ftsQueryBuilder`):
        *   Constructs the `ftsQueryString` using entity values from `queryMetadata` *excluding* the `language` entity.
        *   Selects the FTS rank: `.select('..., rank:ts_rank_cd(transcript_tsv, to_tsquery(\'english\', $1))')`.
        *   Does **not** include pre-filtering based on `deriveDateRange`.
        *   Uses `{ config: 'english' }` in `.textSearch`.

**4. Modify Result Mapping Logic:**
    *   **Vector Search Mapping:**
        *   When mapping `SearchResultItem` to `ContextObject`, include `similarity: result.similarity`.
    *   **FTS Fallback Mapping:**
        *   When mapping `FallbackResultItem` to `ContextObject`:
            *   Include `rank: file.rank`.
            *   Truncate the chunk: `chunk: file.transcript_text.substring(0, 3000) + (file.transcript_text.length > 3000 ? '...' : '')`.

**5. Implement/Enhance Helper Functions:**
    *   Ensure `checkOverlap(arr1?: any[], arr2?: any[]): boolean` is present and handles case-insensitivity for strings.

*Note: Date metadata boosting during re-ranking (Step 6c) relies on the accuracy of the date components stored. Implementing the revised date parsing strategy below is crucial for its effectiveness.*

**6. Enhance `rerankResults` Function:**
    *   **Signature:** Remains the same.
    *   **Internal Logic:**
        *   **a. Map to Scored Objects:** Iterate through `candidates` (`ContextObject[]`) and map each to a `ScoredContextObject`.
        *   **b. Calculate `initial_score`:**
            *   If `query_source === 'vector_store'`, use `initial_score = candidate.similarity ?? 0;`.
            *   If `query_source === 'postgres_fallback_text'`, use `initial_score = candidate.rank ?? 0;`.
        *   **c. Calculate `metadata_boost_score`:**
            *   Initialize `metadata_boost_score = 0.0`.
            *   Apply additive boosts (`+= 0.05`) for overlaps: `people`, `locations`, `topics`, `type`, `sentiment`.
            *   **Apply Hierarchical Date Matching Boost:** Iterate through `queryMetadata.dates`. For each query date, check for matches in `candidate.entities_in_chunk.dates` at the Day (+0.05), Month (+0.03), or Year (+0.01) level, adding the highest match found.
            *   **Apply Date Range Boost (FTS Only - Revised Logic):** If `query_source === 'postgres_fallback_text'`:
                *   Iterate through `queryMetadata.dates`.
                *   For each query date with specific `year`, `month`, and `day` components:
                    *   Create a `Date` object representing that specific day.
                    *   Check if this date is in the past using `date-fns.isPast()`.
                    *   If it is a valid past date, determine the `startOfDay` and `endOfDay` for this date.
                    *   Parse the `candidate.timestamp` to a `Date` object.
                    *   Check if the candidate's timestamp falls within the `startOfDay` / `endOfDay` range.
                    *   If it falls within the range, add `+= 0.10` to `metadata_boost_score` and break the inner loop (boost applied once per candidate).
            *   **Note:** Explicitly *do not* add a boost based on `language` overlap.
        *   **d. Calculate `final_score`:** `final_score = Math.min(1.0, initial_score + metadata_boost_score)`.
        *   **e. Populate Scored Object:** Store calculated scores.
        *   **f. Sort:** Sort `ScoredContextObject` array by `final_score` (descending).
        *   **g. Trim:** Slice array to `FINAL_MATCH_COUNT`.
        *   **h. Map Back:** Map back to `ContextObject[]`, omitting score fields.
        *   **i. Return:** Return final `ContextObject[]`.

**7. Integrate `rerankResults` Call:**
    *   Ensure `rerankResults` is called after `retrieved_context` is populated and before the `SuccessResponse` is constructed. Assign the result back to `retrieved_context`.

**8. Remove Date Parsing Notes Logic:**
    *   Delete the code block that calculates `dateParseNotes` and appends them to `message_for_gpt`.

---

# Enhancement Implementation Plan v1.5: Store Mode Date Parsing Refactor (Pattern-Driven)

**Version:** 1.5 (Supersedes v1.4)

**Prerequisite Assumption:** The controlling GPT (`gpt_instructions.md`) translates user input (`query_text`) to English before sending it to `memory-action`. The `memory-action` function only needs to handle English date expressions.

**Goal:** Refactor the `parseDateStringToEnhanced` function within `memory-action.ts` to reliably extract date/time **components** (`year`, `month`, `day`, `day_of_week`, `week_number`, `period`, `time_hour`, etc.) by using a pattern-driven approach, prioritizing `date-fns` for calculations over interpreting `chrono-node`'s internal state.

**Rationale:** Address the regressions and failures identified in v1.4 testing (`learnings/05_test_observations_v1.4.md`). This approach focuses directly on extracting the required components for metadata and querying, removing the complexity and potential inaccuracies of the previous method and the need for a `normalized` ISO string output.

---

## Implementation Steps (`memory-action.ts` - Refactoring `parseDateStringToEnhanced`)

The following steps detail the required refactoring within the `parseDateStringToEnhanced` function:

**1. Qualifier Stripping (Keep & Verify):**
    *   **Action:** Maintain the logic to strip defined qualifiers (e.g., "early", "late", "EOD", "first week of", "last two weeks of", "around", "before", "after") from the input `dateString`. Ensure the list of qualifiers is accurate and the stripping mechanism is robust.
    *   **Purpose:** Obtain a `cleanedDateString` containing the core date phrase.

**2. Date Phrase Identification (Leverage Chrono):**
    *   **Action:** Run `chrono.parse(cleanedDateString, referenceDate, { forwardDate: true })`.
    *   **Purpose:** Primarily use the result (`parsedResult`) to extract the `parsedResult.text` – the actual substring Chrono identified as the date/time phrase (e.g., "next Friday", "August 2025", "11 PM").
    *   **Note:** Avoid relying on `parsedResult.start.get(...)` components or certainty flags to drive the main logic flow.

**3. Implement Pattern Matching & Component Calculation (New Core Logic):**
    *   **Action:** Replace the existing complex post-chrono logic block with a new structure based on pattern matching of `parsedResult.text` (or the `originalString` for boundary cases). Use `date-fns` for reliable calculations.
    *   Initialize an empty `result: EnhancedNormalizedDate = { original: originalString }`.
    *   Use `if/else if` blocks with regex or string checks:
        *   **Pattern: Specific Full Dates** (e.g., "April 10, 2025", "2025-04-10", "10 Apr 2025", "Friday 15th"):
            *   Action: Use `date-fns.parse` (with appropriate format strings) or identify components. Prioritize these specific patterns over simpler ones.
            *   Components: `year`, `month`, `day`, `day_of_week`.
        *   **Pattern: Month/Day Only** (e.g., "April 10", "10th April"):
            *   Action: Identify components, use `referenceDate` for `year`. **Verify Past Date Logic:** Ensure recent past dates (e.g., "April 8th" when ref is Apr 11th) use `referenceDate` year, not `year + 1`.
            *   Components: `year`, `month`, `day`, `day_of_week`.
        *   **Pattern: Specific Relative Days** (`tomorrow`, `yesterday`, `today`):
            *   Action: Use `addDays(ref, 1)`, `subDays(ref, 1)`, `ref`.
            *   Components: `year`, `month`, `day`, `day_of_week`.
        *   **Pattern: Relative Weekdays** (`/(next|last)\s+(monday|tuesday...)/i`, standalone weekdays e.g., "on Wednesday"):
            *   Action: Use `nextFriday(ref)`, `lastTuesday(ref)`, etc. For standalone weekdays, assume *next* instance (document this assumption).
            *   Components: `year`, `month`, `day`, `day_of_week`.
        *   **Pattern: Relative Weeks** (`/(last|next|this)\s+week/i`):
            *   Action: Use `subWeeks`, `addWeeks`, `getWeek`, `startOfWeek`.
            *   Components: `year`, `month`, `week_number`.
        *   **Pattern: Relative Months** (`/(last|next|this)\s+month/i` or standalone month name):
            *   Action: Use `subMonths`, `addMonths`, `setMonth`.
            *   Components: `year`, `month`.
        *   **Pattern: Relative Years** (`/(last|next|this)\s+year/i` or standalone year e.g., "2026"):
            *   Action: Use `subYears`, `addYears`, `parseInt`.
            *   Components: `year`. Set `month = undefined`, `day = undefined`.
        *   **Pattern: Day Boundary Terms (check `originalString`)** (`end of day`, `tonight`, `this morning`, `evening`, `afternoon`, `EOD`, `COB`):
            *   Action: Check `originalString`. If found *without* a specific date pattern, force Y/M/D from `referenceDate` & set `period`. If found *with* a specific date pattern (e.g., "EOD Friday"), prioritize the specific date's Y/M/D, and use the boundary term only to set the `period`.
            *   Components: `year`, `month`, `day`, `period`.
        *   **Pattern: Specific Times** (e.g., "3 PM", "15:00", "10:30:15", "noon", "midnight"):
            *   Action: Parse using regex or time parsing logic.
            *   Components: `time_hour`, `time_minute`, `time_second`, `period`. (Combine with date components if date pattern also matched).
        *   **(Add other common patterns like "in 2 days", "3 weeks ago" if desired)**
    *   **Failure Case:** If Chrono fails to parse (`chronoResults.length === 0`) or no pattern matches, the `result` object will only contain the `original` string (and potentially a `note`).

**4. Remove `normalized` String Logic:**
    *   **Action:** Delete the entire code block that previously checked for component completeness and attempted to format/set the `normalized` ISO string property.

**5. Update `EnhancedNormalizedDate` Interface (Optional but Recommended):**
    *   **Action:** Remove the `normalized?: string | null;` field from the interface definition as it's no longer being generated or used.
    *   **Verify:** Ensure `week_number?: number;` is present.

**6. Update Testing:**
    *   **Action:** Revise unit tests and manual test cases (`04_test_results_v1.4_raw.csv`, `05_test_observations_v1.4.md`) to focus solely on the presence and accuracy of the **component** fields (`year`, `month`, `day`, `week_number`, `period`, etc.) based on the expected outcome for each input pattern. Ignore the `normalized` field.

**7. Update Dependent Files (`openapi.json`, `gpt_instructions.md`):**
    *   **`openapi.json`:** Ensure the `EnhancedNormalizedDate` schema definition reflects the interface changes (removal of `normalized`, presence of `week_number`).
    *   **`gpt_instructions.md`:** No changes likely needed, as it instructs extraction based on user input, not specific internal formats.

**8. Update Project Roadmap & Task List (`learnings/01_project_roadmap.md`):**
    *   Update Phase 5, Item 4 to reflect this **new v1.5 refactoring approach**, superseding the previous v1.4 plan.

**Impact Statement:**
*   Implementing this refactor will create a more robust, maintainable, and accurate date component extraction system aligned with the primary goal of populating metadata fields. It eliminates problematic dependencies on `chrono-node`'s internal state and removes unused `normalized` string logic.

---

**Status:** **Obsolete.** This v1.5 plan was implemented but found to have parsing failures (see `learnings/06_date_parsing_analysis_v1.5.md`). It was superseded by the v1.6 enhancements.

---

# Enhancement Implementation Plan v1.6: Store Mode Date Parsing Fixes & Filtering

**Version:** 1.6

**Goal:** Address the date parsing failures identified in v1.5 testing by enhancing the pattern-matching logic in `parseDateStringToEnhanced` and implementing filtering to discard results where parsing completely fails.

**Rationale:** Improve date component extraction reliability for key patterns (full dates, relative+period, relative month/year, boundaries) and ensure only successfully (fully or partially) parsed date information is stored in metadata.

## Implementation Steps (`memory-action.ts`)

1.  **Add `date-fns` Imports:** Include `endOfWeek`, `startOfMonth`, `endOfMonth`, `startOfYear`, `endOfYear`, `subMonths`, `addMonths`, `subYears`, `addYears`, `setMonth`.
2.  **Enhance `parseDateStringToEnhanced` Pattern Matching:**
    *   Prioritize matching specific full date formats using `dateFnsParse` and a list of common format strings.
    *   Implement logic to handle combined relative dates/weekdays and periods (e.g., identify "next Tuesday", then check for "morning" and set `period`).
    *   Add regex and `date-fns` logic for relative months/years (`next month`, `last year`).
    *   Add regex and `date-fns` logic for boundary phrases (`start of next week`, `end of last month`).
    *   Add logic for standalone months and years.
    *   Refine the order of `if/else if` checks (specific before general).
3.  **Implement Filtering Logic (within main handler):**
    *   After calling `parseDateStringToEnhanced` for each date string in the input:
    *   Check if the returned `EnhancedNormalizedDate` object has a `note` field starting with "Failed".
    *   If it does, log a warning and **discard** this object (do not add to `processedMetadata.dates`).
    *   Otherwise, add the successfully parsed (or partially parsed) object to `processedMetadata.dates`.

**Impact Statement:**
*   This addresses the known parsing gaps from v1.5, making date extraction significantly more robust. Filtering ensures cleaner metadata by removing entries that only contain the original unparsed string.

---

**Status:** **Implemented.** This v1.6 plan addresses the shortcomings of v1.5.