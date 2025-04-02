Okay, here is a detailed product development roadmap for the Memory Locker project, based on the Custom GPT and Actions approach outlined in `client-switch.md`.

## Memory Locker: Custom GPT Product Development Roadmap

**Goal:** Create a Custom GPT within the official ChatGPT application that allows a user to store and retrieve personal memories, notes, and information using natural language, voice, and potentially file uploads. The GPT will leverage Actions to interact with a Supabase backend via a Netlify Function.

**Core Technologies:**

*   **Frontend:** ChatGPT Interface (Web/iOS)
*   **Orchestration:** OpenAI Custom GPT + Actions
*   **Middleware:** Netlify Functions (TypeScript/Node.js)
*   **Backend:** Supabase (PostgreSQL Database + pgvector Extension)
*   **APIs:** OpenAI API (for Action calls), Supabase API

---

### Phase 1: Foundation & Setup (Est. 1-2 weeks)

**Objective:** Prepare the necessary cloud infrastructure, database schema, and local development environment.

1.  **Supabase Project Setup:**
    *   Task: Create a new Supabase project.
    *   Task: Enable the `pgvector` extension.
    *   Task: Secure API keys and project URL.
    *   Deliverable: Active Supabase project.
2.  **Database Schema Definition:**
    *   Task: Define PostgreSQL table structures (e.g., `memories` renamed to `files`, `transcript_embeddings`, `queries`, etc. based on `schema.sql`). Columns include content, embeddings (`vector(1536)`), timestamps, source, metadata (`JSONB` for file-level in `files`, chunk-level in `transcript_embeddings`).
    *   Task: Define vector storage strategy (1536 dimensions for `text-embedding-3-small`, plan for HNSW index creation after initial setup).
    *   Comment: *Schema largely defined in `schema.sql`. Key decisions made: Use `text-embedding-3-small`. File-level metadata (summary, all entities) in `files.file_metadata`. Chunk-level metadata (entities in chunk, timestamp) in `transcript_embeddings.metadata`.* 
    *   Deliverable: SQL script for schema creation (`schema.sql` updated), documented schema design (partially covered by README and this roadmap).
3.  **Netlify Project Setup:**
    *   Task: Create a new Netlify site.
    *   Task: Initialize a Git repository for the project.
    *   Task: Configure continuous deployment from the Git repository.
    *   Deliverable: Netlify site linked to a Git repo.
4.  **Netlify Functions Environment:**
    *   Task: Set up a `netlify/functions` directory in the repository.
    *   Task: Initialize a Node.js/TypeScript project within this directory (`package.json`, `tsconfig.json`).
    *   Task: Install necessary dependencies (`@supabase/supabase-js`, TypeScript types).
    *   Deliverable: Basic Netlify Functions project structure.
5.  **Environment Configuration:**
    *   Task: Set up local `.env` file for development secrets (Supabase URL/Key, OpenAI API Key if needed directly in function later).
    *   Task: Configure Netlify build environment variables for production secrets.
    *   Deliverable: Secure configuration management.
6.  **Local Development Setup:**
    *   Task: Ensure Node.js, npm/yarn, Netlify CLI, and optionally Supabase CLI are installed.
    *   Task: Clone the repository.
    *   Deliverable: Functional local development environment.

---

### Phase 2: Core Action Development (Netlify Function) (Est. 2-4 weeks)

**Objective:** Build the serverless function that acts as the bridge between the GPT Action and the Supabase database.

1.  **API Endpoint Design:**
    *   Task: Define the request/response structure for the Netlify function (e.g., endpoint path `/api/memory-action`).
    *   Task: Define expected input JSON (e.g., `{ query: string, extracted_entities: object, file_metadata?: object, mode: 'store' | 'query' | 'combined' }`).
    *   Task: Define output JSON (e.g., `{ retrieved_context: string[], storage_status: string, error?: string }`).
    *   Deliverable: API contract specification.
2.  **Supabase Integration:**
    *   Task: Implement Supabase client initialization within the function.
    *   Task: Implement secure handling of Supabase credentials.
    *   Deliverable: Function capable of connecting to Supabase.
3.  **Database Logic Implementation:**
    *   Task: Implement function(s) for querying memories: 
        *   Primary: Vector similarity search on `transcript_embeddings`, filtering by chunk-level `metadata` (entities, timestamps).
        *   Fallback: Structured query on `files` table (e.g., filtering by `file_metadata` entities, timestamps, or full-text search).
    *   Task: Implement function(s) for storing/upserting data:
        *   Generate `text-embedding-3-small` (1536 dimensions) embeddings within the function.
        *   Store/update file-level info and metadata in `files` table.
        *   Store chunks, embeddings, and chunk-level metadata in `transcript_embeddings`.
    *   Task: Combine query and storage logic based on the input `mode` or inferred intent, using Supabase service role key (bypassing RLS).
    *   Comment: *Embeddings generated in the function using `text-embedding-3-small`. Sequential search (vector filter -> table filter fallback). Differentiated metadata storage confirmed.* 
    *   Deliverable: Core database interaction logic within the function.
