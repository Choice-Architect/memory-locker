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
    *   Ensure `deriveDateRange(dates: EnhancedNormalizedDate[]): { startDate: string; endDate: string } | null` is present (it's needed for re-ranking now).

*Note: Subsequent testing (`learnings/03_test_observations.md`, Section A) confirmed that the necessary metadata entities (`people`, `locations`, `topics`, `type`, `sentiment`) are reliably extracted during the `store` process, validating the prerequisite for the metadata boosting described below. The testing also confirmed reliable `language` extraction, supporting its intentional exclusion from the boost score.*

**6. Enhance `rerankResults` Function:**
    *   **Signature:** Remains the same.
    *   **Internal Logic:**
        *   **a. Map to Scored Objects:** Iterate through `candidates` (`ContextObject[]`) and map each to a `ScoredContextObject`.
        *   **b. Calculate `initial_score`:**
            *   If `query_source === 'vector_store'`, use `initial_score = candidate.similarity ?? 0;`.
            *   If `query_source === 'postgres_fallback_text'`, use `initial_score = candidate.rank ?? 0;`.
        *   **c. Calculate `metadata_boost_score`:**
            *   Initialize `metadata_boost_score = 0.0`.
            *   Apply additive boosts (`+= 0.05`) for overlaps between `candidate.entities_in_chunk` and `queryMetadata` for: `people`, `locations`, `topics` (using `checkOverlap`), `type` (exact match), `sentiment` (exact match).
            *   **Apply Hierarchical Date Matching Boost:** Implement logic to iterate through `queryMetadata.dates`. For each query date, check for matches in `candidate.entities_in_chunk.dates` at the Day (+0.05), Month (+0.03), or Year (+0.01) level, adding the highest match found for that query date to the boost score.
            *   **Apply Date Range Boost (FTS Only):** If `query_source === 'postgres_fallback_text'`:
                *   Call `deriveDateRange(queryMetadata.dates)` once to get potential past ranges.
                *   Parse `candidate.timestamp` to a `Date` object.
                *   Check if the candidate's timestamp falls within *any* of the derived ranges.
                *   If it falls within a range, add `+= 0.10` to `metadata_boost_score`.
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

## Testing Requirements

*   Verify Vector Search results correctly use `similarity` for initial scoring in re-ranking.
*   Verify FTS fallback triggers correctly and results use `rank` for initial scoring.
*   Verify FTS results have their `chunk` truncated to 3000 characters.
*   Verify re-ranking logic correctly calculates scores, including the metadata overlap boosts and the hierarchical date matching boost (Day > Month > Year).
*   Verify FTS results receive the additional `+0.10` date range boost when their `created_at` timestamp matches a derived past query date range.
*   Test edge cases (no metadata overlap, empty query metadata, results with 0 similarity/rank, partial/full date matches, etc.).
*   Confirm final response contains `FINAL_MATCH_COUNT` results.
*   Confirm `message_for_gpt` no longer contains date parsing notes.

---
*   Update `learnings/01_project_roadmap.md` to reflect the completed implementation status of this revised plan.

---

# Enhancement Implementation Plan v1.4: Store Mode Date Parsing Refinement

**Version:** 1.4

**Prerequisite Assumption:** The controlling GPT (`gpt_instructions.md`) will be updated to:
1.  Translate all user input (`query_text`) to English before sending it to the `memory-action` in `store` or `combined` mode.
2.  Continue to extract the *original* detected language (e.g., 'fr', 'en') and send it in the `extracted_entities.language` field.
3.  The `memory-action` function will store this original `language` code, but the parsing logic below only needs to handle English date strings.

**Goal:** Refine the `parseDateStringToEnhanced` function within `memory-action.ts` to improve the accuracy and reliability of the stored `EnhancedNormalizedDate` components, leveraging `chrono-node` for initial parsing and `date-fns` for post-processing and correction, focusing solely on English date expressions.

**Rationale:** Address the specific date parsing failures identified in `03_test_observations.md` (Section B, Issue 2.1) to ensure more accurate date components are stored in metadata, thereby improving the effectiveness of the v1.3 relevance re-ranking (hierarchical date matching boost).

---

## Implementation Steps (`memory-action.ts`)

The following steps detail required modifications within the `parseDateStringToEnhanced` function in `netlify/functions/memory-action/memory-action.ts`.

**1. Refine `parseDateStringToEnhanced` Function Logic:**

*   **Input Assumption:** Acknowledge via comments that the `dateString` argument is assumed to be English.
*   **Post-`chrono.parse` Processing:** Retain `chrono.parse` for initial parsing. Add logic *after* the initial parse to refine the `result` (`results[0]`) and extracted `components`.
    *   **a. Day Boundary Correction:**
        *   Check if the input string contains terms like "end of day", "tonight", "EOD".
        *   Compare the date part (`YYYY-MM-DD`) of `result.start.date()` with the `referenceDate`.
        *   If they don't match (specifically, if `chrono`'s date is the day *after* `referenceDate`), use `date-fns` (e.g., `setYear`, `setMonth`, `setDate` or `startOfDay(referenceDate)`) to force the `year`, `month`, `day` components to match the `referenceDate`. Update the internal `components` object accordingly.
    *   **b. Relative Date Resolution (using `date-fns`):**
        *   Check if `chrono` produced a partial result for common relative terms (e.g., `result.start.isCertain('weekday')` is true but `result.start.isCertain('day')` is false, or month/year is known but day is not).
        *   Based on the identified components (e.g., `weekday`, `relative_marker` implied by `chrono`'s parsing context) and the `referenceDate`, use `date-fns` functions (e.g., `nextTuesday(referenceDate)`, `lastDayOfMonth(referenceDate)`, `addMonths(referenceDate, 1)`, `startOfWeek(referenceDate, { weekStartsOn: 1 })`) to calculate the specific target `year`, `month`, and `day`.
        *   Update the internal `components` object with these calculated, more precise values. Prioritize these calculated Y/M/D values over potentially vague `chrono` outputs for the final `EnhancedNormalizedDate`.
    *   **c. Time Component Handling (Reduce Granularity):**
        *   Only populate the `time_hour`, `time_minute`, `time_second` fields in the returned `EnhancedNormalizedDate` object if `result.start.isCertain('hour')` is true.
        *   If time components are uncertain, ensure the `normalized` ISO string output reflects this (e.g., format as `YYYY-MM-DD` using `date-fns.format(calculatedDate, 'yyyy-MM-dd')` instead of `formatISO` which includes time/offset). Set `normalized` to `null` if even the date is uncertain after corrections.
    *   **d. Explicit Anchor Prioritization:**
        *   Before finalizing components, check if the original `dateString` contained explicit anchors (e.g., a specific month name like "August", a year like "2025").
        *   If `chrono` identified these explicit components (`result.start.isCertain('month')`, `result.start.isCertain('year')`), ensure the final `year` and `month` components reflect these explicit values, potentially overriding interpretations derived solely from relative terms (e.g., for "last two weeks of August 2025", ensure Year=2025, Month=8 are primary).
    *   **e. Simplify Output Object:**
        *   Remove the `relative_marker` and `relative_unit` properties entirely from the final `EnhancedNormalizedDate` object returned by the function.
*   **Interface Update:** Update the `EnhancedNormalizedDate` interface definition within `memory-action.ts` to remove the `relative_marker` and `relative_unit` optional properties. (Note: `openapi.json` will need a corresponding update later).

**2. Add/Update Testing Requirements:**

*   Add specific unit tests (or manual test cases for `03_test_observations.md`) for `parseDateStringToEnhanced` covering:
    *   Input "end of day", "tonight" -> Resolves to current date (YYYY-MM-DD), time components are undefined/null.
    *   Input "next Wednesday" (relative to a known date) -> Resolves to correct future YYYY-MM-DD.
    *   Input "last Tuesday" (relative to a known date) -> Resolves to correct past YYYY-MM-DD.
    *   Input "last week" (relative to a known date) -> Resolves to appropriate YYYY-MM components (or YYYY-WW week number), *not* a specific day. `normalized` might be `null` or represent the week/month start.
    *   Input "last two weeks of August 2025" -> Resolves primarily based on August 2025 (YYYY=2025, Month=8). `normalized` reflects this, potentially `null` or `2025-08`.
    *   Input "April 28th, 2025 from 2am to 4am UTC" -> `time_hour`=2, `time_minute`=0 are populated; `normalized` includes time.
    *   Confirm `relative_marker` and `relative_unit` are absent in the output object.

**3. Update Project Roadmap:**

*   Add a task under Phase 5 in `learnings/01_project_roadmap.md` reflecting the goal of this v1.4 date parsing refinement.

**Impact Statement:**

*   Successfully implementing this plan will result in more accurate and reliable date components (`year`, `month`, `day`, `time_hour`, etc.) being stored in the `EnhancedNormalizedDate` objects within the JSONB metadata (`files.file_metadata`, `transcript_embeddings.metadata`).
*   This increased accuracy directly benefits the existing v1.3 query re-ranking logic in `rerankResults`, specifically the hierarchical date matching boost, making it more effective at identifying relevant memories based on date criteria. No changes are required to the `rerankResults` function itself as part of *this* plan (v1.4).

---