# Test Observations (v1.4 Implementation)

## Analysis for Input: "I had a productive meeting with Sarah Chen at Starbucks yesterday afternoon about the Q3 marketing strategy due next Friday."

**1. Successfully Processed Date/Time Entities & Components:**

*   **`yesterday afternoon`**:
    *   `original`: "yesterday afternoon"
    *   `year`: 2025
    *   `month`: 4
    *   `day`: 10
    *   `day_of_week`: 4
    *   `normalized`: "2025-04-10"

**2. Unprocessed/Incorrectly Processed Date/Time Entities & Components:**

*   **`next Friday`**:
    *   `original`: "next Friday"
    *   `year`: *Missing* (Log shows Chrono implied 2025)
    *   `month`: *Missing* (Log shows Chrono implied 4)
    *   `day`: *Missing* (Log shows Chrono implied 18)
    *   `day_of_week`: *Missing* (Log shows Chrono known 5)
    *   `normalized`: `null` (Log message: "Date components incomplete; normalization skipped.") - **This is incorrect.**
    *   `note`: "Date components incomplete; normalization skipped."

**3. Error Analysis:**

*   The primary error is with **`next Friday`**. The v1.4 plan (Step 2.b: Relative Date Resolution) explicitly requires resolving relative weekdays like "next Friday" to a *specific* date (Year, Month, Day) using `date-fns`. The log shows `chrono.parse` correctly implies the date `2025-04-18`. However, the subsequent logic incorrectly determines the components are uncertain (`Day is uncertain... Date is uncertain (missing Y, M, or D)`), fails to populate the specific components (Year, Month, Day, DayOfWeek) into the final object, and incorrectly sets `normalized = null`. The check for uncertainty seems misapplied here; a relative weekday *should* resolve to a certain date.

**4. Suggestions:**

*   Implement pattern matching for "next Friday" using `date-fns.nextFriday` to calculate components directly.
*   Populate `year`, `month`, `day`, `day_of_week` from the `date-fns` result.
*   Remove the logic block that incorrectly flags this pattern as uncertain.
*   Remove logic related to generating the `normalized` string.

--- 


Okay, I will proceed with the analysis for the remaining test cases and append the results sequentially to `learnings/05_test_observations_v1.4.md`.

---

### Analysis for Input: "The server maintenance window is scheduled for April 28th, 2025, from 2:00 AM to 4:00 AM UTC."

**1. Successfully Processed Date/Time Entities & Components:**

*   **`April 28th, 2025, from 2:00 AM to 4:00 AM UTC`**:
    *   `original`: "April 28th, 2025, from 2:00 AM to 4:00 AM UTC"
    *   `year`: 2025
    *   `month`: 4
    *   `day`: 28
    *   `day_of_week`: 1
    *   `time_hour`: 2
    *   `time_minute`: 0
    *   `time_second`: 0
    *   `period`: "AM"
    *   `normalized`: "2025-04-28T02:00:00Z" (Correctly captured start time and UTC context)

**2. Unprocessed/Incorrectly Processed Date/Time Entities & Components:**

*   None. The parsing appears successful and aligns with expectations for specific date/time inputs.

**3. Error Analysis:**

*   No errors identified in this case.

**4. Suggestions:**

*   No changes needed based on this test case. The pattern matching should still correctly identify and parse this specific date format.

---

### Analysis for Input: "My vacation is planned for the last two weeks of August 2025."

**1. Successfully Processed Date/Time Entities & Components:**

*   **`last two weeks of August 2025`**:
    *   `original`: "last two weeks of August 2025"
    *   `year`: 2025
    *   `month`: 8
    *   `normalized`: `null` (Correct, as Day is uncertain)
    *   `note`: "Date components incomplete; normalization skipped."

**2. Unprocessed/Incorrectly Processed Date/Time Entities & Components:**

