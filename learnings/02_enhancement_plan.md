# Memory Locker: Implementation Plan v1.7 - Hybrid Date Parsing & Query Refinement

**Version:** 1.7 (Supersedes previous query/parsing plans)

**Goal:** Implement a hybrid date parsing strategy in `store` mode leveraging upstream GPT normalization and targeted Netlify function logic. Maintain and refine the application-layer re-ranking in `query`/`combined` modes based on the reliably extracted date components.

**Core Principles:**

*   **Leverage Upstream GPT:** Utilize the Custom GPT's ability to normalize common date expressions (based on `learnings/00-chatgpt-date-normalisation.csv`) into a standard `"Month DD, YYYY"` format (e.g., `"April 11, 2025"`). For ranges (e.g., `"May 1–7, 2025"`, `"last summer"`), the GPT provides the normalized *start date* in this format (e.g., `"May 01, 2025"`, `"June 01, 2024"`).
*   **Netlify Function Focus:** The Netlify function (`memory-action.ts`) will focus on:
    *   Parsing the standardized `"Month DD, YYYY"` format from the GPT using `date-fns`.
    *   Extracting *time-related* information (periods, HH:MM) from the *original* user date string using targeted regex and potentially `chrono-node` (only for time).
    *   Handling cases where the GPT *cannot* normalize the date (providing only the original string) via a dedicated `parseOriginalStringDate` function, which uses only `date-fns` for date parsing.
    *   Storing only structured components (year, month, day, period, etc.) in metadata (no `original` string).
    *   Performing application-layer re-ranking (`rerankResults`) using the stored components.
*   **Query Relevance:** Ensure the stored components support effective date-based querying and the existing re-ranking strategy (hierarchical date match, past date boost).

---

## Implementation Steps (General)

1.  **Update Custom GPT Instructions (`learnings/02_gpt_instructions.md`):**
    *   Instruct the GPT: When extracting date entities, if it can normalize the date expression (like those in `00-chatgpt-date-normalisation.csv`), it should provide *both* the original text and the normalized date in `"Month DD, YYYY"` format.
    *   Specify the desired output format within the `entities.dates` array: Objects like `{"original": "next Tuesday morning", "normalized": "April 15, 2025"}`. If normalization isn't possible, it should provide just the original string: `"April 28th, 2025, from 2:00 AM to 4:00 AM UTC"`.
    *   Ensure examples use the correct target format (`"Month DD, YYYY"`) and clarify that for ranges/seasons, the normalized date is the *start date*.

2.  **Update OpenAPI Schema (`openapi.json`):**
    *   Modify the schema for the `entities.dates` array within the request body (`ExtractedEntities`).
    *   It should accept *either* a simple `string` *or* an `object` with properties:
        *   `original` (string, required)
        *   `normalized` (string, optional, type: string - **Do not use `format: date`**)
    *   Ensure the `EnhancedNormalizedDate` definition in the *response* schema (within `ContextObject`) **does not** include the `original` field, but **does** include all necessary components (`year`, `month`, `day`, `day_of_week`, `week_number`, `period`, `time_hour`, `time_minute`, `time_second`). Remove the `note` field.

---

## Implementation Steps (`memory-action.ts`)

**1. Update TypeScript Interfaces (Completed):**
    *   Define an input interface `InputDateEntity` representing the possibilities from the updated OpenAPI schema: `string | { original: string; normalized?: string; }`.
    *   Update the `EnhancedNormalizedDate` interface:
        *   Ensure all required output components are present (`year`, `month` (1-12), `day`, `day_of_week` (0-6, Sun-Sat), `week_number`, `period`, `time_hour`, `time_minute`, `time_second`). Add optional boolean flags like `is_normalized` if helpful for internal logic/debugging.
        *   **Remove** `original: string;`.
        *   **Remove** `note?: string;`.
    *   Update `ContextObject` to use the refined `EnhancedNormalizedDate`.
    *   Keep `ScoredContextObject` and retrieval interfaces (`SearchResultItem`, `FallbackResultItem`) as defined previously for re-ranking.

**2. Refactor Main Date Processing Logic (Completed):**
    *   (Applied upfront before mode checking)
    *   Iterate through the input `entities.dates` array (which contains `InputDateEntity` items).
    *   For each item:
        *   Initialize an empty `parsedComponents: Partial<EnhancedNormalizedDate> = {};`
        *   Declare `originalString: string;`
        *   Declare `datePart: Partial<EnhancedNormalizedDate> = {};`
        *   **Check Input Type:**
            *   If `typeof item === 'string'`:
                *   `originalString = item;`
                *   Call `parseOriginalStringDate(originalString, referenceDate)` (see step 3). Assign result to `datePart`.
            *   If `typeof item === 'object'`:
                *   `originalString = item.original;`
                *   If `item.normalized`:
                    *   Call `parseNormalizedDate(item.normalized, referenceDate)` (see step 3). Assign result to `datePart`.
                *   Else (object but no normalized date):
                    *   Call `parseOriginalStringDate(originalString, referenceDate)` (see step 3). Assign result to `datePart`.
        *   **Always** call `extractTimeInfo(originalString)` (see step 3) and merge results with `datePart` into `parsedComponents`.
        *   **Validation & Storage:** If `parsedComponents` contains essential date info (e.g., at least `year` and `month`) or time info, add it to the list of dates (`processedMetadata.dates`) to be stored.
        *   Log warning otherwise.

