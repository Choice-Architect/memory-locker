# Memory Locker: Date Parsing Refinement Tasks (v1.4)

**Version:** 1.4

**Goal:** Implement the refined date parsing logic for `store` mode as outlined in `learnings/02_enhancement_plan.md` (Section: v1.4), focusing on improving the accuracy of `EnhancedNormalizedDate` objects stored in metadata.

**Reference Plan:** `learnings/02_enhancement_plan.md` (Section: "Enhancement Implementation Plan v1.4: Store Mode Date Parsing Refinement")
**Reference Roadmap:** `learnings/01_project_roadmap.md` (Task: Phase 5, Item 4)

**Prerequisite Assumptions:**
*   The controlling GPT translates user input to English before sending it to the action.
*   The GPT still sends the *original* language code (e.g., 'fr') in the `language` field.
*   The `memory-action.ts` function only needs to parse English date strings within `parseDateStringToEnhanced`.

---

## Implementation Task Breakdown (`netlify/functions/memory-action/memory-action.ts`)

**Target Function:** `parseDateStringToEnhanced(dateString: string, referenceDate: Date): EnhancedNormalizedDate`

**1. Add Input Assumption Comment:**
    *   Add a comment at the beginning of the function stating that `dateString` is assumed to be English due to GPT pre-translation.

**2. Implement Post-`chrono.parse` Logic:**
    *   Retain the initial `const results = chrono.parse(dateString, referenceDate, { forwardDate: true });` call.
    *   Get the primary `result = results[0]` and its `components = result.start`.
    *   Implement the following refinement steps using the `result`, `components`, and `referenceDate`.

**3. Implement Day Boundary Correction:**
    *   **Trigger:** Check if `dateString` contains keywords like "end of day", "tonight", "EOD", etc.
    *   **Logic:**
        *   Get the date object from `chrono`: `const chronoDate = result.date();`
        *   Compare `chronoDate` with `referenceDate` using `date-fns.isSameDay()`.
        *   If they are *not* the same day (and `chronoDate` is likely the next day), correct the date components.
        *   **Action:** Use `date-fns` to get the Year, Month (0-indexed), and Day from `referenceDate`. Update the `year`, `month`, `day` variables/properties that will be used to construct the final `EnhancedNormalizedDate`. For example: `correctedYear = referenceDate.getFullYear(); correctedMonth = referenceDate.getMonth() + 1; correctedDay = referenceDate.getDate();`. Ensure these corrected values override `chrono`\'s components for the final output.

**4. Implement Relative Date Resolution:**
    *   **Trigger:** Check if `chrono` provides partial components (e.g., `components.isCertain(\'weekday\')` but not `components.isCertain(\'day\')`, or known month/year but not day).
    *   **Logic:**
        *   Use `if/else if` blocks based on the available components and potential keywords in `dateString`.
        *   **Examples:**
            *   If `weekday` is known (e.g., 2 for Tuesday) and `dateString` implies "next", calculate `const targetDate = dateFns.nextTuesday(referenceDate);`.
            *   If `weekday` is known and `dateString` implies "last", calculate `const targetDate = dateFns.lastDayOfWeek(referenceDate, { weekStartsOn: components.get(\'weekday\') });` (adjust logic as needed for specific "last Xday").
            *   If `dateString` is "tomorrow", calculate `const targetDate = dateFns.addDays(referenceDate, 1);`.
            *   If `dateString` is "yesterday", calculate `const targetDate = dateFns.subDays(referenceDate, 1);`.
            *   If `dateString` implies "last week", calculate `const targetWeekStart = dateFns.startOfWeek(dateFns.subWeeks(referenceDate, 1));`. Store Year and Month from `targetWeekStart`. Maybe store week number using `dateFns.getWeek()`. Set `day` to `undefined`.
            *   If `dateString` implies "next month", calculate `const targetMonthStart = dateFns.startOfMonth(dateFns.addMonths(referenceDate, 1));`. Store Year and Month. Set `day` to `undefined`.
    *   **Action:** Extract `getFullYear()`, `getMonth() + 1`, `getDate()` from the calculated `targetDate` and update the `year`, `month`, `day` variables/properties for the final output, overriding `chrono`\'s initial components if they were less specific.

