## Memory Locker: Custom GPT Product Development Roadmap (Final)

**Goal:** Create a Custom GPT within the official ChatGPT application that allows a user to store and retrieve personal memories, notes, and information using natural language. The GPT leverages an Action (`memory-action`) to interact with a Supabase backend via a Netlify Function.

**Core Technologies:**

*   **Frontend:** ChatGPT Interface (Web/iOS)
*   **Orchestration:** OpenAI Custom GPT + Actions
*   **Middleware:** Netlify Functions (TypeScript/Node.js)
*   **Backend:** Supabase (PostgreSQL Database + pgvector Extension)
*   **APIs:** OpenAI API (for Action calls), Supabase API

---

### Phase 1: Foundation & Setup (Completed)

**Objective:** Prepared the necessary cloud infrastructure, database schema, and local development environment.

1.  **Supabase Project Setup:** Created project, enabled `pgvector`, secured keys.
2.  **Database Schema Definition:** Defined PostgreSQL tables (`files`, `transcript_embeddings`, etc.) in `sql/schema.sql`. Key aspects:
    *   `files.file_metadata` (JSONB) stores file-level entities.
    *   `transcript_embeddings.metadata` (JSONB) stores chunk-level entities (mirroring file-level).
    *   `transcript_embeddings.embedding` uses `vector(1536)` for `text-embedding-3-small`.
    *   `files.transcript_tsv` (`tsvector`) added for FTS.
    *   User-specific identification (`user_id`) was initially considered and then removed.
3.  **Netlify Project Setup:** Created site, linked Git repository, configured deployment.
4.  **Netlify Functions Environment:** Set up `netlify/functions` directory with Node.js/TypeScript project. Dependencies (`@supabase/supabase-js`, `openai`, `date-fns`, `chrono-node`, etc.) installed.
5.  **Environment Configuration:** Established secure management of secrets via Netlify build variables and local `.env` files.
6.  **Local Development Setup:** Ensured necessary tools (Node.js, Netlify CLI, etc.) were available.
7.  **Database Indexing:** Applied necessary performance indexes (HNSW for vectors, GIN for JSONB metadata including date components, GIN for FTS, B-tree for timestamps) as defined in `sql/schema.sql`.
8.  **Database Functions:** Updated `search_memory_chunks` function to return `chunk_index` and `similarity`.

---

### Phase 2: Core Action Development (Netlify Function - Completed)

**Objective:** Built the `memory-action` serverless function (`memory-action.ts`) bridging the GPT Action and Supabase.

1.  **API Endpoint Design:** Defined a single endpoint (`/.netlify/functions/memory-action`) using POST, managed by the `mode` parameter (`store` or `query`). The `combined` mode is **not** supported. API contract specified in `openapi.json`. Authentication uses `x-api-key`.
    *   **Authentication Method:** The function code checks for a secret key in the `x-api-key` header. The OpenAPI spec (`openapi.json`) uses `x-oai-openai-integration` to define this `api_key` method for ChatGPT Action integration.
2.  **Supabase Integration:** Implemented client initialization and secure connection using environment variables and the service role key (bypassing RLS).
3.  **Core Function Logic (`store` mode):**
    *   Generates `text-embedding-3-small` embeddings for text chunks.
    *   Stores file info and extracted `file_metadata` (including simplified date components and period) in the `files` table.
    *   Stores chunks, embeddings, `chunk_index`, and chunk-level `metadata` in `transcript_embeddings`.
    *   **Date Handling (Current):** Employs a hybrid approach. Relies on upstream GPT instructions to provide normalized `"Month DD, YYYY"` dates when possible. The function parses these, or attempts to parse original strings using `date-fns`. Only extracts the `period` (e.g., 'Morning') using keywords, not specific times. Stores structured date components.
4.  **Core Function Logic (`query` mode - Hybrid Search Pipeline):**
    *   Generates query embedding.
    *   Performs concurrent Vector Search (semantic) and FTS Search (keyword, using `ts_rank > 0.05` filtering).
    *   Combines results using Reciprocal Rank Fusion (RRF).
    *   Applies weighted re-ranking using stemmed entity matches (`people`, `locations`, `topics`, `organizations`) and date component matching against metadata.
    *   Returns the final ranked context to the GPT.
5.  **Error Handling & Logging:** Implemented try/catch blocks and enhanced logging for debugging/tuning.
6.  **Deployment & Initial Testing:** Function deployed and tested.

---

