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

**4. [x] `query`/`combined` Mode - Re-ranking (`rerankResults`) Verified:**
    *   Existing logic correctly uses stored components (`year`, `month`, `day`, `period`).
    *   Query date strings are parsed into the same `EnhancedNormalizedDate` structure for comparison.

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