4.  **Error Handling & Logging:**
    *   Task: Implement robust try/catch blocks for API calls and database operations.
    *   Task: Implement meaningful logging (e.g., using Netlify's function logs).
    *   Task: Define consistent error responses to be sent back to the GPT Action.
    *   Deliverable: Resilient function with basic observability.
5.  **Initial Deployment:**
    *   Task: Deploy the first version of the function to Netlify.
    *   Task: Test the function endpoint directly (e.g., using `curl` or Postman) with sample data.
    *   Deliverable: Deployed and testable Netlify function endpoint URL.

---

### Phase 3: Custom GPT Configuration & Action Schema (Est. 1-2 weeks)

**Objective:** Configure the Custom GPT in the ChatGPT interface, including its instructions and the Action definition.

1.  **Custom GPT Creation:**
    *   Task: Create a new GPT via the ChatGPT UI.
    *   Task: Define name, description, and conversation starters.
    *   Deliverable: Basic Custom GPT shell.
2.  **Instruction Authoring:**
    *   Task: Write detailed instructions defining the GPT's persona, purpose, and behavior.
    *   Task: Specify *when* and *why* to call the `Memory Action`.
    *   Task: Detail *how* to extract entities (names, dates, locations, concepts, events). Provide examples.
    *   Task: Specify the *format* for data sent to the Action (matching the Netlify function's expected input).
    *   Task: Explain how to use the `retrieved_context` from the Action's response.
    *   Task: Explain how to communicate `storage_status` or `error` messages back to the user appropriately.
    *   **Comment:** *Requires detailed thought on the entity extraction strategy and how you want the GPT to behave.*
    *   Deliverable: Comprehensive GPT instructions.
3.  **Action Schema Definition (OpenAPI):**
    *   Task: Create an OpenAPI v3 specification document (`openapi.yaml` or JSON).
    *   Task: Define the server URL (pointing to the deployed Netlify function).
    *   Task: Define the path (`/api/memory-action`), method (POST), and operation ID.
    *   Task: Define the request body schema (content type `application/json`, matching function input).
    *   Task: Define response schemas (e.g., 200 OK with success payload, error responses).
    *   Task: Define authentication requirements (likely API Key passed in header, managed by OpenAI).
    *   Deliverable: Valid OpenAPI specification file.
4.  **Action Configuration:**
    *   Task: Add the OpenAPI schema to the Custom GPT configuration.
    *   Task: Configure authentication (set up API key if required by the Netlify function).
    *   Task: Test the schema validation within the GPT editor.
    *   Deliverable: Configured Action within the Custom GPT.

---

### Phase 4: Integration Testing & Iteration (Est. 2-3 weeks)

**Objective:** Test the end-to-end flow from ChatGPT input to Supabase storage/retrieval and back, refining as needed.

1.  **End-to-End Testing:**
    *   Task: Interact with the Custom GPT in the ChatGPT preview or main interface.
    *   Task: Test various scenarios:
        *   Simple storage ("Remember that John Doe's birthday is July 15th").
        *   Simple query ("When is John Doe's birthday?").
        *   Complex query requiring retrieval + reasoning ("What did I discuss about Project X last week?").
        *   Voice inputs.
        *   File inputs (if included).
        *   Edge cases and potential ambiguities.
    *   Task: Verify data persistence and retrieval accuracy in Supabase.
    *   Task: Monitor Netlify function logs for errors or unexpected behavior.
    *   Deliverable: Test plan, execution results, bug/issue list.
2.  **Refinement Cycle:**
    *   Task: Update GPT instructions based on observed behavior (e.g., improve entity extraction, clarify Action usage).
    *   Task: Modify Action schema if API contract needs adjustment.
    *   Task: Update Netlify function logic to fix bugs, improve queries, or handle edge cases found during testing.
    *   Task: Redeploy function and re-test.
    *   Deliverable: Improved GPT instructions, refined Action schema, updated Netlify function code.

---

### Phase 5: Enhancements & Optimization (Ongoing/Optional)

**Objective:** Improve the quality, performance, and feature set beyond the core functionality.

1.  **Advanced Retrieval:** Implement more sophisticated search strategies (e.g., hybrid search, filtering by metadata, time-based decay).
2.  **Context Management:** Improve how the GPT handles multi-turn conversations related to memories.
3.  **File Handling:** Fully implement robust file analysis, metadata extraction, and storage (if not part of the initial scope).
4.  **User Feedback Mechanism:** Consider ways to allow users to correct the GPT's memory or understanding.
5.  **Performance Optimization:** Optimize Netlify function cold starts, database query performance.
6.  **Enhanced Logging/Monitoring:** Integrate more advanced logging or monitoring tools.

---

### Phase 6: Documentation & Launch (Est. 1 week)

**Objective:** Finalize documentation and prepare for wider use (if applicable).

1.  **Documentation:**
    *   Task: Clean up and finalize documentation for the OpenAPI schema.
    *   Task: Document the Netlify function's logic, setup, and environment variables.
    *   Task: Document the final Custom GPT instructions and configuration decisions.
    *   Deliverable: Project documentation package.
2.  **Final Checks:**
    *   Task: Perform final regression testing.
    *   Task: Review security configurations (API keys, database access rules).
    *   Deliverable: Pre-launch checklist passed.
3.  **Launch/Sharing:**
    *   Task: Publish the Custom GPT (options: private, link-sharing, GPT Store).
    *   Deliverable: Accessible Custom GPT.

---

This roadmap provides a structured approach. Timelines are estimates and depend on complexity and available resources. Remember to iterate and adapt as you learn more during development! Let me know which parts you'd like to refine or provide input for first (e.g., Database Schema).
