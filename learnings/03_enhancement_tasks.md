# Memory Locker: v1.7 Implementation Task List

**Version:** 1.7
**Associated Plan:** `learnings/02_enhancement_plan.md` (v1.7 - Revised)

**Goal:** Implement the v1.7 hybrid date parsing strategy, leveraging upstream GPT normalization to `"Month DD, YYYY"` format and using targeted Netlify function logic (`parseNormalizedDate`, `extractTimeInfo`, `parseOriginalStringDate`).

**Note:** Mark tasks as complete by changing `[ ]` to `[x]` as you progress through the implementation. Ensure all code comments and documentation align with this v1.7 plan, removing references to older versions/approaches.

---

## Task List

**Phase 1: Upstream Configuration Updates**

1.  **[x] Update Custom GPT Instructions (`learnings/02_gpt_instructions.md`):**
    *   Modify the instructions for date entity extraction.
    *   Specifically instruct the GPT: "When you extract a date expression, if you can reliably normalize it to a specific date (like 'today' -> 'May 17, 2024', 'next Tuesday' -> 'May 21, 2024', 'last spring' -> 'March 01, 2024', 'first week of May 2025' -> 'May 01, 2025' etc., based on the current date), provide the result as a JSON object containing both the original text and the normalized date in `"Month DD, YYYY"` format: `{"original": "...", "normalized": "Month DD, YYYY"}`. Use the *start date* for ranges like weeks or seasons. If you cannot reliably normalize it (e.g., complex strings with specific times like 'April 28th, 2025, from 2:00 AM to 4:00 AM UTC'), provide only the original extracted string."
    *   Verify examples match the target format.

