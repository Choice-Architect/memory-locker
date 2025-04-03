Here are the key questions regarding the **Custom GPT + Actions** workflow and their resolutions based on our discussion:

1.  **Storing Direct GPT Interactions:**
    *   Question: How to handle memories added directly via text/voice in ChatGPT?
    *   **Resolution:** Create a corresponding record in the `files` table (e.g., with `file_type = 'gpt_interaction'`). `files.transcript_text` will contain the core content (user message, transcription, analysis). `files.title` will be an AI-generated summary. `files.file_metadata` will store file-level summary and a list of all key entities.

2.  **Embedding Strategy:**
    *   Question: How to embed direct GPT interactions? What chunking strategy?
    *   **Resolution:** Use OpenAI's `text-embedding-3-small` (1536 dimensions), generated within the Netlify function. Chunk `files.transcript_text` (suggested: 1000 chars, 200 overlap). Each conversation turn (user query + GPT response) chunked and stored with embeddings and chunk-specific metadata in `transcript_embeddings`.

3.  **`queries` Table Purpose:**
    *   Question: What should `queries.result` store? How is `queries.source` populated?
    *   **Resolution:** `result` stores the raw context data returned *by the Action* to the GPT (e.g., text chunks from vector/table search). `source` is populated by the Netlify Action based on where the primary information was found (e.g., `'vector_store'`, `'postgres_fallback'`, `'vector_store (filtered)'`, `'combined'`). Logic involves a sequential, filtered search (vector first, then table fallback).

4.  **Metadata Location & Strategy:**
    *   Question: Where to store conversation-specific metadata? What metadata is needed?
    *   **Resolution:** Differentiated storage:
        *   `files.file_metadata`: File-level info (summary, type like 'gpt_interaction') and a list/summary of *all key entities* mentioned throughout the *entire* `transcript_text`.
        *   `transcript_embeddings.metadata`: Chunk-level info, specifically the entities *mentioned within that chunk* and the relevant interaction timestamp (`created_at`).
    *   *(Specific list of entities to extract to be defined later).* This strategy supports precise vector filtering and broader file-level fallback searches.

5.  **Row-Level Security (RLS) and Netlify Function:**
    *   Question: Should the Netlify function use a service key or user permissions?
    *   **Resolution:** The Netlify function will use the Supabase **service role key**, bypassing RLS for full database access. This is suitable for the single-user-per-deployment model.

6.  **Vector Index:**
    *   Question: How to handle indexing for `transcript_embeddings.embedding`?
    *   **Resolution:** An Approximate Nearest Neighbor (ANN) index (e.g., HNSW) **is required** for efficient vector search performance with 1536 dimensions. It will be created manually using a separate SQL command (e.g., `CREATE INDEX ON transcript_embeddings USING hnsw (embedding vector_cosine_ops);`) after the initial schema setup and enabling `pgvector`.

7.  **Action Granularity & API Contract:**
    *   Question: Should we use one action or multiple? What should the API contract look like?
    *   **Resolution:** A **single `memory-action`** will be used, pointing to one Netlify function. The function will handle different operations (`store`, `query`, `combined`) based on a `mode` parameter in the request. The API contract is defined (see `01_new_gpt_roadmap.md`, Phase 2.1) with specific input JSON and output JSON, including a detailed `retrieved_context` object containing chunk text, timestamp, and chunk-level entities. A string-based `message_for_gpt` field will provide optional hints to the GPT.

