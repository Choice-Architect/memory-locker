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

# Enhancement Implementation Plan v1.4: Store Mode Date Parsing Refinement (Revised)

**Version:** 1.4 (Revised Post-Test 2)

**Prerequisite Assumption:** The controlling GPT (`gpt_instructions.md`) will be updated to:
1.  Translate all user input (`query_text`) to English before sending it to the `memory-action` in `store` or `combined` mode.
2.  The `memory-action` function only needs to handle English date expressions.

**Goal:** Refine the `parseDateStringToEnhanced` function within `memory-action.ts` to accurately extract and store individual date/time **components** (`year`, `month`, `day`, `day_of_week`, `week_number`, `period`, `time_hour`, etc.) based on the clarified requirements in `learnings/03_test_observations.md` (Section C). Prioritize component accuracy over generating a `normalized` string, setting `normalized: null` when date certainty is insufficient.

**Rationale:** Address the specific date parsing failures and requirement mismatches identified in `learnings/03_test_observations.md` (Section B) to ensure accurate date components are stored for effective v1.3 relevance re-ranking.

---

## Implementation Steps (`memory-action.ts`)

The following steps detail required modifications within the `parseDateStringToEnhanced` function in `netlify/functions/memory-action/memory-action.ts`.

**1. Implement Pre-Parsing Qualifier Stripping:**
    *   **Action:** Add logic at the beginning of the function to identify and remove defined non-date qualifiers (e.g., "early", "late", "end of", "EOD", "COB", "sometime", "around", "beginning of", "first week of", "last two weeks of") from the input `dateString`. Store the cleaned string for subsequent parsing.

**2. Refine `parseDateStringToEnhanced` Post-`chrono.parse` Logic:**
    *   **Input Assumption:** Acknowledge via comments that the (cleaned) `dateString` argument is assumed to be English.
    *   **Retain Initial Parse:** Use `chrono.parse` on the *cleaned* `dateString` for an initial attempt.
    *   **Refine Components using `date-fns`:** Implement the following logic steps, using the `chrono` results, the cleaned `dateString`, the `referenceDate`, and `date-fns` for calculations and corrections. Focus on populating the individual component fields accurately.
        *   **a. Day Boundary Correction:**
            *   **Trigger:** Check if the *original* (uncleaned) `dateString` contains boundary terms like "end of day", "tonight", "this morning".
            *   **Action:** Force the `year`, `month`, `day` components to match the `referenceDate`. Set `period` appropriately (e.g., `PM` for "tonight", `AM` for "this morning").
        *   **b. Relative Date Resolution (Specific):**
            *   **Trigger:** For terms like "yesterday", "today", "tomorrow", relative weekdays ("next Tuesday", "last Friday").
            *   **Action:** Use `date-fns` (e.g., `addDays`, `subDays`, `nextTuesday`, `lastFriday`) to calculate the specific target `year`, `month`, `day`, and `day_of_week`.
        *   **c. Relative Week Resolution (Uncertain Day):**
            *   **Trigger:** For terms like "last week", "next week", "this week".
            *   **Action:** Use `date-fns` (e.g., `subWeeks`, `addWeeks`, `startOfWeek`, `getWeek`) to calculate `year`, `month` (of week start), and `week_number`. Ensure `day` is `undefined`.
        *   **d. Relative Month Resolution (Uncertain Day):**
            *   **Trigger:** For terms like "last month", "next month", "this month", or standalone month names ("September", "August").
            *   **Action:** Use `date-fns` (e.g., `subMonths`, `addMonths`, `startOfMonth`) or parse month name to calculate `year` and `month`. Ensure `day` is `undefined`.
        *   **e. Relative Year Resolution (Uncertain Month/Day):**
            *   **Trigger:** For terms like "last year", "next year", "this year".
            *   **Action:** Use `date-fns` (e.g., `subYears`, `addYears`) to calculate `year`. Ensure `month` and `day` are `undefined`.
        *   **f. Specific Date Handling (Month/Day/Year):**
            *   **Trigger:** For explicit dates like "April 8th", "April 10, 2025".
            *   **Action:** Parse components. **Crucially:** Handle past dates correctly – if "April 8th" is parsed and the reference date is April 10th, 2025, the result should be `Year=2025, Month=4, Day=8`, *not* 2026.
        *   **g. Explicit Anchor Prioritization:**
            *   **Action:** When parsing complex phrases (post-stripping, e.g., "August 2025"), ensure the explicitly mentioned components (Year=2025, Month=8) take precedence and correctly frame the context for any remaining (potentially stripped) relative parts, rather than defaulting to reference date context. (This likely interacts heavily with the qualifier stripping). Ensure Day remains `undefined` if not specified.
        *   **h. Time Component Handling:**
            *   **Action:** Only populate `time_hour`, `time_minute`, `time_second` if `chrono` initially found them with certainty (`result.start.isCertain('hour')`). Otherwise, leave them `undefined`. Set `period` if determined (e.g., from boundary terms or certain time).
        *   **i. Set `normalized` Field:**
            *   **Action:** After determining all components, check if `year`, `month`, *and* `day` are all defined.
                *   If YES, format `normalized` using `date-fns.formatISO` (include time if `time_hour` is defined).
                *   If NO (any of year, month, day is `undefined`), set `normalized = null`.

**3. Update `EnhancedNormalizedDate` Interface:**
    *   **Action:** Locate the interface definition within `memory-action.ts`.
        *   Ensure `relative_marker` and `relative_unit` properties are removed.
        *   Add `week_number?: number;`.

**4. Testing Requirements:**
    *   Update unit tests/manual test cases based on the specific failures noted in `learnings/03_test_observations.md` (Section B) and the requirements in Section C. Verify:
        *   Qualifier stripping works correctly.
        *   Day boundary terms resolve to the reference date.
        *   Relative week/month/year terms resolve to the correct components with `Day` (and `Month` if applicable) `undefined`.
        *   `week_number` is correctly calculated and stored.
        *   Explicit anchors are prioritized.
        *   Past dates resolve within the correct year context.
        *   `normalized` is `null` when day is uncertain.

**6. Update Dependent Files (`openapi.json`, `gpt_instructions.md`):**
    *   **`openapi.json`:**
        *   Remove `conversation_id` and `thread_id` properties from the `#/components/schemas/ExtractedEntities` definition.
        *   Update the `#/components/schemas/EnhancedNormalizedDate` definition to include `week_number?: number;`.
    *   **`gpt_instructions.md`:**
        *   Explicitly instruct the GPT *not* to extract `conversation_id` or `thread_id` from user input.

**7. Update Project Roadmap & Task List:**
    *   Update Phase 5, Item 4 in `learnings/01_project_roadmap.md` to reflect the *revised* goal and approach for date parsing refinement.

**8. Impact Statement:**
*   Successfully implementing this revised plan (including code, schema, and instruction changes) will result in more accurate and reliable date components being stored, aligning with clarified project requirements, improving the effectiveness of the v1.3 query re-ranking logic, and preventing UUID-related backend errors.

---

**Status:** **Completed.** The required changes to `memory-action.ts`, `openapi.json`, `gpt_instructions.md`, and `learnings/01_project_roadmap.md` have been implemented.