2.  **[x] Update OpenAPI Schema (`openapi.json`):**
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
                  "type": "string" // Represents "Month DD, YYYY" format
                  // Do NOT use "format": "date"
                }
              },
              "required": ["original"]
            }
          ]
        }
        ```
    *   Navigate to `components.schemas.EnhancedNormalizedDate` (used in the *response* `ContextObject`).
    *   Ensure the `properties` include: `year` (integer), `month` (integer, 1-12), `day` (integer), `day_of_week` (integer, 0-6), `week_number` (integer, optional), `period` (string, optional, e.g., "Morning", "Afternoon"), `time_hour` (integer, optional), `time_minute` (integer, optional), `time_second` (integer, optional).
    *   **Remove** the `original` property from this response schema definition.
    *   **Remove** the `note` property from this response schema definition.
    *   Validate the updated `openapi.json` schema.

**Phase 2: Netlify Function (`memory-action.ts`) Implementation**

3.  **[x] Update TypeScript Interfaces:**
    *   Define `InputDateEntity` type alias: `export type InputDateEntity = string | { original: string; normalized?: string; };`
    *   Refine `EnhancedNormalizedDate` interface:
        ```typescript
        export interface EnhancedNormalizedDate {
          year?: number;
          month?: number; // 1-12
          day?: number;
          day_of_week?: number; // 0-6 (Sun-Sat)
          week_number?: number;
          period?: 'Morning' | 'Afternoon' | 'Evening' | 'Night'; // Or more specific if needed
          time_hour?: number; // 0-23
          time_minute?: number;
          time_second?: number;
          // is_normalized?: boolean; // Optional flag?
        }
        ```
    *   Update `ContextObject` interface to use the new `EnhancedNormalizedDate`.
    *   Ensure `ScoredContextObject`, `SearchResultItem`, `FallbackResultItem` interfaces are present as per v1.3 needs for re-ranking.

4.  **[x] Refactor Main Date Processing Loop (`store`/`combined` handler):**
    *   Locate the loop iterating through `payload.entities.dates`.
    *   Modify the loop variable type to `InputDateEntity`.
    *   Inside the loop, initialize `parsedComponents: Partial<EnhancedNormalizedDate> = {};`, `let originalString: string;`, `let datePart: Partial<EnhancedNormalizedDate> = {};`.
    *   Implement `if/else` block:
        ```typescript
        if (typeof dateEntity === 'string') {
          originalString = dateEntity;
          datePart = parseOriginalStringDate(originalString, referenceDate); // Use new fallback parser
        } else { // It's an object { original: string; normalized?: string }
          originalString = dateEntity.original;
          if (dateEntity.normalized) {
            // Parse the reliable normalized date ("Month DD, YYYY")
            datePart = parseNormalizedDate(dateEntity.normalized, referenceDate);
          } else {
            // GPT provided object but couldn't normalize - use new fallback parser
             datePart = parseOriginalStringDate(originalString, referenceDate);
          }
        }
        // Always try to extract time separately from original string
        const timeParts = extractTimeInfo(originalString);
        parsedComponents = { ...datePart, ...timeParts }; // Combine date and time parts
        ```
    *   Implement **Validation & Storage Logic**:
        *   After combining parts, check if `parsedComponents` contains essential date information (e.g., `parsedComponents.year && parsedComponents.month`) or time information.
        *   If valid, add `parsedComponents` to the `processedMetadata.dates` array.
        *   Log a warning if parsing failed to yield core date/time info.
        *   Ensure the `original` field is *not* included in the object added to `processedMetadata.dates`.

5.  **[x] Implement `parseNormalizedDate` Function:**
    *   Signature: `function parseNormalizedDate(normalizedDateString: string, referenceDate: Date): Partial<EnhancedNormalizedDate>`
    *   Use `dateFns.parse(normalizedDateString, 'MMMM d, yyyy', referenceDate)`. Handle variations like 'MMMM dd, yyyy'. Add error handling.
    *   Extract `year`, `month` (1-12), `day`, `day_of_week` (0=Sun), `week_number`.
    *   Return the partial `EnhancedNormalizedDate` object with *only date* components.

6.  **[x] Implement `extractTimeInfo` Function:**
    *   Signature: `function extractTimeInfo(originalString: string): Partial<EnhancedNormalizedDate>`
    *   Use Regex first for common time patterns (HH:MM AM/PM, HH:MM 24hr) and periods. Convert to 24hr, set `period`.
    *   Optionally, use `chrono-node` on `originalString` *only if regex fails* as a secondary check. Extract *only time* components. Discard inferred date parts.
    *   Return the partial `EnhancedNormalizedDate` object containing *only* time components.

7.  **[x] Implement `parseOriginalStringDate` Function (New):**
    *   Signature: `function parseOriginalStringDate(originalString: string, referenceDate: Date): Partial<EnhancedNormalizedDate>`
    *   Use ONLY `date-fns.parse`. Try common, unambiguous formats ('MM/dd/yyyy', 'yyyy-MM-dd', 'MMMM d, yyyy', etc.). Do **NOT** use `chrono-node`.
    *   If `dateFns.parse` succeeds: Extract `year`, `month` (1-12), `day`, `day_of_week` (0-6), `week_number`. Return partial object.
    *   If all attempts fail: Return `{}`.

**Phase 3: Querying & Cleanup**

8.  **[x] Update Query Date Parsing (`query`/`combined` modes):**
    *   Ensure that the date processing logic applied upfront (before mode checking) correctly populates `processedMetadata.dates` which is then used by `rerankResults`.
    *   The `queryMetadata` variable correctly references this shared `processedMetadata`.

9.  **[x] Verify `rerankResults` Logic:**
    *   Confirm that the component field names used in hierarchical date matching (`year`, `month`, `day`, `period`) within `rerankResults` exactly match the fields populated by the v1.7 parsing functions.

10. **[ ] Review Re-ranking Weights (Post-Implementation):**
    *   Task: After implementation and testing, re-evaluate if the existing boost values for date matching are appropriate given the potentially more reliable components. No changes planned initially.

11. **[x] Code Cleanup:**
    *   Forensically remove *all* obsolete helper functions (e.g., old `parseDateStringToEnhanced`), constants, code comments, and documentation references related to previous date parsing attempts (v1.4-v1.6 specific logic, old fallback logic, YYYY-MM-DD format assumptions). Ensure a clean v1.7 implementation.

**Phase 4: Testing**

12. **[ ] Update/Create Test Cases:**
    *   Create/update test cases (`testing/v1.7-date-tests.csv`?) covering:
        *   Inputs normalized by GPT (e.g., `"April 11, 2025"`, `"June 01, 2024"`) -> Verify `parseNormalizedDate`.
        *   Inputs with time elements (e.g., `"tomorrow morning"`, `"June 5, 2025 3pm"`) -> Verify `extractTimeInfo` works with date part.
        *   Inputs *not* normalized by GPT but parseable by `date-fns` (e.g., `"05/25/2024"`, `"2024-12-31"`) -> Verify `parseOriginalStringDate`.
        *   Inputs *not* normalized and *not* easily parseable (e.g., `"next weekend"`, `"around noon Tuesday"`) -> Verify they gracefully fail date parsing but might still yield time info from `extractTimeInfo`.
        *   Queries involving dates to test `rerankResults` with the new component structure.
13. **[ ] Execute Tests & Analyze Results:** Run tests, check Netlify function logs, verify stored metadata components in Supabase are correct (year, month, day, period, time_hour etc. stored correctly, no `original` field).

---