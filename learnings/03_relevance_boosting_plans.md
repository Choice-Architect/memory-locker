# Relevance Boosting Plan (Post-Retrieval with Simplified Fallback) - v1.2

**Date:** 2025-04-10

**Goal:** Implement an application-layer relevance re-ranking mechanism within the Netlify function (`memory-action.ts`) to improve the final relevance of query results. This re-ranking leverages stored JSONB metadata (including `EnhancedNormalizedDate` components) and applies *after* an initial broad retrieval. This plan operates within a revised query strategy: **Vector Search -> FTS Fallback (with conditional date filtering) -> Re-ranking**.

**Summary of Changes from Previous Plan (v1.1):**
*   Eliminated the separate "Metadata Fallback" query tier.
*   The sole fallback mechanism after Vector Search is now Full-Text Search (FTS).
*   Incorporated conditional `created_at` filtering into the FTS fallback step, executed only when the user query implies a specific, usable past date range.
*   Adopted purely additive scoring (`final_score = initial_score + metadata_boost_score`).
*   Standardized metadata boost increments to `+ 0.05`.

---

## Core Idea: Post-Retrieval Re-ranking (Application Layer)

Retrieve an initial set of candidates from the database using either **Vector Search** (primary) or **FTS Fallback** (if vector search yields no results). Then, within the Netlify function (`memory-action.ts`), calculate a "metadata boost score" for each candidate by comparing its stored metadata with the query's metadata. Combine this boost score with the candidate's initial retrieval score using a simple additive method to calculate a final relevance score. Finally, sort the candidates by this final score and return the top K results.

## Implementation Steps:

1.  **Modify Fallback Logic (`memory-action.ts` Handler):**
    *   **Action:** Restructure the `query`/`combined` mode logic.
        *   Remove the entire code block responsible for the previous "Metadata Search Fallback".
        *   Modify the existing FTS fallback block (now the sole fallback):
            *   **Conditional Date Filtering Implementation:** *Before* executing the FTS query:
                *   Implement TypeScript logic to analyze `queryMetadata.dates` (containing `EnhancedNormalizedDate[]`).
                *   Determine if these dates represent a specific, usable past time range (e.g., "last week" -> start/end dates; "April 2024" -> start/end dates; "tomorrow" -> unusable; "Tuesday" -> likely unusable/ambiguous).
                *   If a usable date range (`startDate`, `endDate`) is derived, add `.gte('created_at', startDate)` and `.lte('created_at', endDate)` clauses to the Supabase query builder for the FTS query targeting the `files` table.
            *   Execute the potentially date-filtered FTS query against `transcript_tsv`.
    *   **Rationale:** Implements the simplified Vector -> FTS fallback path and correctly handles time-sensitive queries using the indexed `created_at` column when appropriate during the FTS fallback.

2.  **Constants Adjustment:**
    *   **File:** `memory-action.ts`
    *   **Action:** Update constants:
        *   `VECTOR_MATCH_COUNT = 15`
        *   `FALLBACK_MATCH_COUNT = 20` (Applies to FTS)
        *   `FINAL_MATCH_COUNT = 5` (Number of results to return after re-ranking)
    *   **Rationale:** Provide a larger pool for re-ranking and define the final output size.

3.  **Ensure Initial Score & Metadata Availability:**
    *   **File:** `memory-action.ts`
    *   **Action:** Verify retrieval paths (Vector RPC, FTS Fallback) provide:
        *   Full `metadata` JSONB blob.
        *   Initial relevance score indicator: `similarity` (Vector), `rank` (FTS).
    *   **Interface Update (Internal):** Use an internal interface like `ScoredContextObject` within the re-ranking function to hold scores temporarily, keeping the external `ContextObject` unchanged for now.
        ```typescript
        interface ScoredContextObject extends ContextObject {
            initial_score: number; // Normalized initial score (0-1)
            metadata_boost_score: number; // Calculated boost
            final_score: number;  // Score after boost
        }
        ```

