# System Flow: Metadata Storage and Query Handling

Based on `memory-action.ts`, `openapi.json`, and `schema.sql`.

**1. Metadata Storage:**

*   **Initial Capture (`openapi.json`):** When a request comes in (e.g., from GPT), it includes an `extracted_entities` object. This object contains arrays for `people`, `locations`, `topics`, etc., and importantly, a `dates` array which initially holds simple strings representing dates ("last Tuesday", "tomorrow evening"). Other fields like `type`, `sentiment`, `priority`, `conversation_id`, `thread_id`, and `language` are also captured.
*   **Processing (`memory-action.ts`):** The Netlify function receives this payload.
    *   It takes the date strings from `extracted_entities.dates`.
    *   Each date string is parsed using `chrono-node` via the `parseDateStringToEnhanced` function. This function attempts to convert the string into a structured `EnhancedNormalizedDate` object. This object stores the `original` string, a potentially `normalized` ISO 8601 timestamp (if fully resolvable), and various optional `component` fields (year, month, day, hour, period, relative markers like 'last', etc.). Parsing notes are also included.
    *   The result of this processing is a `ProcessedEntities` object where the `dates` field now holds an array of these `EnhancedNormalizedDate` objects.
*   **Database Storage (`schema.sql` & `memory-action.ts`):**
    *   **`files` Table:** When storing (`mode: 'store' | 'combined'`), the *entire* `ProcessedEntities` object (including the array of structured `EnhancedNormalizedDate` objects within its `dates` property) is saved into the `file_metadata` JSONB column of the main `files` record. The `conversation_id` and `thread_id` are stored in dedicated columns in this table.
    *   **`transcript_embeddings` Table:** The original text is chunked. For each chunk, an embedding is generated. When inserting into the `transcript_embeddings` table, the *same* `ProcessedEntities` object (containing the `EnhancedNormalizedDate[]`) from the parent file is copied into the `metadata` JSONB column for *each* chunk record, along with chunk-specific info like `chunk_index` and `created_at`.

**2. Query Handling Flow:**

1.  **Request (`openapi.json`):** A POST request hits the `/.netlify/functions/memory-action` endpoint. It includes `query_text`, `extracted_entities` (with string dates), and `mode: 'query' | 'combined'`. It must have a valid `x-api-key`.
2.  **Authentication & Parsing (`memory-action.ts`):** The Netlify function verifies the API key and parses the JSON payload.
3.  **Date Normalization (`memory-action.ts`):** Similar to storage, the `extracted_entities.dates` strings are parsed into an array of `EnhancedNormalizedDate` objects stored within a `processedMetadata` variable. *This parsed date information is available but is NOT used for filtering during retrieval attempts.* 
4.  **Query Embedding (`memory-action.ts`):** An embedding vector is generated for the `query_text` using OpenAI's `text-embedding-3-small` model.
5.  **Attempt 1: Vector Search (`memory-action.ts` & `schema.sql`):**
    *   The function calls the Supabase RPC function `search_memory_chunks`.
    *   It passes the `query_embedding`, `match_threshold`, `match_count`, and *potentially* filters derived from `processedMetadata` (people, topics, locations, type, sentiment - *excluding date components*).
    *   The `search_memory_chunks` SQL function performs a vector similarity search (`<=>` operator) on the `transcript_embeddings` table. It filters results based on the `match_threshold` AND the provided standard metadata filters (using JSONB containment `@>` or equality checks). *It does NOT filter based on date components.*
    *   If successful and results meet the threshold, the `content_chunk`, `file_id`, `metadata` (including the stored `EnhancedNormalizedDate[]`), and `similarity` score for matching chunks are returned. The `query_source` is set to `vector_store`.
6.  **Attempt 2: Fallback - Metadata Search (`memory-action.ts` & `schema.sql`):**
    *   If vector search fails or returns no results, the function queries the `files` table directly.
    *   It filters using standard entity fields (`people`, `locations`, `topics`, `priority`) applied to the `file_metadata` JSONB column using containment (`@>`) or equality. *Date component filtering is NOT applied here.*
    *   If filters are applied and results are found, the full `transcript_text` and `file_metadata` (including `EnhancedNormalizedDate[]`) are returned. The `query_source` is set to `postgres_fallback_metadata`.
7.  **Attempt 3: Fallback - Full-Text Search (`memory-action.ts` & `schema.sql`):**
    *   If both vector and metadata searches yield no results, a final fallback uses PostgreSQL Full-Text Search (FTS) on the `files` table's pre-computed `transcript_tsv` column.
    *   It constructs an FTS query string from all unique, non-empty string values within the query's `processedMetadata` (people, locations, topics, type, sentiment, language, and the *original* date strings).
    *   It executes a `textSearch` query. *Date component filtering is NOT applied here.*
    *   If results are found, the `transcript_text` and `file_metadata` are returned. The `query_source` is set to `postgres_fallback_text`.
8.  **Response (`memory-action.ts` & `openapi.json`):**
    *   The function compiles the results (if any) into an array of `ContextObject`s. Each object contains the `chunk` (or full text from fallbacks), `timestamp`, `file_id`, `chunk_index` (if applicable), and the `entities_in_chunk` (which is the `ProcessedEntities` object containing the structured `EnhancedNormalizedDate[]` retrieved from the metadata).
    *   Any notes generated during date parsing (e.g., "Partial parse", "Could not parse") are potentially added to the `message_for_gpt` field.
    *   A `SuccessResponse` object containing `retrieved_context`, `storage_status` (from potential store operations), `query_source`, `message_for_gpt`, and `error: null` is constructed and returned as JSON with a 200 status code. If any step failed critically, an `ErrorResponse` is returned instead. 