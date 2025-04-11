# Memory Locker: v1.7 Implementation Task List

**Version:** 1.7
**Date:** 2024-05-17
**Associated Plan:** `learnings/02_enhancement_plan.md` (v1.7)

**Goal:** Implement the v1.7 hybrid date parsing strategy, leveraging upstream GPT normalization for common cases and using targeted Netlify function logic for time extraction and fallbacks.

**Note:** Mark tasks as complete by changing `[ ]` to `[x]` as you progress through the implementation.

---

## Task List

**Phase 1: Upstream Configuration Updates**

1.  **[ ] Update Custom GPT Instructions (`learnings/02_gpt_instructions.md`):**
    *   Modify the instructions for date entity extraction.
    *   Specifically instruct the GPT: "When you extract a date expression, if you can reliably normalize it to a specific date (like 'today' -> '2024-05-17', 'next Tuesday' -> '2024-05-21', 'last spring' -> '2024-03-01', 'first week of May 2025' -> '2025-05-01' etc., based on the current date), provide the result as a JSON object containing both the original text and the normalized date in `YYYY-MM-DD` format: `{"original": "...", "normalized": "YYYY-MM-DD"}`. Use the *start date* for ranges like weeks or seasons. If you cannot reliably normalize it (e.g., complex strings with specific times like 'April 28th, 2025, from 2:00 AM to 4:00 AM UTC'), provide only the original extracted string."
    *   *(Self-Correction Note: Ensure GPT provides only the date part, as time extraction is handled by Netlify)*

2.  **[ ] Update OpenAPI Schema (`openapi.json`):**
    *   Navigate to the `components.schemas.ExtractedEntities.properties.dates.items` definition.
    *   Change its type definition to accept *either* a `string` *or* an `object` using `oneOf`:
        ```json
        "items": {
          "oneOf": [
            { "type": "string" },
            {
              "type": "object",
              "properties": {
                "original": { "type": "string" },
                "normalized": { 
                  "type": "string", 
                  "format": "date" // YYYY-MM-DD
                }
              },
              "required": ["original"]
            }
          ]
        }
        ```
    *   Navigate to `components.schemas.EnhancedNormalizedDate` (used in the *response* `ContextObject`).
    *   Ensure the `properties` include: `year` (integer), `month` (integer), `day` (integer), `day_of_week` (integer, optional), `week_number` (integer, optional), `period` (string, optional, e.g., "Morning", "Afternoon"), `time_hour` (integer, optional), `time_minute` (integer, optional), `time_second` (integer, optional).
    *   **Remove** the `original` property from this response schema definition.
    *   **Remove** the `note` property from this response schema definition.
    *   Validate the updated `openapi.json` schema.

**Phase 2: Netlify Function (`memory-action.ts`) Implementation**

3.  **[ ] Update TypeScript Interfaces:**
    *   Define `InputDateEntity` type alias: `export type InputDateEntity = string | { original: string; normalized?: string; };`
    *   Refine `EnhancedNormalizedDate` interface:
        ```typescript
        export interface EnhancedNormalizedDate {
          year?: number;
          month?: number; // 1-12
          day?: number;
          day_of_week?: number; // 0-6 or 1-7, decide and be consistent
          week_number?: number; 
          period?: 'Morning' | 'Afternoon' | 'Evening' | 'Night'; // Or more specific if needed
          time_hour?: number; // 0-23
          time_minute?: number;
          time_second?: number;
          // Add is_normalized?: boolean; // Optional flag for easier debugging?
          // Add is_fallback?: boolean; // Optional flag for easier debugging?
        }
        ```
    *   Update `ContextObject` interface to use the new `EnhancedNormalizedDate`.
    *   Ensure `ScoredContextObject`, `SearchResultItem`, `FallbackResultItem` interfaces are present as per v1.3 needs for re-ranking.

4.  **[ ] Refactor Main Date Processing Loop (`store`/`combined` handler):**
    *   Locate the loop iterating through `payload.entities.dates`.
    *   Modify the loop variable type to `InputDateEntity`.
    *   Inside the loop, initialize `parsedComponents: Partial<EnhancedNormalizedDate> = {};` and `let originalString: string;`.
    *   Implement `if/else` block:
        ```typescript
        if (typeof dateEntity === 'string') {
          originalString = dateEntity;
          // Call fallback parser ONLY for the date part initially
          const fallbackDateParts = handleFallbackParsing(originalString, referenceDate); 
          // Always try to extract time separately
          const timeParts = extractTimeInfo(originalString);
          parsedComponents = { ...fallbackDateParts, ...timeParts };
        } else { // It's an object { original: string; normalized?: string }
          originalString = dateEntity.original;
          if (dateEntity.normalized) {
            // Parse the reliable normalized date
            const normalizedDateParts = parseNormalizedDate(dateEntity.normalized, referenceDate); 
            // Always try to extract time separately from original string
            const timeParts = extractTimeInfo(originalString);
            parsedComponents = { ...normalizedDateParts, ...timeParts };
          } else {
            // GPT provided object but couldn't normalize - use fallback for date
             const fallbackDateParts = handleFallbackParsing(originalString, referenceDate);
             const timeParts = extractTimeInfo(originalString);
             parsedComponents = { ...fallbackDateParts, ...timeParts };
          }
        }
        ```
    *   Implement **Validation & Storage Logic**:
        *   After the `if/else` block, check if `parsedComponents` contains essential date information (e.g., `parsedComponents.year && parsedComponents.month`).
        *   If valid, add `parsedComponents` to the `processedMetadata.dates` array.
        *   Log a warning if parsing completely failed and the object is empty/invalid.
        *   Ensure the `original` field is *not* included in the object added to `processedMetadata.dates`.