### Phase 3: Custom GPT Configuration & Action Schema (Completed)

**Objective:** Configured the Custom GPT, including instructions and Action definition.

1.  **Custom GPT Creation:** Created GPT shell (name, description, etc.).
2.  **Instruction Authoring (`learnings/02_gpt_instructions.md`):** Defined persona, purpose, behavior. Key instructions include:
    *   Entity extraction rules (people, locations, orgs, topics, type, sentiment, priority).
    *   Hybrid date handling (requesting original + normalized `"Month DD, YYYY"`).
    *   **Explicit handling for combined inputs:** Instructs GPT to make sequential `store` then `query` calls within a single turn.
3.  **Action Schema Definition (`openapi.json`):** Created OpenAPI spec defining `store` and `query` modes, expected entities (including hybrid date format and simplified date storage), and authentication.
4.  **Action Configuration:** Configured API key authentication using `x-oai-openai-integration`.

---

### Phase 4: Integration Testing & Refinement (Completed)

**Objective:** Tested the end-to-end flow and refined implementation based on results.

1.  **End-to-End Testing:** Performed various tests (`store`, `query`, combined intents).
2.  **Refinement & Bug Fixing:** Addressed issues, notably correcting FTS logic (rank-based filtering) and refining GPT instructions for combined intents.

---

### Phase 5: Enhancements & Optimization (Completed)

**Objective:** Improve date handling reliability and enhance query relevance through hybrid search, RRF, weighted re-ranking, and refined GPT instruction-based intent handling.

1.  **Date Parsing (Hybrid Approach - Implemented):**
    *   **Status:** Completed. Leverages GPT normalization and focused function logic (`date-fns` for parsing, keyword matching for period). See Phase 2 description.
2.  **Query Retrieval & Ranking (Hybrid Pipeline - Implemented):**
    *   **Status:** Completed. Includes concurrent Vector + FTS (rank-filtered), RRF combination, and weighted re-ranking with stemming. See Phase 2 description.
3.  **Combined Intent Handling (GPT Instructions - Implemented):**
    *   **Status:** Completed. Instructions updated to guide sequential `store`/`query` calls. `combined` mode removed from Action.
4.  **`organizations` Entity Integration (Completed):**
    *   **Status:** Completed. Fully integrated into storage and re-ranking.
5.  **Enhanced Logging (Completed):**
    *   **Status:** Completed. Aids debugging and tuning.

---

### Phase 6: Current Status & Next Steps

1.  **Deployment Ready:** Core functionality is implemented and tested. Documentation is updated.
2.  **Tuning Required:** Retrieval parameters (`ENTITY_WEIGHTS`, `RRF_K`, FTS Rank Threshold, etc.) have baseline values and require ongoing monitoring and tuning based on real-world usage.
3.  **Known Limitations / Future Considerations:**
    *   **Context Size:** Limited context for large files.
    *   **Combined Intent Reliability:** Success depends on GPT consistently following instructions; requires monitoring.
    *   **GPT Trust UI:** Missing "Always allow" checkbox needs investigation.
    *   **Advanced Date/Time Queries:** Not supported currently.

---

### Post-Launch Enhancements (Future Considerations)

*(The following items are outside the scope of the current MVP but represent potential future directions for enhancement based on user feedback and further development)*

1.  **Advanced Re-ranking Models:** Explore replacing the current weighted boosting with more sophisticated machine learning models (e.g., LambdaMART, cross-encoders) or leveraging LLMs for re-ranking, potentially improving relevance at the cost of complexity/latency.
2.  **Full Document Retrieval:** Implement a mechanism to retrieve the full text of large documents (`files.transcript_text`) when the context required exceeds chunk/FTS limits.
3.  **Query Expansion:** Automatically expand user queries with synonyms or related terms to improve search recall.
4.  **Graph-Based Retrieval:** Investigate representing memories and entities as a knowledge graph to enable more complex relational queries.
5.  **Personalization:** If user identification is re-introduced, explore personalized re-ranking based on user interaction history.
6.  **Advanced Date/Time Capabilities:** Enhance date parsing and querying to handle more complex ranges, recurring events, or fuzzy time expressions beyond the current capabilities.
7.  **UI/Frontend Improvements:** If moving beyond the basic Custom GPT interface, develop a dedicated frontend with richer features for browsing, managing, and visualizing memories.
8.  **Multi-Modal Support:** Allow storing and potentially searching based on images or other non-textual data associated with memories.

--- 