**3. Implement/Refactor Helper Functions (Completed):**

    *   **`parseNormalizedDate(normalizedDate: string, referenceDate: Date): Partial<EnhancedNormalizedDate>`:**
        *   Uses `date-fns.parse(normalizedDate, 'MMMM d, yyyy', referenceDate)` (adjust format string if needed to exactly match GPT output). Handle potential parsing errors.
        *   Extracts `year`, `month` (adjusting for 1-index), `day`, `day_of_week` (0-6 using `date-fns.getDay`), `week_number` using `date-fns` getters.
        *   Implement corrected "Past Month/Day Logic" defensively if parsing month/day only (though unlikely with full date format): ensure the correct year is used by comparing to `referenceDate`.
        *   Returns the component object containing *only date* parts.

    *   **`extractTimeInfo(originalString: string): Partial<EnhancedNormalizedDate>`:**
        *   Uses focused regex on `originalString` ONLY to find time indicators.
        *   Looks for:
            *   Periods: "morning", "afternoon", "evening", "night", "EOD", "COB". Map to `period`.
            *   Times: HH:MM (24hr or AM/PM). Parse to `time_hour`, `time_minute`, potentially `time_second`. Update `period` if AM/PM found.
        *   Optionally uses `chrono-node` on `originalString` *only* as a secondary step if regex fails, extracting *only time components* (`hour`, `minute`, etc.) if found. Be cautious of `chrono` inferring dates; discard any date parts it might find.
        *   Returns object with only time components found (`period`, `time_hour`, etc.).

    *   **`parseOriginalStringDate(originalString: string, referenceDate: Date): Partial<EnhancedNormalizedDate>`:** (Replaces old 'fallback' logic)
        *   **Starts Fresh for v1.7.** Triggered only when GPT provides no `normalized` date.
        *   **Goal:** Extract core date components (Year, Month, Day) from the `originalString`.
        *   **Tools:** Use `date-fns.parse` attempting specific, common formats (e.g., "MM/dd/yyyy", "yyyy-MM-dd", potentially others *if* easily identifiable). Does **not** use `chrono-node` for date parsing.
        *   If `date-fns` successfully parses a date, extract components (`year`, `month`, `day`, `day_of_week`, `week_number`).
        *   If parsing fails, returns an empty object. Ambiguous relative dates not handled by GPT (e.g., "next weekend") will likely fail parsing here, which is acceptable.
        *   Returns the component object containing *only date* parts found.

    *   **`populateComponents(...)` (Helper):** (Not implemented as separate helper, logic integrated into parsers)

**4. `query`/`combined` Mode - Re-ranking (`rerankResults`) (Verified):**
    *   **No Major Changes Needed:** The existing `rerankResults` logic should still work correctly as it relies on the *stored components* (`year`, `month`, `day`, `period` etc.).
    *   **Verification:** Double-check that the component names used in `rerankResults` exactly match the field names being stored by the new v1.7 parsing logic.
    *   **Query Date Parsing:** Date strings extracted from the *user's query* (`queryMetadata.dates`) are parsed into the same `EnhancedNormalizedDate` component structure using the same upfront logic for comparison during re-ranking.
    *   **Note on Stored Data:** Currently, only date *components* are stored in metadata (not the GPT-provided `normalized` string). This ensures consistency but means direct string matching on the normalized date isn't possible in DB queries. This decision maintains focus on component-based relevance for v1.7 and can be re-evaluated when enhancing query logic specifically.

**5. Constants & Cleanup (Completed):**
    *   Review and remove obsolete constants, comments, and functions related to previous date parsing attempts (v1.4-v1.6). Ensure no remnants of the old logic interfere with the clean v1.7 approach.

---

**Impact Statement:**

*   This v1.7 plan shifts primary date normalization responsibility to the upstream GPT for common cases, simplifying the Netlify function's main path.
*   It focuses the Netlify function on reliable parsing of standardized `"Month DD, YYYY"` dates, targeted time extraction (`extractTimeInfo`), and a clean, limited date parsing function (`parseOriginalStringDate`) for cases where GPT provides no normalization.
*   It maintains the necessary structured components for the existing query re-ranking mechanism.
*   It clarifies the role of the `original` string (input only, not stored) and removes reliance on failure `note` fields for filtering.
*   Accepts the limitation that ambiguous date strings not normalized by GPT may not yield stored date components.
*   Provides a clear path for potential future enhancements if the limitations prove problematic.