# Implementation Plan: Query Retrieval & Re-ranking Refactor (v1.8 - Revised Post-Testing)

**Goal:** Implement the revised query retrieval and re-ranking strategy outlined in `learnings/03_fixes.md`. This involves instructing the GPT to handle combined intents via sequential calls, removing the `combined` mode from the middleware, broadening initial database searches (Vector & FTS), and using metadata exclusively for augmenting relevance during re-ranking within the Netlify function (including stemming).

**Reference:** `learnings/03_fixes.md` (Final Plan section)

---

**Prerequisites:**

*   **Verify Supabase Functions:** Before starting code changes, manually verify currently deployed versions of `search_memory_chunks` and `fts_search_files`.

---

**Implementation Tasks (Logical Order):**

**Phase 1: Upstream Intent Handling & Schema Adjustment**

1.  **Task 1.1: Update GPT Instructions (`gpt_instructions.md`)**
    *   **Action:** Remove all references to the `combined` mode.
    *   **Action:** Add explicit instructions for handling user messages with both storage and query intent:
        *   Recognize the dual intent.
        *   First, identify storage-only text/entities and make a `mode: 'store'` call.
        *   Second, identify query-only text/entities and make a `mode: 'query'` call.
        *   Wait for both responses, then synthesize a single, coherent response for the user.
    *   **Action:** Update examples accordingly.

2.  **Task 1.2: Update OpenAPI Schema (`openapi.json`)**
    *   **Action:** Edit the `RequestPayload` schema.
    *   Remove `"combined"` from the `enum` for the `mode` property.

**Phase 2: Database Function Simplification**

3.  **Task 2.1: Modify `search_memory_chunks` (`sql/schema.sql`)**
    *   **Action:** Edit the `CREATE OR REPLACE FUNCTION public.search_memory_chunks` definition.
    *   Remove metadata filter parameters (`filter_topics`, `filter_people`, `filter_locations`, `filter_type`, `filter_sentiment`).
    *   Remove corresponding `AND` clauses. `WHERE` clause should only contain the vector similarity check.
    *   Save changes.

4.  **Task 2.2: Modify `fts_search_files` (`sql/schema.sql`)**
    *   **Action:** Edit the `CREATE OR REPLACE FUNCTION public.fts_search_files` definition.
    *   Ensure `WHERE` clause only contains the FTS match condition (`f.transcript_tsv @@ websearch_to_tsquery(...)`).
    *   Remove any other filtering logic.
    *   Save changes.

5.  **Task 2.3: Deploy SQL Changes (Manual Supabase Action - *User Assistance Needed*)**
    *   **Action:** Connect to Supabase DB and execute the modified `CREATE OR REPLACE FUNCTION...` statements for both functions from the updated `sql/schema.sql`.
    *   **Verification:** Confirm deployed functions reflect the simplified logic.

**Phase 3: Middleware Refactoring (`netlify/functions/memory-action/memory-action.ts`)**

6.  **Task 3.1: Update `executeVectorSearch` Call**
    *   **Action:** Remove arguments corresponding to the removed metadata filter parameters in the `supabase.rpc('search_memory_chunks', ...)` call.

7.  **Task 3.2: Update `executeFtsSearch` Call**
    *   **Action:** Change the `query_string` argument in the `supabase.rpc('fts_search_files', ...)` call to use `payload.query_text`.

8.  **Task 3.3: Implement Stemming Logic in `rerankResults`**
    *   **Action:** Before metadata overlap checks (people, locations, topics):
        *   Define/use helper logic to stem words within entity strings for both query and candidate metadata.
        *   Store these stemmed representations (e.g., sets of stemmed words).

9.  **Task 3.4: Refactor Re-ranking Boosts for Stemmed Overlap**
    *   **Action:** Modify `metadata_boost_score` calculation in `rerankResults`.
    *   Compare stemmed representations (from Task 3.3) for people, locations, topics. Apply `ENTITY_WEIGHTS` boost on intersection.
    *   Keep date component logic as is.

10. **Task 3.5: Remove `combined` Mode Logic**
    *   **Action:** Delete any conditional logic (`if`/`else if`) specifically checking for or handling `payload.mode === 'combined'` within the main handler. The code structure should now only need to handle `store` and `query` modes distinctly.

11. **Task 3.6: Implement Enhanced Logging**
    *   **Action:** Add detailed `console.log` statements (as outlined in `learnings/03_fixes.md`, Plan Item 7) throughout the query/re-ranking process.

**Phase 4: Documentation & Testing**

12. **Task 4.1: Update Documentation (`learnings/*.md`)**
    *   **Action:** Review all learning files (`01`, `02`, `03`, `04`) to ensure consistency with this implemented plan.
    *   Add commit hash(es) to `03_fixes.md`.

13. **Task 4.2: Testing**
    *   **Action:** Perform comprehensive testing (direct API & Custom GPT) focusing on previous failure points and the new sequential call logic for combined intents.
    *   Review Netlify logs.

14. **Task 4.3: Analysis & Tuning**
    *   **Action:** Analyze results and logs. Tune constants (`VECTOR_MATCH_THRESHOLD`, `_MATCH_COUNT`, `RRF_K`, `ENTITY_WEIGHTS`) iteratively.

---

**DRY Principles & Maintainability:**

*   Delegating intent splitting to GPT simplifies middleware.
*   Simplifying SQL functions improves database maintainability.
*   Consolidating augmentation logic (stemming, boosting) in `rerankResults` keeps middleware logic focused.
*   Enhanced logging is key for future maintainability and tuning. 