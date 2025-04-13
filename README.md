# Memory Locker Action

## Overview

Memory Locker Action serves as the backend for the "Memory Locker" Custom GPT. It provides a secure interface for storing and retrieving personal notes, memories, and reminders using natural language. The system involves: entity extraction, hybrid date parsing, vector search, full-text search (FTS), Reciprocal Rank Fusion (RRF), and metadata-based re-ranking to ensure relevant and accurate memory recall.

## Tech Stack

*   **Frontend:** ChatGPT Interface via Custom GPT
*   **Orchestration:** OpenAI Custom GPT + Actions
*   **Middleware:** Netlify Functions (TypeScript/Node.js)
*   **Backend:** Supabase (PostgreSQL Database + pgvector Extension)
*   **APIs:** OpenAI API (Action Calls, Embeddings), Supabase API

## Core Features

*   **Dual Modes:** Supports `store` mode for saving information and `query` mode for retrieving it.
*   **Entity Extraction:** Relies on the upstream Custom GPT to extract key entities like people, locations, organizations, topics, type, sentiment, and priority.
*   **Hybrid Date Handling:**
    *   The Custom GPT attempts to normalize dates to `"Month DD, YYYY"` format.
    *   The Netlify function parses normalized dates (`date-fns`) and extracts periods (Morning, Afternoon, etc.) from original strings using keywords.
    *   Stores structured date components (year, month, day, day\_of\_week, week\_number, period) for effective querying and ranking.
