# Full-Text Search (FTS) Fallback Explanation

This document outlines the step-by-step process occurring within `memory-action.ts` when the third and final fallback mechanism (Full-Text Search using query entities) is triggered.

1.  **Trigger Condition:** This fallback only runs if both the primary vector search (`search_memory_chunks`) and the secondary metadata filter search on the `files` table have failed to find any relevant context (`retrieved_context` is still empty).

2.  **Log Attempt:** The function logs that it's starting "Attempt 3: Fallback - Full-Text Search..."

3.  **Extract Search Entities:**
    *   The code iterates through the `queryMetadata` object (which holds the processed entities from the user's query payload).
    *   It extracts all meaningful **string** values associated with the entities. This includes:
        *   Strings within arrays (like names in `people`, terms in `topics`, places in `locations`).
        *   The `original` string property from any `NormalizedDate` objects found in the `dates` array.
        *   (Optionally, though currently commented out, top-level string entities like `type` or `sentiment` could also be included).
    *   These extracted strings are collected, duplicates are removed, and empty strings are filtered out, resulting in a list called `uniqueEntities`.

4.  **Check for Entities:**
    *   The code checks if `uniqueEntities` actually contains any terms.
    *   **If NO entities were found** in the query (the list is empty), the FTS fallback is skipped. The function logs this, sets `query_source` to `'none'`, prepares a message like "I couldn't find any relevant information... and no specific entities were provided for text search," and proceeds to the final response construction (Step 9).

5.  **Construct FTS Query String (If Entities Exist):**
    *   The `uniqueEntities` are joined together into a single string (`ftsQueryString`) suitable for PostgreSQL's `to_tsquery` function using the `websearch` type. The terms are separated by ` | ` (the OR operator).
    *   Basic escaping is applied to remove characters that might interfere with `to_tsquery` (`&`, `|`, `!`, etc.). Example: `ftsQueryString` might look like `'projectX | report | deadline'`.
    *   The function logs the entities it's searching for.

6.  **Build Database Query:**
    *   A Supabase query builder instance (`ftsQueryBuilder`) is created to target the `files` table.
    *   It uses the `.textSearch()` method, specifically targeting the pre-computed `transcript_tsv` column with the generated `ftsQueryString`.
        *   `config: 'english'` specifies the text search configuration.
        *   `type: 'websearch'` tells `to_tsquery` to interpret the string flexibly (like a web search engine, handling operators like `|`).
    *   It includes `ts_rank_cd(transcript_tsv, to_tsquery('english', $1)) as rank` in the `SELECT` clause to calculate a relevance score for each row based on how well its `transcript_tsv` matches the `ftsQueryString`.
    *   Crucially, it orders the results using `.order('rank', { ascending: false })`, so the most relevant matches appear first.
    *   It limits the results using `.limit(FALLBACK_MATCH_COUNT)`.
    *   **Optional Date Filter:** If the original query included dates (`queryDates`), the code adds filters to the `ftsQueryBuilder` to only include files whose `created_at` timestamp falls within the specified range (similar to the metadata fallback).

7.  **Execute Database Query:** The function executes the constructed FTS query against the Supabase database using `await ftsQueryBuilder`.

8.  **Process FTS Results:**
    *   **Error:** If an error occurs during the database query (`ftsError`), it's logged, `query_source` is set to `'error'`, and an appropriate error message is added to `message_for_gpt`. The function then proceeds to the final response construction (Step 9).
    *   **Success (Results Found):** If the query succeeds and returns one or more rows (`typedTextResults` is not empty):
        *   It logs the number of files found.
        *   `query_source` is set to `'postgres_fallback_text'`.
        *   A success message is added to `message_for_gpt` (e.g., "Found X potential match(es) via text search.").
        *   The function maps over the returned rows. For each row, it creates a `ContextObject`, populating it with the `file_id`, the **full `transcript_text`** (important: not a chunk like vector search), the `created_at` timestamp, and reconstructed entities from the `file_metadata`.
        *   These `ContextObject`s are stored in the `retrieved_context` array.
        *   The function proceeds to the final response construction (Step 9).
    *   **Success (No Results Found):** If the query succeeds but returns no matching rows:
        *   It logs that the FTS search found nothing.
        *   If no previous error occurred, `query_source` is set to `'none'`, and `message_for_gpt` is set to indicate that no information was found across all search methods.
        *   The function proceeds to the final response construction (Step 9).

9.  **Final Response Construction:** The function prepares the final `SuccessResponse` object, including the (potentially empty) `retrieved_context`, the final `storage_status`, the final `query_source`, and any accumulated `message_for_gpt`. This response is then returned. 