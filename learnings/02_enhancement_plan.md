# Memory Locker: Enhancement Implementation Plan v1.3

**Version:** 1.3 (Revised)

**Goal:** Implement the revised query and relevance enhancement strategy (v1.3) within the `memory-action.ts` Netlify function. This involves simplifying the fallback mechanism and implementing application-layer relevance re-ranking that incorporates FTS rank scores, vector similarity scores, and dynamic date range boosting.

**Summary of Approach:**
The query logic will follow this sequence:
1.  **Primary Retrieval:** Attempt Vector Search using the `search_memory_chunks` RPC, retrieving `VECTOR_MATCH_COUNT` candidates. Assume the RPC returns a `similarity` score.
2.  **Fallback Retrieval:** If Vector Search yields no results or fails, perform an FTS query against the `files` table using relevant query entities (excluding language), retrieving `FALLBACK_MATCH_COUNT` candidates. Ensure the query selects the `ts_rank_cd` score aliased as `rank`.
3.  **Mapping & Truncation:** Map results from Step 1 or 2 to `ContextObject`s.
    *   For FTS results, truncate the `transcript_text` to 3000 characters when placing it in the `chunk` field.
    *   Ensure `similarity` (from vector) and `rank` (from FTS) scores are preserved during mapping (e.g., by adding optional fields to `ContextObject`).
4.  **Re-ranking:** Take the candidates retrieved and mapped from Step 1 or 2, calculate a `final_score` based on the initial score (`similarity` or `rank`) plus a `metadata_boost_score` (additive score based on metadata overlap and date range matching, excluding language), sort by `final_score`, and return the top `FINAL_MATCH_COUNT` results.

---

## Implementation Steps (`memory-action.ts`)

The following steps detail the required modifications within the `netlify/functions/memory-action/memory-action.ts` file.

**0. Prerequisite: Confirm Supabase Setup:**
    *   Before modifying the TypeScript code, confirm the following in your Supabase project:
        *   The `search_memory_chunks` RPC function returns the `similarity` score alongside other chunk data.
        *   The `files` table allows selecting `ts_rank_cd(...)` aliased as `rank` in FTS queries.
    *   *(Modify Supabase SQL if necessary, outside the scope of this specific TypeScript plan)*

**1. Update Retrieval Constants:**
    *   Adjust constants controlling the number of results fetched and returned:
        ```typescript
        const VECTOR_MATCH_COUNT = 15;
        const FALLBACK_MATCH_COUNT = 20;
        const FINAL_MATCH_COUNT = 5;
        ```

**2. Update TypeScript Interfaces:**
    *   Add `similarity?: number;` to `SearchResultItem`.
    *   Add `rank?: number;` to `FallbackResultItem`.
    *   Add `similarity?: number;` and `rank?: number;` to `ContextObject`.
    *   Define the `ScoredContextObject` interface extending `ContextObject` with `initial_score`, `metadata_boost_score`, and `final_score`.

**3. Modify FTS Query Logic (`query`/`combined` modes):**
    *   Ensure the FTS fallback query (`ftsQueryBuilder`):
        *   Constructs the `ftsQueryString` using entity values from `queryMetadata` *excluding* the `language` entity.
        *   Selects the FTS rank: `.select('..., rank:ts_rank_cd(transcript_tsv, to_tsquery(\'english\', $1))')`.
        *   Does **not** include pre-filtering based on `deriveDateRange`.
        *   Uses `{ config: 'english' }` in `.textSearch`.

**4. Modify Result Mapping Logic:**
    *   **Vector Search Mapping:**
        *   When mapping `SearchResultItem` to `ContextObject`, include `similarity: result.similarity`.
    *   **FTS Fallback Mapping:**
        *   When mapping `FallbackResultItem` to `ContextObject`:
            *   Include `rank: file.rank`.
            *   Truncate the chunk: `chunk: file.transcript_text.substring(0, 3000) + (file.transcript_text.length > 3000 ? '...' : '')`.