4.  **Implement Re-ranking Function:**
    *   **File:** `memory-action.ts`
    *   **Action:** Create a new asynchronous function:
        ```typescript
        async function rerankResults(
            candidates: ContextObject[],
            queryMetadata: ProcessedEntities,
            query_source: Extract<SuccessResponse['query_source'], 'vector_store' | 'postgres_fallback_text'>
        ): Promise<ContextObject[]> {
            // ... implementation ...
        }
        ```
    *   **Input:** List of `candidates`, `queryMetadata`, `query_source`.
    *   **Output:** *New* list of `ContextObject`s, sorted by `final_score`, trimmed to `FINAL_MATCH_COUNT`.

5.  **Implement Scoring Logic within `rerankResults`:**
    *   **File:** `memory-action.ts` (inside `rerankResults` function)
    *   **Action:** Iterate through each `candidate`, map to `ScoredContextObject`, and calculate scores:
        *   **a. Determine Normalized Initial Score (`initial_score` 0-1 range):**
            *   If `query_source === 'vector_store'`: Use `similarity` directly.
            *   If `query_source === 'postgres_fallback_text'`: Assign fixed base score: `initial_score = 0.5`. (Ignores FTS `rank` for simplicity).
        *   **b. Calculate `metadata_boost_score`:**
            *   Initialize `metadata_boost_score = 0.0`.
            *   **Helper:** Use `checkOverlap(arr1?: any[], arr2?: any[]): boolean`.
            *   **Apply Boosts (All increments = 0.05):**
                ```typescript
                const candidateMeta = candidate.entities_in_chunk;
                if (checkOverlap(candidateMeta?.people, queryMetadata?.people)) { metadata_boost_score += 0.05; }
                if (checkOverlap(candidateMeta?.locations, queryMetadata?.locations)) { metadata_boost_score += 0.05; }
                if (checkOverlap(candidateMeta?.topics, queryMetadata?.topics)) { metadata_boost_score += 0.05; }
                if (queryMetadata?.type && candidateMeta?.type === queryMetadata.type) { metadata_boost_score += 0.05; }
                if (queryMetadata?.sentiment && candidateMeta?.sentiment === queryMetadata.sentiment) { metadata_boost_score += 0.05; }
                if (queryMetadata?.dates && queryMetadata.dates.length > 0 && candidateMeta?.dates && candidateMeta.dates.length > 0) { metadata_boost_score += 0.05; }
                // Future: Consider boost based on created_at proximity.
                ```
        *   **c. Calculate `final_score` (Purely Additive):**
            *   `final_score = initial_score + metadata_boost_score;`
        *   **d. Store Scores:** Populate fields in the `ScoredContextObject`.

6.  **Sort and Trim Results within `rerankResults`:**
    *   **File:** `memory-action.ts` (end of `rerankResults` function)
    *   **Action:**
        *   Sort `ScoredContextObject`s by `final_score` (descending).
        *   Slice to keep top `FINAL_MATCH_COUNT` results.
        *   Map back to `ContextObject[]` (excluding temporary scores) before returning.

7.  **Integrate `rerankResults` Call:**
    *   **File:** `memory-action.ts` (in the main `handler` function)
    *   **Action:** Call `rerankResults` *after* initial retrieval populates `retrieved_context` and *before* constructing `SuccessResponse`. Pass the correct `query_source`.

## Pros & Cons:

**Pros:**
*   Flexible metadata comparison logic in TypeScript.
*   Application-layer changes primarily; leverages existing DB indexes.
*   Clear separation between initial retrieval and nuanced ranking.
*   Simplified fallback flow (Vector -> FTS).
*   Correctly handles time queries via conditional `created_at` filtering.

**Cons:**
*   Adds re-ranking complexity/latency to the Netlify function.
*   Fetches more data initially than ultimately returned.
*   Tuning of boost increments might be needed after testing.

## Development Tasks:

1.  Implement conditional date range analysis and `created_at` filter logic in `memory-action.ts`.
2.  Implement the `rerankResults` function with the specified scoring logic.
3.  Integrate the `rerankResults` call into the main handler.
4.  Update constants (`VECTOR_MATCH_COUNT`, `FALLBACK_MATCH_COUNT`, `FINAL_MATCH_COUNT`).
5.  Thorough testing of vector search, FTS fallback (with and without date filtering), and re-ranking behavior.

---