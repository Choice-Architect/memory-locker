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

## Section B: Date/Time Entity Performance & Issues (Post v1.4 Refinement & Clarified Rules)

**Summary:** Testing after the v1.4 date parsing refinement attempt revealed mixed results when evaluated against the newly clarified parsing requirements. While simple relative day resolution improved, several key issues targeted by v1.4 persist or worsened, and fundamental problems with granularity and qualifier handling remain.

**1. Parsing/Normalization Performance (`EnhancedNormalizedDate`):**

*   **Successes (Aligning with Clarified Requirements):**
    *   **Simple Relative Dates:** Generally resolved correctly to specific YYYY-MM-DD (e.g., "yesterday", "today", "next Tuesday", "last Tuesday", "next Wednesday", "tomorrow").
    *   **Specific Dates/Times:** Full dates and specific dates with times were parsed correctly (e.g., "April 28th, 2025 from 2am..."). Start times from ranges were captured.
    *   **Vague Terms Ignored:** Vague seasonal terms ("last spring") were correctly ignored, resulting in no date components, as required.
    *   **Simple Qualifiers Ignored:** Modifiers like "before" (`avant`), "evening", "afternoon", "COB" were often correctly ignored when resolving the core date phrase.

*   **Failures (Against Clarified Requirements):**
    *   **Day Boundary Issues:**
        *   `end of day`: Failed completely (no components found). Should resolve to reference date YYYY-MM-DD.
        *   `this morning`: Incorrectly resolved to the *next* day when reference time was afternoon. Should resolve to reference date YYYY-MM-DD.
    *   **Qualifier Handling Issues:**
        *   Failed to ignore required qualifiers like "early", "EOD", "first week of", "last two weeks". These interfered with parsing, leading to incorrect dates or granularity.
    *   **Incorrect Granularity:**
        *   Consistently assigned specific days (often the 1st or inferred from reference date) to week, month, or year references ("last week", "next month", "September", "May 2025", "next year"). Should have left Day (and potentially Month) `undefined`.
    *   **Explicit Anchor Prioritization Failure:**
        *   Failed to prioritize explicit anchors ("August 2025") when parsing complex relative phrases ("last two weeks of August 2025").
    *   **Past Specific Date Handling:**
        *   Incorrectly resolved a recently passed specific date ("April 8th") to the following year instead of the correct past date within the current year context.

**2. Identified Issues (Dates - Post v1.4):**

*   **Parsing Logic Implementation Gaps:** The core issues stem from incomplete or incorrect implementation of the intended parsing logic within `parseDateStringToEnhanced`, particularly regarding:
    *   Handling day boundary terms ("end of day", "this morning").
    *   Stripping/ignoring specific qualifiers ("early", "EOD", etc.).
    *   Enforcing correct granularity (avoiding default days for week/month/year inputs).
    *   Prioritizing explicit date components over relative interpretations.
    *   Correctly resolving past dates within the current year context.

---

## Section C: Agreed Date Parsing Strategy & Required Changes (Post Test 2 Analysis)

**1. Strategy Shift: Prioritize Components, Allow Uncertain Normalization:**

*   The primary goal of `parseDateStringToEnhanced` is to accurately extract and store individual date/time **components** (`year`, `month`, `day`, `day_of_week`, `week_number`, `period`, `time_hour`, `time_minute`, `time_second`) into the `EnhancedNormalizedDate` object.
*   Components that cannot be reliably determined from the input MUST be stored as `undefined`.
*   Generating a `normalized` ISO 8601 string is secondary. In cases where components are uncertain (e.g., only Year/Month known, or only Year/Week known), the `normalized` field **MUST** be set to `null` rather than defaulting to an potentially inaccurate date (like the 1st of the month).

**2. Requirement: Ignore Granularity/Time Qualifiers:**

*   The parser MUST strip or ignore non-date qualifiers related to time-of-day or granularity (e.g., "early", "late", "end of", "EOD", "COB", "sometime", "around", "beginning of", "first week of", "last two weeks of") *before* attempting to parse the core date expression (e.g., "Friday", "next month", "August 2025").

**3. Required Code Changes in `parseDateStringToEnhanced` (`memory-action.ts`):**

*   **Implement Qualifier Stripping:** Add robust logic to identify and remove the specified qualifiers before passing the string to `chrono-node` or `date-fns` logic.
*   **Fix Day Boundary Logic:** Correctly implement checks and component setting for "end of day", "tonight", and "this morning" to resolve to the reference date's YYYY-MM-DD.
*   **Fix Granularity Logic:** Ensure inputs like "last week", "next month", "September", "May 2025", "next year" result in `Day` (and potentially `Month`) being `undefined`, and `normalized: null`.
*   **Implement Week Number:** Add logic to calculate `week_number` (e.g., using `date-fns.getWeek`) for "last week"/"next week" inputs. Update the `EnhancedNormalizedDate` interface to include `week_number?: number;`.
*   **Fix Explicit Anchor Logic:** Ensure explicit components (Year, Month in "August 2025") correctly frame the context for relative parts ("last two weeks").
*   **Fix Past Date Logic:** Correctly handle specific dates (Month/Day) that have recently passed, resolving them within the current year context.
*   **Set `normalized: null`:** Systematically set `normalized = null` whenever Day is `undefined` (or potentially when Month is also `undefined`).

**4. Other Required File Updates:**

*   **`openapi.json`:** Remove `conversation_id` and `thread_id` properties from the `#/components/schemas/ExtractedEntities` definition. Update `EnhancedNormalizedDate` schema to include optional `week_number`.
*   **`gpt_instructions.md`:** Explicitly instruct the GPT *not* to extract `conversation_id` or `thread_id`. Update any examples if necessary.
*   **`learnings/04_date_parse_tasks.md`:** This task list needs significant revision or replacement based on the failures and new requirements identified here.