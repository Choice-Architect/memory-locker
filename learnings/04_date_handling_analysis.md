# Date Handling Analysis (Based on Test Results and Code Review - Apr 8)

This document analyzes the date/time handling mechanism based on test results from `testing/Sheet 5-Table 1.csv` and a review of the `memory-action.ts` codebase as of April 8th.

## 1. Segmented Date/Time Storage vs. ISO 8601

*   **User Suggestion:** Store date/time components (year, month, day, hour, minute) separately in metadata instead of normalizing to a single ISO 8601 string.
*   **Feasibility:**
    *   Parsing components is possible using `date-fns`.
    *   Storing a structured JSON object (e.g., `{ year: 2024, month: 7, ... }`) in JSONB is easy.
    *   Querying specific components is possible with JSONB operators.
*   **Challenges & Trade-offs:**
    *   **Relative Dates ("yesterday", "next week"):** Requires separate flags/fields, significantly complicating storage structure and queries.
    *   **Range Queries:** Becomes very difficult compared to simple ISO string comparisons.
    *   **Database Functions (`search_memory_chunks`):** Would require substantial rewrite to handle component logic and relative terms.
    *   **Standardization:** ISO 8601 is the standard for unambiguous timestamp comparison. Deviating adds custom complexity.
*   **Recommendation:** Stick with the current approach of normalizing to ISO 8601 strings. It's more robust, standard, and simplifies querying, especially for ranges and within the existing SQL function.

## 2. Parsing Vague Terms (e.g., "EOD Wednesday")

*   **Issue Observed (Test S7):** Input "EOD Wednesday" was rejected entirely as "vague phrasing", rather than parsing just "Wednesday".
*   **Code Analysis (`memory-action.ts` ~line 178):** The `normalizeDateString` function explicitly checks for a list of vague terms ("end of", "middle of", "sometime", etc.). If found anywhere in the input string, the *entire string* is rejected.
*   **Findings:** This behavior is intentional. The parser doesn't attempt to selectively ignore parts of a date string. Including a vague term makes the whole expression ambiguous for normalization to a single point in time.
*   **Recommendation:** Keep the current behavior. It avoids potential misinterpretations from trying to parse partially vague inputs.

## 3. Parsing Relative Terms & Ignoring Vague Modifiers (e.g., "sometime next week")

*   **Issue Observed (Test S5):** Input "sometime next week", GPT extracted only "next week". The parser correctly normalized "next week". User expectation was that "sometime" should be ignored.
*   **Code Analysis (`memory-action.ts` ~line 178, 218-225):** The parser correctly handles relative terms like "next week". It also identifies "sometime" as a vague term. If GPT had passed the full "sometime next week", the parser would have rejected it (as per point 3).
*   **Findings:** The parser behaves as expected, correctly handling standard relative terms and rejecting strings containing identified vague modifiers.
*   **Recommendation:** No change needed.

## Summary & Next Steps
*   **No Action:** Current handling of vague terms ("EOD") and relative/vague combinations ("sometime next week") aligns with desired behavior. 