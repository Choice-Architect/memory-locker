# Memory Locker: Implementation Plan v1.7 - Hybrid Date Parsing & Query Refinement

**Version:** 1.7 (Supersedes v1.3 Query Plan + v1.5/v1.6 Date Parsing Plans)

**Goal:** Implement a hybrid date parsing strategy in `store` mode leveraging upstream GPT normalization and targeted Netlify function logic. Maintain and refine the application-layer re-ranking in `query`/`combined` modes based on the reliably extracted date components.

**Core Principles:**

*   **Leverage Upstream GPT:** Utilize the Custom GPT's ability to normalize common date expressions (based on `learnings/chatgpt-date-normalisation.csv`) into a standard `YYYY-MM-DD` format.
*   **Netlify Function Focus:** The Netlify function (`memory-action.ts`) will focus on:
    *   Parsing the standardized `YYYY-MM-DD` from the GPT using `date-fns`.
    *   Extracting *time-related* information (periods, HH:MM) from the *original* user date string using targeted regex/`chrono-node`.
    *   Handling dates the GPT *cannot* normalize (fallback logic).
    *   Storing only structured components (year, month, day, period, etc.) in metadata (no `original` string).
    *   Performing application-layer re-ranking (`rerankResults`) using the stored components.
*   **Query Relevance:** Ensure the stored components support effective date-based querying and the existing re-ranking strategy (hierarchical date match, past date boost).

---

## Implementation Steps (General)

1.  **Update Custom GPT Instructions (`learnings/02_gpt_instructions.md`):**
    *   Instruct the GPT: When extracting date entities, if it can normalize the date expression (like those in `chatgpt-date-normalisation.csv`), it should provide *both* the original text and the normalized date in `YYYY-MM-DD` format.
    *   Specify the desired output format within the `entities.dates` array: Objects like `{"original": "next Tuesday morning", "normalized": "2025-04-15"}`. If normalization isn't possible, it should provide just the original string: `"April 28th, 2025, from 2:00 AM to 4:00 AM UTC"`.

2.  **Update OpenAPI Schema (`openapi.json`):**
    *   Modify the schema for the `entities.dates` array within the request body (`ExtractedEntities`).
    *   It should accept *either* a simple `string` *or* an `object` with properties:
        *   `original` (string, required)
        *   `normalized` (string, optional, format: date `YYYY-MM-DD`)
    *   Ensure the `EnhancedNormalizedDate` definition in the *response* schema (within `ContextObject`) **does not** include the `original` field, but **does** include all necessary components (`year`, `month`, `day`, `day_of_week`, `week_number`, `period`, `time_hour`, `time_minute`, `time_second`). Remove the `note` field if no longer needed for debugging/filtering.

---

## Implementation Steps (`memory-action.ts`)

**1. Update TypeScript Interfaces:**
    *   Define an input interface `InputDateEntity` representing the possibilities from the updated OpenAPI schema: `string | { original: string; normalized?: string; }`.
    *   Update the `EnhancedNormalizedDate` interface:
        *   Ensure all required output components are present (`year`, `month`, `day`, `day_of_week`, `week_number`, `period`, `time_hour`, `time_minute`, `time_second`). Add optional boolean flags like `is_normalized` or `is_fallback` if helpful for internal logic/debugging.
        *   **Remove** `original: string;`.
        *   **Remove** `note?: string;` (unless kept for specific internal error tracking, but not for filtering).
    *   Update `ContextObject` to use the refined `EnhancedNormalizedDate`.
    *   Keep `ScoredContextObject` and retrieval interfaces (`SearchResultItem`, `FallbackResultItem`) as defined in the v1.3 plan for re-ranking.

**2. Refactor Main Date Processing Logic (within `store`/`combined` handler):**
    *   Iterate through the input `entities.dates` array (which contains `InputDateEntity` items).
    *   For each item:
        *   Initialize an empty `parsedComponents: Partial<EnhancedNormalizedDate> = {};`
        *   Declare `originalString: string;`
        *   **Check Input Type:**
            *   If `typeof item === 'string'`:
                *   `originalString = item;`
                *   Call `handleFallbackParsing(originalString, referenceDate)` (see step 3). Assign result to `parsedComponents`.
            *   If `typeof item === 'object'`:
                *   `originalString = item.original;`
                *   If `item.normalized`:
                    *   Call `parseNormalizedDate(item.normalized)` (see step 3). Assign result to `parsedComponents`.
                *   Else (object but no normalized date):
                    *   Call `handleFallbackParsing(originalString, referenceDate)` (see step 3). Assign result to `parsedComponents`.
                *   **Always** call `extractTimeInfo(originalString)` (see step 3) and merge results into `parsedComponents`.
        *   **Validation & Storage:** If `parsedComponents` contains essential date info (e.g., at least year/month/day or year/month), add it to the list of dates (`processedMetadata.dates`) to be stored. Do NOT store if parsing completely failed. (Replaces the old "note"-based filtering).