**5. Implement/Enhance Helper Functions:**
    *   Ensure `checkOverlap(arr1?: any[], arr2?: any[]): boolean` is present and handles case-insensitivity for strings.
    *   Ensure `deriveDateRange(dates: EnhancedNormalizedDate[]): { startDate: string; endDate: string } | null` is present (it's needed for re-ranking now).

**6. Enhance `rerankResults` Function:**
    *   **Signature:** Remains the same.
    *   **Internal Logic:**
        *   **a. Map to Scored Objects:** Iterate through `candidates` (`ContextObject[]`) and map each to a `ScoredContextObject`.
        *   **b. Calculate `initial_score`:**
            *   If `query_source === 'vector_store'`, use `initial_score = candidate.similarity ?? 0;`.
            *   If `query_source === 'postgres_fallback_text'`, use `initial_score = candidate.rank ?? 0;`.
        *   **c. Calculate `metadata_boost_score`:**
            *   Initialize `metadata_boost_score = 0.0`.
            *   Apply additive boosts (`+= 0.05`) for overlaps between `candidate.entities_in_chunk` and `queryMetadata` for: `people`, `locations`, `topics` (using `checkOverlap`), `type` (exact match), `sentiment` (exact match).
            *   **Apply Hierarchical Date Matching Boost:** Implement logic to iterate through `queryMetadata.dates`. For each query date, check for matches in `candidate.entities_in_chunk.dates` at the Day (+0.05), Month (+0.03), or Year (+0.01) level, adding the highest match found for that query date to the boost score.
            *   **Apply Date Range Boost (FTS Only):** If `query_source === 'postgres_fallback_text'`:
                *   Call `deriveDateRange(queryMetadata.dates)` once to get potential past ranges.
                *   Parse `candidate.timestamp` to a `Date` object.
                *   Check if the candidate's timestamp falls within *any* of the derived ranges.
                *   If it falls within a range, add `+= 0.10` to `metadata_boost_score`.
            *   **Note:** Explicitly *do not* add a boost based on `language` overlap.
        *   **d. Calculate `final_score`:** `final_score = Math.min(1.0, initial_score + metadata_boost_score)`.
        *   **e. Populate Scored Object:** Store calculated scores.
        *   **f. Sort:** Sort `ScoredContextObject` array by `final_score` (descending).
        *   **g. Trim:** Slice array to `FINAL_MATCH_COUNT`.
        *   **h. Map Back:** Map back to `ContextObject[]`, omitting score fields.
        *   **i. Return:** Return final `ContextObject[]`.

**7. Integrate `rerankResults` Call:**
    *   Ensure `rerankResults` is called after `retrieved_context` is populated and before the `SuccessResponse` is constructed. Assign the result back to `retrieved_context`.

**8. Remove Date Parsing Notes Logic:**
    *   Delete the code block that calculates `dateParseNotes` and appends them to `message_for_gpt`.

---

## Testing Requirements

*   Verify Vector Search results correctly use `similarity` for initial scoring in re-ranking.
*   Verify FTS fallback triggers correctly and results use `rank` for initial scoring.
*   Verify FTS results have their `chunk` truncated to 3000 characters.
*   Verify re-ranking logic correctly calculates scores, including the metadata overlap boosts and the hierarchical date matching boost (Day > Month > Year).
*   Verify FTS results receive the additional `+0.10` date range boost when their `created_at` timestamp matches a derived past query date range.
*   Test edge cases (no metadata overlap, empty query metadata, results with 0 similarity/rank, partial/full date matches, etc.).
*   Confirm final response contains `FINAL_MATCH_COUNT` results.
*   Confirm `message_for_gpt` no longer contains date parsing notes.

---
*   Update `learnings/01_project_roadmap.md` to reflect the completed implementation status of this revised plan.