5.  **[ ] Implement `parseNormalizedDate` Function:**
    *   Signature: `function parseNormalizedDate(normalizedDate: string, referenceDate: Date): Partial<EnhancedNormalizedDate>`
    *   Use `dateFns.parse(normalizedDate, 'yyyy-MM-dd', referenceDate)` // Pass referenceDate here.
    *   Extract `year`, `month` (add 1 for 1-12), `day`.
    *   Use `dateFns.getDay` for `day_of_week` (check locale consistency, e.g., 0=Sun).
    *   Use `dateFns.getWeek` for `week_number` (check options for week start day).
    *   **Implement Past Date Check:** (Defensive check, as YYYY-MM-DD is explicit) If logic were applied to Month/Day, use `dateFns.isBefore(parsedDate, dateFns.startOfDay(referenceDate))` to check if the parsed date is strictly before the reference date. If so, use `referenceDate`'s year.
    *   Return the partial `EnhancedNormalizedDate` object with only date components.

6.  **[ ] Implement `extractTimeInfo` Function:**
    *   Signature: `function extractTimeInfo(originalString: string): Partial<EnhancedNormalizedDate>`
    *   Use Regex first for common patterns:
        *   `/\b(\d{1,2}:\d{2}(?::\d{2})?)\s?(am|pm)\b/i`: Extract HH:MM(:SS) and AM/PM. Convert hour to 24hr format, set `period`.
        *   `/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/`: Extract HH:MM(:SS) (assume 24hr if no AM/PM).
        *   `/\b(morning)\b/i`: Set `period: 'Morning'`.
        *   `/\b(afternoon)\b/i`: Set `period: 'Afternoon'`.
        *   `/\b(evening|tonight)\b/i`: Set `period: 'Evening'`.
        *   `/\b(night|midnight)\b/i`: Set `period: 'Night'`. (Handle midnight time?).
        *   `/\b(eod|end of day|cob)\b/i`: Set `period: 'Evening'` (or a specific time?).
    *   Consider using `chrono-node` on `originalString` as a secondary step if regex fails, but *only* extract time components (`parsedResult.start.get('hour')`, `get('minute')` etc.) if found. Be cautious of `chrono` inferring dates.
    *   Return the partial `EnhancedNormalizedDate` object containing *only* time components (`period`, `time_hour`, `time_minute`, `time_second`).

7.  **[ ] Implement `handleFallbackParsing` Function:**
    *   Signature: `function handleFallbackParsing(originalString: string, referenceDate: Date): Partial<EnhancedNormalizedDate>`
    *   **Goal:** Handle cases GPT *didn't* normalize (e.g., `"next Friday"`, `"Tuesday afternoon"`, `"April 28th, 2025, from 2:00 AM to 4:00 AM UTC"`). This is a **minor fallback**.
    *   **Approach:** Start with the simplified v1.6 pattern-matching logic.
        *   Attempt to parse specific full dates (strip time/timezone first if possible).
        *   Attempt to parse relative weekdays (`next Friday`, `Monday`). Use `dateFns` `nextMonday`, `previousTuesday` etc.
        *   Attempt other patterns *not* expected to be normalized by GPT (e.g., "3 weeks ago").
    *   **Do NOT** duplicate logic already handled by `parseNormalizedDate` or `extractTimeInfo`. This function focuses on getting the core *date* when normalization failed.
    *   **Crucially:** Call `extractTimeInfo(originalString)` internally and merge its results.
    *   Return the partial `EnhancedNormalizedDate` object.

**Phase 3: Querying & Cleanup**

8.  **[ ] Update Query Date Parsing (`query`/`combined` modes):**
    *   Locate where `queryMetadata.dates` (dates extracted from the user's *query*) are processed before being used in `rerankResults`.
    *   Apply a suitable parsing logic to convert these query date strings into the `EnhancedNormalizedDate` component structure. This likely involves calling `handleFallbackParsing` as query dates might be complex natural language.
    *   Ensure the output structure matches the one used for stored dates.

9.  **[ ] Verify `rerankResults` Logic:**
    *   Confirm that the component field names used in the hierarchical date matching and past date boost logic within `rerankResults` exactly match the fields populated by `parseNormalizedDate`, `extractTimeInfo`, and `handleFallbackParsing`.

10. **[ ] Discuss Re-ranking Weights (Post-Implementation):**
    *   Note: With more reliable date components, the date-based boosting (+0.05/+0.03/+0.01 for Day/Month/Year match, +0.10 for past date FTS) becomes more impactful.
    *   Task: After implementation and testing, re-evaluate if these boost values are appropriate or if they need adjustment relative to the `initial_score` (similarity/rank) and other metadata boosts. No changes planned initially.

11. **[ ] Code Cleanup:**
    *   Remove any obsolete helper functions, constants, or comments related to previous date parsing attempts (v1.4, v1.5, v1.6 specific logic replaced by v1.7 structure).
    *   Remove the old `parseDateStringToEnhanced` function if it's fully replaced by the new structure.

**Phase 4: Testing**

12. **[ ] Update Test Cases:**
    *   Create new test cases (`testing/v1.7-test-cases.csv`?) covering:
        *   Inputs expected to be normalized by GPT (verify `normalized` field is used).
        *   Inputs with time elements (verify `extractTimeInfo` works correctly alongside normalized dates).
        *   Inputs expected to *fail* GPT normalization and hit the fallback logic (verify `handleFallbackParsing` handles them acceptably).
        *   Queries involving dates to test `rerankResults` with the new component structure.
13. **[ ] Execute Tests & Analyze Results:** Run tests, check Netlify logs, verify stored metadata in Supabase.

--- 