*   **`last two weeks of August 2025`**:
    *   `day`: *Missing* (Correctly missing, as it's uncertain)
    *   `week_number`: *Missing* (Log shows qualifier "last two weeks of" was stripped, but no week calculation occurred) - **This is incorrect.**
    *   The logic identified the core "August 2025" but didn't process the "last two weeks" qualifier to determine relevant week numbers or a specific date range context.

**3. Error Analysis:**

*   The qualifier stripping worked (`Cleaned string: ""August 2025"", Found qualifiers: last two weeks of`), but the subsequent logic only parsed the cleaned string ("August 2025").
*   Per user confirmation, the stripped qualifier ("last two weeks of") should be ignored, so failing to use it is correct. The parsing of "August 2025" (Year, Month only) is the desired outcome.

**4. Suggestions:**

*   No changes needed based on this test case. The "strip and ignore" qualifier logic combined with pattern matching for "Month Year" should achieve the correct result (Year=2025, Month=8, Day=undefined).

---

### Analysis for Input: "We discussed the budget revisions sometime last spring."

**1. Successfully Processed Date/Time Entities & Components:**

*   **`last spring`**:
    *   `original`: "last spring"
    *   `normalized`: `null` (Correct, as parsing failed)
    *   `note`: "Failed to parse date string."

**2. Unprocessed/Incorrectly Processed Date/Time Entities & Components:**

*   None. The system correctly identified that "last spring" is too vague to parse into specific components, which aligns with the desired behavior for such terms.

**3. Error Analysis:**

*   No error. The `chrono.parse` failure and resulting `normalized: null` is the expected outcome for this vague input.

**4. Suggestions:**

*   No changes needed. The pattern matching should fail to find a specific pattern for "last spring", resulting in no components being populated.

---

### Analysis for Input: "URGENT: Need to finalize the contract with Acme Corp by end of day. Set priority 9"

**1. Successfully Processed Date/Time Entities & Components:**

*   **`end of day`**:
    *   `original`: "end of day"
    *   `normalized`: `null` (Result of parsing failure)
    *   `note`: "Failed to parse date string."

**2. Unprocessed/Incorrectly Processed Date/Time Entities & Components:**

*   **`end of day`**:
    *   `year`, `month`, `day`, `day_of_week`, `period`: *Missing* - **This is incorrect.** Expected behavior was to resolve to the reference date's components.

**3. Error Analysis:**

*   Qualifier stripping identified "end of" and left the `Cleaned string: ""day""`.
*   The subsequent `chrono.parse` failed on the cleaned string "day".
*   The specific logic intended by v1.4 (Step 2.a: Day Boundary Correction - check *original* string for "end of day", force components to reference date, set period) was not triggered or implemented correctly. The system should not have relied on parsing the ambiguous cleaned string "day".

**4. Suggestions:**

*   Implement the pattern matching logic to check the *original* string for "end of day".
*   If found, directly set `year`, `month`, `day` from `referenceDate` using `date-fns`.
*   Set `period` appropriately (e.g., "Evening").
*   Remove logic related to generating the `normalized` string.

---

### Analysis for Input: "Note pour moi-même : Le rapport financier pour Q2 doit être soumis avant vendredi prochain." (Date Entity: `before next Friday`)

**1. Successfully Processed Date/Time Entities & Components:**

*   None.

**2. Unprocessed/Incorrectly Processed Date/Time Entities & Components:**

*   **`before next Friday`**:
    *   `original`: "before next Friday"
    *   `year`: *Missing* (Log shows Chrono implied 2025)
    *   `month`: *Missing* (Log shows Chrono implied 4)
    *   `day`: *Missing* (Log shows Chrono implied 18)
    *   `day_of_week`: *Missing* (Log shows Chrono known 5)
    *   `normalized`: `null` (Log message: "Date components incomplete; normalization skipped.") - **This is incorrect.**
    *   `note`: "Date components incomplete; normalization skipped."

**3. Error Analysis:**

*   Qualifier stripping correctly identified "before" (`Cleaned string: ""next Friday"", Found qualifiers: before`).
*   The stripped qualifier "before" was not used further, which is acceptable per the v1.4 plan (qualifiers are generally ignored for parsing the core date).

**4. Suggestions:**

*   Implement pattern matching for "next Friday" using `date-fns.nextFriday` to calculate components directly.
*   Populate `year`, `month`, `day`, `day_of_week` from the `date-fns` result.
*   Ensure the "strip and ignore" logic correctly handles the "before" qualifier.
*   Remove logic related to generating the `normalized` string.

---

### Analysis for Input: (Dictated Email containing `this morning`, `end of day tomorrow`, `September`)

**1. Successfully Processed Date/Time Entities & Components:**

*   **`end of day tomorrow`**:
    *   `original`: "end of day tomorrow"
    *   `period`: "Evening" (Indicates boundary term logic was partially triggered)
    *   `year`: 2025
    *   `month`: 4
    *   `day`: 11 (**Incorrect** - should be tomorrow, the 12th)
    *   `day_of_week`: 5 (**Incorrect** - should be 6)
    *   `normalized`: "2025-04-11" (**Incorrect**)
*   **`September`**:
    *   `original`: "September"
    *   `year`: 2025
    *   `month`: 9
    *   `normalized`: `null` (Correct, as Day is uncertain)
    *   `note`: "Date components incomplete; normalization skipped."

**2. Unprocessed/Incorrectly Processed Date/Time Entities & Components:**

*   **`this morning`**:
    *   `original`: "this morning"
    *   `normalized`: `null` (Result of parsing failure) - **This is incorrect.**
    *   `note`: "Failed to parse date string."
    *   All components (`year`, `month`, `day`, `period`, etc.) are missing. Expected: Resolve to reference date with appropriate period.
*   **`end of day tomorrow`**: Incorrectly resolved Day/DayOfWeek/Normalized to the *reference date* (April 11th) instead of *tomorrow* (April 12th).

**3. Error Analysis:**

*   **`this morning`**: Qualifier stripping left an empty string (`Cleaned string: """", Found qualifiers: this morning`), causing `chrono.parse` to fail. The Day Boundary Correction logic (v1.4, Step 2.a) failed to trigger based on the original string to force resolution to the reference date.
*   **`end of day tomorrow`**: Qualifier stripping worked (`Cleaned string: ""day tomorrow"", Found qualifiers: end of`). `chrono.parse` then successfully parsed "tomorrow" (implying April 12th). However, the log `Handling day boundary term.` indicates the boundary logic *did* trigger (likely due to "end of day" in the original string), but it incorrectly forced the date components to the *reference date* (April 11th) instead of using the already parsed *tomorrow* date (April 12th) and only applying the "end of day" context (e.g., setting `period`). This interaction is flawed.
*   **`September`**: Handled correctly according to the plan (Year/Month identified, Day uncertain, `normalized: null`).

**4. Suggestions:**

*   **`this morning`**: Implement pattern matching to check the *original* string for "this morning". If found, set Y/M/D from `referenceDate` and set `period`="Morning".
*   **`end of day tomorrow`**: Implement pattern matching for "tomorrow" using `date-fns.addDays`. Then, implement the interaction logic for boundary terms: since "end of day" was in the original string, use the calculated date for Y/M/D but set `period`="Evening".
*   **`September`**: No changes needed; pattern matching for Month Name should result in Y/M components only.
*   Remove logic related to generating the `normalized` string.

---

### Analysis for Input: "Call Mom tomorrow."

**1. Successfully Processed Date/Time Entities & Components:**

*   **`tomorrow`**:
    *   `original`: "tomorrow"
    *   `year`: 2025
    *   `month`: 4
    *   `day`: 12
    *   `day_of_week`: 6
    *   `normalized`: "2025-04-12"

**2. Unprocessed/Incorrectly Processed Date/Time Entities & Components:**

*   None. This simple relative date was processed correctly.

**3. Error Analysis:**

*   No errors identified. This contradicts the failure seen for "next Friday" and "next Tuesday", suggesting the "uncertainty" logic might be inconsistently applied or that "tomorrow"/"yesterday"/"today" have a separate, correctly implemented path.

**4. Suggestions:**

*   Ensure the pattern matching correctly identifies "tomorrow" and uses `date-fns.addDays` to populate components. (This seems to be working, but verify consistency).
*   Remove logic related to generating the `normalized` string.

---

### Analysis for Input: (Project Phoenix Update with multiple dates)

*   **`April 10, 2025`**: Processed **correctly**. (Y/M/D populated, `normalized` correct).
*   **`next Monday, April 14th`**: Processed **incorrectly**. Failed for the same reason as "next Friday" - flagged as uncertain, components missing, `normalized: null`. `chrono` correctly identified the date in logs.
*   **`Friday EOD`**: Log incomplete (`Cleaned string: ""Friday"", Found qualifiers: eod`). Cannot fully analyze, but likely failed similarly to "next Friday" after stripping. Requires fix for relative weekdays and potentially refined boundary logic for "EOD".
*   **`yesterday evening (around 11 PM PST)`**: Log incomplete (`Cleaned string: ""yesterday evening"", Found qualifiers: around`). Cannot fully analyze, but `chrono` results are missing. Requires fix for parsing relative dates with times and handling qualifiers like "around".
*   **`Wednesday, April 16th`**: Log incomplete. Presumed processed **incorrectly** like "next Monday, April 14th". Requires fix for relative weekdays/specific dates.
*   **`Tuesday afternoon`**: Log incomplete. Presumed processed **incorrectly** like "next Monday, April 14th". Requires fix for relative weekdays.
*   **`April 8th`**: Log incomplete. Cannot verify if past date handling (resolving to 2025-04-08, not 2026) worked as required by v1.4 plan.
*   **`COB April 15th`**: Log incomplete. Requires fix for specific dates and potentially refined boundary logic for "COB".
*   **`first week of May 2025`**: Log incomplete. Requires implementation of logic to handle "first week of" qualifier to extract Year/Month/WeekNumber, with `normalized: null`.

**Overall Analysis for Multi-Date Input:**

*   Consistent failure on relative weekdays/specific dates mentioned with weekdays (e.g., "next Monday, April 14th").
*   Incomplete logs prevent full analysis of boundary terms ("EOD", "COB"), qualifiers ("around", "first week of"), and past date handling ("April 8th").
*   The core issue remains the incorrect application of the "uncertainty" check to specific dates derived from relative terms.

**Suggestions:** (Applying pattern-driven approach)

*   **`next Monday, April 14th`**: Implement pattern matching for "next Monday" (using `date-fns.nextMonday`) and verify Y/M/D components are populated.
*   **`Friday EOD`**: Implement pattern matching for "Friday" (using `date-fns.nextFriday` or similar based on context), then check original string for "EOD" and set `period`="Evening".
*   **`yesterday evening (around 11 PM PST)`**: Implement pattern matching for "yesterday" (using `date-fns.subDays`), identify time "11 PM PST", parse time components, and set `period`="Evening". Ignore "around".
*   **`Wednesday, April 16th`**: Verify pattern matching for specific dates.
*   **`Tuesday afternoon`**: Implement pattern matching for "Tuesday" (using `date-fns.nextTuesday` or similar), set `period`="Afternoon".
*   **`April 8th`**: Verify pattern matching for specific dates and ensure past date logic works correctly (resolves to 2025-04-08).
*   **`COB April 15th`**: Verify pattern matching for specific dates, check original string for "COB", set `period`="Afternoon".
*   **`first week of May 2025`**: Per user confirmation, strip "first week of" and parse "May 2025". Pattern matching should result in Year=2025, Month=5, Day=undefined.
*   Remove logic related to generating the `normalized` string throughout.

---

### Analysis for Input: "Terrible customer service experience with FlyHigh Airlines today..."

**1. Successfully Processed Date/Time Entities & Components:**

*   **`today`**:
    *   `original`: "today"
    *   `year`: 2025
    *   `month`: 4
    *   `day`: 11
    *   `day_of_week`: 5
    *   `normalized`: "2025-04-11"

**2. Unprocessed/Incorrectly Processed Date/Time Entities & Components:**

*   None. Handled correctly.

**3. Error Analysis:**

*   No errors identified. Consistent with "tomorrow" being handled correctly.

**4. Suggestions:**

*   Ensure pattern matching correctly identifies "today" and uses the `referenceDate` to populate components. (Seems to be working, verify consistency).
*   Remove logic related to generating the `normalized` string.

---

### Analysis for Input: "Received confirmation for order #A B C-12345... Delivery expected next Wednesday."

**1. Successfully Processed Date/Time Entities & Components:**

*   None.

**2. Unprocessed/Incorrectly Processed Date/Time Entities & Components:**

*   **`next Wednesday`**:
    *   `original`: "next Wednesday"
    *   `year`: *Missing* (Log shows Chrono implied 2025)
    *   `month`: *Missing* (Log shows Chrono implied 4)
    *   `day`: *Missing* (Log shows Chrono implied 16)
    *   `day_of_week`: *Missing* (Log shows Chrono known 3)
    *   `normalized`: `null` (Log message: "Date components incomplete; normalization skipped.") - **This is incorrect.**
    *   `note`: "Date components incomplete; normalization skipped."

**3. Error Analysis:**

*   Failed identically to "next Friday" and "next Tuesday". The logic incorrectly flagged the relative weekday as uncertain.

**4. Suggestions:**

*   Implement pattern matching for "next Wednesday" using `date-fns.nextWednesday` to calculate components directly.
*   Populate `year`, `month`, `day`, `day_of_week` from the `date-fns` result.
*   Remove the logic block that incorrectly flags this pattern as uncertain.
*   Remove logic related to generating the `normalized` string.

---

### Analysis for Input: "My manager approved the vacation request submitted last week."

**1. Successfully Processed Date/Time Entities & Components:**

*   **`last week`**:
    *   `original`: "last week"
    *   `year`: 2025
    *   `month`: 4
    *   `day`: 4 (**Incorrect** - Day should be uncertain)
    *   `day_of_week`: 5 (**Incorrect** - Should be derived if needed, but main components are Y/M/W)
    *   `normalized`: "2025-04-04" (**Incorrect** - Should be `null`)

**2. Unprocessed/Incorrectly Processed Date/Time Entities & Components:**

*   **`last week`**:
    *   `week_number`: *Missing* - **This is incorrect.** Expected component based on v1.4 plan.
    *   Incorrectly assigned a specific day (`day: 4`) and `normalized` string instead of keeping Day uncertain and `normalized: null`.

**3. Error Analysis:**

*   The logic failed to implement the v1.4 requirement (Step 2.c: Relative Week Resolution) for terms like "last week".
*   It incorrectly resolved to a specific day (possibly start of the week or based on reference dateweekday?).
*   It failed to calculate and store the `week_number`.
*   It incorrectly generated a `normalized` date string.

**4. Suggestions:**

*   Implement pattern matching for "last week".
*   Use `date-fns` (`subWeeks`, `getWeek`, `startOfWeek`) to calculate `year`, `month`, `week_number`.
*   Explicitly set `day = undefined`.
*   Remove logic related to generating the `normalized` string.

---

### Analysis for Input: "Let's schedule the follow-up meeting sometime early next year."

**1. Successfully Processed Date/Time Entities & Components:**

*   **`early next year`**:
    *   `original`: "early next year"
    *   `year`: 2026
    *   `normalized`: `null` (Correct, as Month/Day are uncertain)
    *   `note`: "Date components incomplete; normalization skipped."

**2. Unprocessed/Incorrectly Processed Date/Time Entities & Components:**

*   **`early next year`**:
    *   `month`: *Missing* (Correctly uncertain)
    *   `day`: *Missing* (Correctly uncertain)
    *   The qualifier "early" was stripped (`Cleaned string: ""next year"", Found qualifiers: early`) but not used further, which is acceptable per the plan (ignore qualifiers for core parsing).

**3. Error Analysis:**

*   No errors identified. The parsing correctly identified the year and left month/day uncertain, resulting in `normalized: null`, aligning with the v1.4 plan for year-only references.

**4. Suggestions:**

*   No changes needed. Pattern matching for "next year" should result in Year=2026, Month/Day=undefined. Ensure "early" is correctly ignored.

---

### Analysis for Input: "...proposal submitted by Tech Solutions Inc. last Tuesday was rejected... approval next month."

**1. Successfully Processed Date/Time Entities & Components:**

*   **`next month`**:
    *   `original`: "next month"
    *   `year`: 2025
    *   `month`: 5
    *   `normalized`: `null` (Correct, as Day is uncertain)
    *   `note`: "Date components incomplete; normalization skipped."

**2. Unprocessed/Incorrectly Processed Date/Time Entities & Components:**

*   **`last Tuesday`**:
    *   `original`: "last Tuesday"
    *   `year`: *Missing* (Log shows Chrono implied 2025)
    *   `month`: *Missing* (Log shows Chrono implied 4)
    *   `day`: *Missing* (Log shows Chrono implied 15 - **Wait, Chrono resolved last Tuesday to April 15th?? Reference was April 11th. This Chrono result seems wrong.**)
    *   `day_of_week`: *Missing* (Log shows Chrono known 2)
    *   `normalized`: `null` (Log message: "Date components incomplete; normalization skipped.") - **Incorrect**, should resolve to a specific date.
    *   `note`: "Date components incomplete; normalization skipped."

**3. Error Analysis:**

*   **`last Tuesday`**: Failed identically to other relative weekdays ("next Friday", etc.) due to the incorrect uncertainty check. Additionally, the underlying `chrono.parse` result (`impliedValues: {day: 15, month: 4, year: 2025}`) for "last Tuesday" relative to April 11th seems incorrect; it should likely be April 8th. This points to a potential issue either in `chrono-node` itself or how it's being invoked/configured.
*   **`next month`**: Handled correctly according to the plan (Year/Month identified, Day uncertain, `normalized: null`).

**4. Suggestions:**

*   **`last Tuesday`**: Implement pattern matching for "last Tuesday" using `date-fns.lastTuesday` to get the correct date (2025-04-08) and populate Y/M/D/DoW components.
*   **`next month`**: No changes needed. Pattern matching for "next month" should yield Y/M only.
*   Remove logic related to generating the `normalized` string.

---

I will now update the `learnings/05_test_observations_v1.4.md` file with all these analyses.

## Consolidated Action Plan (REVISED - Pattern-Driven Approach)

Reflecting the user's goal of prioritizing accurate date/time component extraction over `normalized` string generation, and acknowledging the fragility of relying on `chrono-node`'s internal state/components, the `parseDateStringToEnhanced` function in `memory-action.ts` should be refactored according to the following strategy:

**Core Principle:** Use `chrono-node` primarily to *identify* the relevant date/time text segment within the input. Then, use pattern matching on this identified segment (or the original input for boundary cases) to determine the *type* of date phrase, and finally, use `date-fns` directly to calculate the correct components based on that pattern.

**Refactoring Steps:**

1.  **Qualifier Stripping (Keep):** Maintain the initial step of stripping and ignoring the defined list of qualifiers (e.g., "early", "late", "EOD", "first week of") from the input string to get a `cleanedDateString`.

2.  **Date Phrase Identification (Use Chrono):**
    *   Run `chrono.parse(cleanedDateString, ...)`.
    *   **Primary Goal:** Extract `parsedResult.text` – the actual substring Chrono identified as the date (e.g., "next Friday", "August 2025").
    *   Largely **ignore** `parsedResult.start.get(...)` components and certainty flags for driving the main logic flow.

3.  **Pattern Matching & Component Calculation (New Core Logic):**
    *   Implement a series of checks (e.g., `if/else if` using regex or string includes) on the `parsedResult.text` (or `originalString` for boundary cases), **ordered from most specific to least specific patterns**:
        *   **Pattern: Specific Full Dates** (e.g., "April 10, 2025", "2025-04-10", "10 Apr 2025", "Friday 15th April 2025"):
            *   Action: Use `date-fns.parse` (with appropriate format strings). Prioritize these patterns.
            *   Components: `year`, `month`, `day`, `day_of_week`.
        *   **Pattern: Weekday + Day of Month** (e.g., "Friday 15th"):
            *   Action: Identify components, use `referenceDate` to determine context for Month/Year. **Verify Past Date Logic**.
            *   Components: `year`, `month`, `day`, `day_of_week`.
        *   **Pattern: Month + Day Only** (e.g., "April 10", "10th April"):
            *   Action: Identify components, use `referenceDate` for `year`. **Verify Past Date Logic** (ensure recent past dates use current year).
            *   Components: `year`, `month`, `day`, `day_of_week`.
        *   **Pattern: Specific Relative Days** (`tomorrow`, `yesterday`, `today`):
            *   Action: Use `nextFriday(ref)`, `lastTuesday(ref)`, etc. For standalone weekdays ("on Wednesday"), assume *next* instance (document this assumption).
            *   Components: `year`, `month`, `day`, `day_of_week`.
        *   **Pattern: Relative Weekdays** (`/(next|last)\s+(monday|tuesday...)/i`, standalone weekdays e.g., "on Wednesday"):
            *   Action: Use `nextFriday(ref)`, `lastTuesday(ref)`, etc. For standalone weekdays ("on Wednesday"), assume *next* instance (document this assumption).
            *   Components: `year`, `month`, `day`, `day_of_week`.
        *   **Pattern: Relative Weeks** (`/(last|next|this)\s+week/i`):
            *   Action: Use `subWeeks`, `addWeeks`, `getWeek`, `startOfWeek`.
            *   Components: `year`, `month` (of week context), `week_number`. Set `day = undefined`.
        *   **Pattern: Relative Months** (`/(last|next|this)\s+month/i` or standalone month name e.g., "September"):
            *   Action: Use `subMonths`, `addMonths`, `setMonth`.
            *   Components: `year`, `month`. Set `day = undefined`.
        *   **Pattern: Relative Years** (`/(last|next|this)\s+year/i` or standalone year e.g., "2026"):
            *   Action: Use `subYears`, `addYears`, `parseInt`.
            *   Components: `year`. Set `month = undefined`, `day = undefined`.
        *   **Pattern: Day Boundary Terms (check `originalString`)** (`end of day`, `tonight`, `this morning`, `evening`, `afternoon`, `EOD`, `COB`):
            *   Action: Check `originalString`. If found *without* a more specific date pattern being matched, force Y/M/D from `referenceDate` & set `period`. If found *with* a specific date pattern (e.g., "EOD Friday"), prioritize the specific date pattern's Y/M/D, and use the boundary term *only* to set the `period`.
            *   Components: `year`, `month`, `day`, `period`.
        *   **Pattern: Specific Times** (e.g., "3 PM", "15:00", "10:30:15", "noon", "midnight"):
            *   Action: Parse using regex or time parsing logic.
            *   Components: `time_hour`, `time_minute`, `time_second`, `period`. (Combine with date components if date pattern also matched).
        *   **(Add other common patterns like "in 2 days", "3 weeks ago" if desired)**

4.  **Populate Result Object:** Store the components determined reliably in Step 3 into the `EnhancedNormalizedDate` result object. Components not determined remain `undefined`.

5.  **Remove `normalized` String Logic:** Completely remove the final block of code that attempts to format and set the `normalized` ISO string property. This property is no longer needed.

6.  **Refine Interface (Optional):** Consider removing the `normalized?: string | null;` field from the `EnhancedNormalizedDate` interface definition if it's truly unused downstream.

**Outcome:** This revised approach focuses computation on deriving the necessary components directly based on identified patterns, using the reliable calculation functions of `date-fns`, and sidesteps the complexities and potential inaccuracies of interpreting `chrono-node`'s internal state or generating a `normalized` string.
