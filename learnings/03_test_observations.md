# Test Observations Summary (v1.3 Store Mode)

**Important Note:** The observations below, particularly those in Section B regarding Date/Time Entity Performance, reflect the system state *before* the v1.4 date parsing refinements (detailed in `02_enhancement_plan.md` and `04_date_parse_tasks.md`) were implemented. These observations identified the issues that the v1.4 changes aimed to address. The decision to keep `normalized: null` when the day is uncertain (Option A) was also made *after* these tests.

This report summarizes the key observations and issues identified during the testing of the `store` mode functionality, based on the detailed analysis in `learnings/03_test_learnings.md`.

## Section A: Non-Date Entity Performance & Issues

**1. Entity Performance Summaries (Non-Dates):**

*   **`people`**: Performance met expectations. It correctly identified single and multiple names, handled vague references like "My manager" and titles mixed with names ("Mr. Henderson") appropriately, and correctly omitted titles when used alone ("Project Lead"). Minor variations ("Mum" vs "Mom") are acceptable.
*   **`locations`**: Performance met expectations. It correctly extracted specific single and multi-part locations and correctly identified the absence of locations when appropriate.
*   **`topics`**: Consistently strong performance. Extracted core subjects accurately across various inputs, including specific project names, general themes, and concepts derived from minimal input. Appropriately excluded specific codes/IDs based on requirements. Included inferred related topics which added useful context (e.g., "marketing", "business meeting").
*   **`type`**: Performed well in inferring reasonable types based on input context (e.g., "encounter\_note", "reminder", "note", "task", "dictated\_email", "story"). Aligned well with test plan expectations or provided acceptable alternatives. The tendency towards broader categories like "note" aligns with the preference for fewer, less granular types.
*   **`sentiment`**: Successfully inferred sentiment when strong indicators were present (e.g., "productive", "urgent", "negative", "proud"). Appropriately defaulted to neutral or wasn't explicitly extracted when sentiment was not obvious or specified, aligning with user feedback.
*   **`language`**: Excellent performance. Correctly identified the dominant language ("en" in most cases) even with mixed-language proper nouns. Accurately extracted explicitly provided language ("fr").
*   **`priority`**: Performed exactly as expected. Correctly defaulted to 0 when not specified and accurately extracted the explicitly provided value when present.
*   **`organizations`**: Good performance in identifying company/organization names. Handled variations like "Flyhigh" vs "FlyHigh" acceptably. (Note: Some specific businesses like hotels or cafes were classified as `locations` (e.g., "Starbucks", "The Grand Hyatt Hotel"), which is acceptable for the current scope, but the distinction between `location` and `organization` for such entities might warrant future consideration.)
*   **`conversation_id` / `thread_id`**: While GPT demonstrated it could extract these when explicitly provided, it is **no longer instructed** to do so. This change was made because attempting to store the non-UUID user-provided strings caused backend database errors (Issue 1.1). These parameters are effectively no longer processed from user input.

**2. Identified Issues (Non-Dates):**

*   **`conversation_id` / `thread_id` (Backend Incompatibility):** The attempt to store the extracted non-UUID strings for these IDs caused a fatal database error because the corresponding columns require UUID format. (Issue Ref: 1.1 in `03_test_issues.md`) **Mitigation:** This is already addressed by updating GPT instructions to *not* extract these fields from user input.

---

## Section B: Date/Time Entity Performance & Issues

**3. Date Entity Performance Summary:**

*   **Original String Extraction:** The GPT model consistently performed well in extracting the original date/time-related strings from the input text across various formats (e.g., "yesterday afternoon", "next Tuesday morning", "April 28th, 2025 from 2am to 4am UTC", "last two weeks of August 2025", "last spring", "end of day", "vendredi prochain", "this morning", "September", "tomorrow end of day", multiple specific and relative dates, "today", "next Wednesday", "last week", "early next year", "last Tuesday", "next month"). It successfully ignored irrelevant conversational date references (e.g., "See you tomorrow"). Minor omissions of less specific phrases ("last month", "next 48 hours") occurred but were not critical.
*   **Parsing/Normalization (`EnhancedNormalizedDate`):** Performance was mixed and revealed significant limitations and potentially unnecessary complexity in the current `chrono-node` based parsing approach.
    *   **Successes:**
        *   Specific Dates/Times: Generally handled well (e.g., "April 28th, 2025 from 2am...").
        *   Simple Relative Terms: Parsed successfully when easily resolvable relative to the current time (e.g., "yesterday afternoon", "end of day" - incorrect day resolution issue noted below, "tomorrow end of day" - incorrect day resolution issue noted below, "today", "last week").
        *   Time Ranges: Successfully captured the start time from range expressions like "from X to Y". Capturing only the start time is considered acceptable for project needs; the full range remains in the `original` string.
    *   **Observations & Failures/Issues:**
        *   Unnecessary Complexity Fields: Fields like `relative_marker` and `relative_unit` were populated in several partial parses. These add complexity and are not currently used for ranking; they are candidates for removal in future refinements.
        *   Relative Day Names: Often failed to resolve to a specific date (e.g., "next Tuesday morning", "next Wednesday", "last Tuesday"). Returned only partial info (day of week, relative marker).
        *   Month Names/Relative Months: Failed to resolve when provided alone or with vague qualifiers (e.g., "September", "next month"). Returned only partial info (month, year, relative marker).
        *   Relative Day Parts: Failed to resolve without a specific date anchor (e.g., "this morning").
        *   Complex Relative Ranges: Grossly misinterpreted ranges anchored to specific months/years (e.g., "last two weeks of August 2025" interpreted relative to *now*).

**4. Identified Issues (Dates):**

*   **Date Parsing Limitations (Core Issue):** The primary issue is the inability of the current date parsing mechanism (`chrono-node` as configured/used) to reliably handle various common date/time expressions that *should* be parsed according to project requirements. This manifests in several ways:
    *   **Incorrect Day Resolution for Boundaries:** Resolving terms like "end of day" or "tonight" to the *next* calendar day instead of the current one.
    *   **Unwanted Time Normalization:** Generating specific time components (hour, minute, second) from vague references like "end of day", "last week", etc. when only the date (Y/M/D or YYYY-MM) is desired.
    *   **Inability to Resolve Relative Dates / Incorrect Granularity:** Failure to calculate specific date components based on the reference timestamp for relative terms, or resolving to an incorrect level of granularity. Examples:
        *   *Should* resolve "next Wednesday" to YYYY-MM-DD (failure noted).
        *   *Should* resolve "last Tuesday" to YYYY-MM-DD (failure noted).
        *   *Should* resolve "last week" to YYYY-MM (or similar week representation), not a specific day (failure noted).
        *   *Should* resolve "next month" to YYYY-MM (failure noted - only got YYYY-MM).
        *   (Note: "next year" resolving to YYYY is acceptable - success noted).
    *   **Context Dependency:** Failure to parse terms needing more context, like month names alone ("September") or relative day parts ("this morning").
    *   **Failure to Prioritize Explicit Anchors:** Ignoring explicit date components (like month, year) when combined with relative phrases, and incorrectly applying the relative part to the present instead (e.g., "last two weeks of August 2025" parsed relative to *now*, ignoring "August 2025").
    *   **Lack of Localization:** No built-in support for parsing non-English date strings ("vendredi prochain").
*   (Issue Ref: 2.1 in `03_test_issues.md` covers most of these parsing failures, excluding the now-acceptable time range and vague term handling).

---