**5. Implement Time Component Handling:**
    *   **Logic:** Check `components.isCertain(\'hour\')`.
    *   **Action:**
        *   If `true`, populate `time_hour`, `time_minute`, `time_second` in the final `EnhancedNormalizedDate` from `components.get(\'hour\')`, etc.
        *   If `false`, ensure `time_hour`, `time_minute`, `time_second` are `undefined` in the final object.
    *   **Normalize Output:**
        *   If time is certain and the date is certain, format the `normalized` string using `dateFns.formatISO(calculatedDate)`.
        *   If time is uncertain but the date *is* certain (after corrections), format the `normalized` string as `YYYY-MM-DD` using `dateFns.format(calculatedDate, \'yyyy-MM-dd\')`.
        *   If the date itself is uncertain, set `normalized` to `null`.

**6. Implement Explicit Anchor Prioritization:**
    *   **Logic:** Before returning the final object, re-check if `components.isCertain(\'year\')` and/or `components.isCertain(\'month\')`.
    *   **Action:** If explicit year/month were identified by `chrono` (e.g., from \"...of August 2025\"), ensure the final `year` and `month` values match these explicit components, even if relative calculations (Step 4) produced slightly different results based on ambiguity. The explicit component found *in the text* should win.

**7. Implement Output Simplification:**
    *   **Action:** Ensure the final `EnhancedNormalizedDate` object returned by the function *does not* include the `relative_marker` or `relative_unit` properties.

**8. Update `EnhancedNormalizedDate` Interface:**
    *   **Action:** Locate the `EnhancedNormalizedDate` interface definition within `memory-action.ts`. Remove the optional `relative_marker?: ...` and `relative_unit?: ...` properties.

---

## Testing Tasks

*   **Create Unit Tests (Ideal):** Write specific unit tests for the `parseDateStringToEnhanced` function in a separate test file (e.g., `memory-action.test.ts`) covering the cases listed below.
*   **Manual Verification (Alternative):** If unit tests aren\'t feasible immediately, manually test these cases using simulated calls to the Netlify function or by isolating the function logic. Document results, potentially updating `learnings/03_test_granular_analysis.md` or a new test log.

**Test Cases:**
*   `parseDateStringToEnhanced("end of day", referenceDate)` -> Should return object with Y/M/D matching `referenceDate`, undefined time components, correct `normalized` (YYYY-MM-DD), no relative markers.
*   `parseDateStringToEnhanced("tonight", referenceDate)` -> Same as above.
*   `parseDateStringToEnhanced("next Wednesday", referenceDate)` -> Should return object with correct future Y/M/D, undefined time, correct `normalized` (YYYY-MM-DD).
*   `parseDateStringToEnhanced("last Tuesday", referenceDate)` -> Should return object with correct past Y/M/D, undefined time, correct `normalized` (YYYY-MM-DD).
*   `parseDateStringToEnhanced("tomorrow", referenceDate)` -> Correct Y/M/D for next day, `normalized` (YYYY-MM-DD).
*   `parseDateStringToEnhanced("yesterday", referenceDate)` -> Correct Y/M/D for previous day, `normalized` (YYYY-MM-DD).
*   `parseDateStringToEnhanced("last week", referenceDate)` -> Returns correct Year/Month (maybe week number), `day` is undefined, `normalized` is null.
*   `parseDateStringToEnhanced("next month", referenceDate)` -> Returns correct Year/Month, `day` is undefined, `normalized` is null.
*   `parseDateStringToEnhanced("last two weeks of August 2025", referenceDate)` -> Returns Year=2025, Month=8, `day` likely undefined, `normalized` is null.
*   `parseDateStringToEnhanced("April 28th, 2025 from 2am to 4am UTC", referenceDate)` -> Returns Year=2025, Month=4, Day=28, Hour=2, Minute=0, `normalized` includes date and time (ISO format).
*   Verify `relative_marker` and `relative_unit` are consistently absent in all outputs.

---

## Documentation Tasks

*   Add inline comments within `parseDateStringToEnhanced` explaining the different correction/logic steps (Day Boundary, Relative Resolution, Time Handling, Anchor Prioritization).
*   Update the main function comment for `parseDateStringToEnhanced` to accurately describe its refined behavior and reliance on `date-fns` for corrections.

---

**(End of Plan)**