*   **Hybrid Search Pipeline:**
    *   **Concurrent Search:** Executes vector search (using OpenAI's `text-embedding-3-small` model) and keyword-based FTS concurrently for initial retrieval.
    *   **Reciprocal Rank Fusion (RRF):** Combines the ranked lists from vector and FTS searches using RRF to leverage the strengths of both methods.
    *   **Weighted Re-ranking:** Further refines the RRF results by applying weighted boosts based on stemmed matches between query entities and stored metadata (people, locations, topics, organizations), granular date component matches, and FTS date range matches. Entity weights are configurable (`ENTITY_WEIGHTS`).
*   **Text Chunking:** Splits text into manageable chunks (`CHUNK_SIZE=1000`, `CHUNK_OVERLAP=200`) for embedding and vector storage.
*   **Code Structure:** Adheres to DRY (Don't Repeat Yourself) principles, promoting maintainability and reducing redundancy. This is achieved through:
    *   **Modular Functions:** Encapsulating specific logic units like date processing (`processInputDates`), embedding generation (`generateEmbeddings`), search execution (`executeVectorSearch`, `executeFtsSearch`), and re-ranking (`rerankResults`).
    *   **Constants:** Defining configuration values (e.g., `CHUNK_SIZE`, `ENTITY_WEIGHTS`) in one place for easy modification.
    *   **Helper Utilities:** Using smaller, focused functions (e.g., `extractTimeInfo`, `mapDbMetadataToProcessedEntities`) for reusable tasks.


## How it Works (Interaction Flow)

1.  The user interacts with the "Memory Locker" Custom GPT in ChatGPT.
2.  The GPT processes the user's input based on its instructions (`gpt_instructions.md`).
3.  The GPT determines the `mode` (`store` or `query`). For combined inputs (store + query in one message), the GPT makes sequential `store` then `query` calls.
4.  The GPT extracts relevant entities and translates the `query_text` and `dates` to English.
5.  The GPT calls the `memory-action` Netlify Function endpoint with the payload and API key.
6.  The Netlify Function authenticates the request, parses the payload, and processes based on the `mode`:
    *   **Store:** Processes dates, generates embeddings, stores file info and embeddings in Supabase.
    *   **Query:** Generates query embedding, performs concurrent vector/FTS search, applies RRF, re-ranks results based on metadata, and prepares the context.
7.  The Netlify Function returns the results (status, context, etc.) to the Custom GPT.
8.  The Custom GPT synthesizes the response and presents it to the user, confirming storage or answering the query based on the retrieved context.



## Entity Processing Workflow

Entities extracted from user input are crucial for both storing meta data context and retrieving relevant memories. Here's how they are processed across the system:

**1. Custom GPT Layer:**

*   **Input:** Raw user text (or transcribed voice).
*   **Processing:**
    *   Identifies and extracts entities: `people`, `locations`, `organizations`, `topics`, `dates`, and potentially inferred `type`, `sentiment`, or `priority`.
    *   Translates the main `query_text` and any extracted `dates` strings to English.
    *   **Date Handling:** Attempts to normalize extracted date expressions.
        *   If successful (for the date part), it provides `{"original": "full original phrase", "normalized": "Month DD, YYYY"}`.
        *   If normalization fails, it passes the original (English translated) date string.
*   **Output:** Sends the `mode`, English `query_text`, and the `extracted_entities` object (containing strings and structured date objects) to the Netlify Function via the Action call.

**2. Middleware Layer (Netlify Function - `memory-action.ts`):**

*   **Input:** Action payload from the Custom GPT.
*   **Processing:**
    *   **Date Processing (`processInputDates`):**
        *   Iterates through the `dates` array from `extracted_entities`.
        *   Parses the `normalized` date string using `date-fns` if present.
        *   If no `normalized` string, attempts to parse the `original` date string using `date-fns`.
        *   Extracts the `period` (Morning, Afternoon) from the `original` string using keyword regex matching (`extractTimeInfo`).
        *   Combines successfully parsed components into structured `EnhancedNormalizedDate` objects (`{year, month, day, day_of_week, week_number, period}`). Unparseable dates are discarded.
    *   **Metadata Aggregation:** Constructs a `processedMetadata` object containing all entities received from the GPT, but replaces the input `dates` array with the array of newly created `EnhancedNormalizedDate` objects.
    *   **`store` Mode:** Saves the entire `processedMetadata` object into the `files.file_metadata` (JSONB) column and also mirrors it into the `transcript_embeddings.metadata` (JSONB) column for each text chunk stored in Supabase.
    *   **`query` Mode:** Uses the `processedMetadata` (derived from the *query\'s* entities) during the final re-ranking step (`rerankResults`) to compare against the metadata retrieved from stored chunks.
        *   **Metadata Re-ranking (`rerankResults`):** After initial candidates are retrieved and combined using RRF, this crucial step refines the ranking using the processed entities:
            *   Compares the `processedMetadata` (entities extracted from the user\'s current query) against the stored `metadata` retrieved with each candidate chunk/file.
            *   Applies stemming (using `@stdlib/nlp-porter-stemmer`) to text entities (`people`, `locations`, `topics`, `organizations`) before checking for overlap between query and candidate entities.
            *   Checks for exact matches on `type` and `sentiment`.
            *   Performs granular matching for date components (`day`, `month`, `year`) and `period` between query dates and candidate dates.
            *   Calculates a `metadata_boost_score` for each candidate by summing weights (`ENTITY_WEIGHTS`) for each matching entity type.
            *   Combines the normalized initial RRF score and the `metadata_boost_score` to get a `final_score`.
            *   Sorts candidates by this `final_score` in descending order.
            *   Selects the top N (`FINAL_MATCH_COUNT`) candidates as the most relevant context to return.
*   **Output:** For `store`, confirms storage status. For `query`, returns the final list of `retrieved_context` objects, where each object\'s `entities_in_chunk` field contains the `ProcessedEntities` (including `EnhancedNormalizedDate` structures) that were originally stored with that chunk.

**3. Database Layer (Supabase/PostgreSQL):**

*   **Input:** `processedMetadata` object (for storage) or query parameters (embedding vector, FTS query string).
*   **Processing:**
    *   **Storage:** Persists the `processedMetadata` JSONB object in `files.file_metadata` and `transcript_embeddings.metadata`.
    *   **Indexing:** Utilizes GIN indexes on the JSONB metadata columns (`idx_gin_files_metadata`, `idx_transcript_embeddings_metadata_gin`) for potential future direct metadata queries, though not used in the current initial retrieval filters. HNSW index is used for vector (`embedding`) search, and a GIN index is used for FTS (`transcript_tsv`).
    *   **Initial Retrieval:** The `search_memory_chunks` (vector) and `fts_search_files` (FTS) functions retrieve candidate rows based *only* on the embedding similarity or FTS rank, respectively.
    *   **Re-ranking Data:** The stored JSONB `metadata` (containing the structured entities) is retrieved along with the text chunks/files during the initial search and passed back to the Netlify Function.
*   **Output:** Returns rows containing text (`content_chunk` or `transcript_text`), associated `metadata` (as JSONB), and relevance scores (similarity or rank) to the Netlify Function (see query mode in Middleware layer).


## Action API (`memory-action`)

*   **Endpoint:** `POST /.netlify/functions/memory-action`
*   **Host:** `https://memory-locker-gpt.netlify.app`
*   **Authentication:** Requires an API key passed in the `x-api-key` header (configured via Custom GPT Action settings).
*   **Request Payload:** See `openapi.json` for the full schema. Key fields include:
    *   `mode` ("store" | "query"): The operation to perform.
    *   `query_text` (string): The user's input text.
    *   `extracted_entities` (object): Entities extracted by the Custom GPT.
*   **Response Payload:** Returns status (`storage_status`, `query_source`), retrieved context (`retrieved_context`), and optional messages (`message_for_gpt`).


## Setup

1.  **Deploy:** Deploy the Netlify function code.
2.  **Environment Variables:** Configure the following environment variables in the Netlify UI (or a local `.env` file for `netlify dev`):
    *   `SUPABASE_URL`: Your Supabase project URL.
    *   `SUPABASE_SERVICE_ROLE_KEY`: Your Supabase service role key (use securely!).
    *   `OPENAI_API_KEY`: Your OpenAI API key.
    *   `ACTION_SECRET_KEY`: A secret key you define for authenticating requests from the GPT Action.
3.  **Database:** Ensure your Supabase database schema matches the one defined (defined explicitly in `sql/schema.sql`). Make sure the `pgvector` extension is enabled and necessary functions/indexes are created.
4.  **Custom GPT:**
    *   Configure the Custom GPT instructions (`gpt_instructions.md`).
    *   Configure the Action using the `openapi.json` schema.
    *   Set the authentication method to API Key, header name to `x-api-key`, and provide the `ACTION_SECRET_KEY` value.
    *   Set the server URL to your Netlify deployment URL (e.g., `https://your-site-name.netlify.app`).

## Usage

Interact with the "Memory Locker" Custom GPT through the ChatGPT interface. The GPT handles the communication with this backend action.

## Future Considerations

*   Tuning retrieval parameters (`ENTITY_WEIGHTS`, `RRF_K`, etc.).
*   Handling very large documents beyond chunk limits.