**3. Implement/Refactor Helper Functions:**

    *   **`parseNormalizedDate(normalizedDate: string): Partial<EnhancedNormalizedDate>`:**
        *   Uses `date-fns.parse(normalizedDate, 'yyyy-MM-dd', new Date())` to get a Date object.
        *   Extracts `year`, `month` (adjusting for 0-index), `day`, `day_of_week` (adjusting for locale if needed), `week_number` using `date-fns` getters.
        *   **Crucially, implement the corrected "Past Month/Day Logic" here:** If the input only implies Month/Day (which shouldn't happen with `YYYY-MM-DD` but good defensive coding), ensure the correct year is used (compare parsed date to reference date, use reference year if parsed date is in the past).
        *   Returns the component object.

    *   **`extractTimeInfo(originalString: string): Partial<EnhancedNormalizedDate>`:**
        *   Uses focused regex and/or `chrono-node` on `originalString` ONLY to find time indicators.
        *   Looks for:
            *   Periods: "morning", "afternoon", "evening", "night", "EOD", "COB". Map to `period`.
            *   Times: HH:MM (24hr or AM/PM). Parse to `time_hour`, `time_minute`, potentially `time_second`. Update `period` if AM/PM found.
        *   Strips qualifiers/dates *before* time parsing if helpful (e.g., remove "next Tuesday" before looking for "morning").
        *   Returns object with only time components found (`period`, `time_hour`, etc.).

    *   **`handleFallbackParsing(originalString: string, referenceDate: Date): Partial<EnhancedNormalizedDate>`:**
        *   This function contains the *legacy* pattern-matching logic (from v1.6) but potentially simplified.
        *   It's called when the GPT couldn't normalize the date.
        *   It should attempt to parse complex dates (`April 28th, 2025...`), standalone relative weekdays (`next Friday`), combined weekday+period (`Tuesday afternoon`), etc. that the GPT didn't handle.
        *   It should *also* call `extractTimeInfo` internally as part of its process.
        *   **Future:** This is the function that could potentially be replaced by a targeted third-party API call if it remains unreliable.
        *   Returns the component object.

    *   **`populateComponents(...)` (Helper):** Refactor component population logic used by the above functions into a reusable helper if needed.

**4. `query`/`combined` Mode - Re-ranking (`rerankResults`):**
    *   **No Major Changes Needed:** The existing `rerankResults` logic (from v1.3 plan, Step 6) should still work correctly as it relies on the *stored components* (`year`, `month`, `day`, `period` etc. within `candidate.entities_in_chunk.dates`).
    *   **Verification:** Double-check that the component names used in `rerankResults` (e.g., for hierarchical date matching) exactly match the field names being stored by the new v1.7 parsing logic.
    *   **Query Date Parsing:** Ensure that date strings extracted from the *user's query* (`queryMetadata.dates`) are also parsed into the same `EnhancedNormalizedDate` component structure for comparison during re-ranking. This might involve applying a similar (perhaps simplified) parsing logic as the fallback store logic to the query dates.

**5. Constants & Cleanup:**
    *   Review and remove obsolete constants related to previous date parsing attempts.
    *   Remove the old v1.5/v1.6 plan sections and comments from this file.

---

**Impact Statement:**

*   This v1.7 plan shifts primary date normalization responsibility to the upstream GPT for common cases, simplifying the Netlify function's main path.
*   It focuses the Netlify function on reliable parsing of standardized dates, targeted time extraction, and handling specific complex/fallback cases.
*   It maintains the necessary structured components for the existing query re-ranking mechanism.
*   It clarifies the role of the `original` string (input only, not stored) and removes reliance on failure `note` fields for filtering.
*   Provides a clear path for integrating a third-party API as a future enhancement for the fallback path if needed.