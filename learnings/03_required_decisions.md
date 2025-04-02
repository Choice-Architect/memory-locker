# Required Inputs & Decisions for Memory Locker Development

This document outlines the key information and decisions needed from you before development can effectively begin on the Memory Locker Custom GPT project, based on the previously defined roadmap. Please provide these details to ensure the project aligns with your vision.

## Phase 1: Foundation & Setup

*   **Database Schema Details:**
    *   **Tables & Columns:** *Defined in `schema.sql`. Key tables: `users`, `files`, `queries`, `transcript_embeddings`. Key columns confirmed: `files.transcript_text`, `files.file_metadata`, `transcript_embeddings.embedding`, `transcript_embeddings.metadata`, timestamps.*
    *   **Relationships:** *Defined via foreign keys in `schema.sql`.*
    *   **Vector Dimensions:** **DECIDED: 1536** (for `text-embedding-3-small`).
    *   **Indexing Strategy:** **DECIDED: Standard indexes + Plan for HNSW index on `transcript_embeddings.embedding` post-setup.**
    *   *Why:* Crucial for setting up the Supabase database correctly.

## Phase 2: Core Action Development (Netlify Function)

*   **Embedding Generation Strategy:**
    *   **DECIDED: Option A - Within the Netlify Function** using OpenAI's `text-embedding-3-small` model.
    *   *Why:* This determines where the embedding model API calls are made.
*   **Core Query Logic:**
    *   **DECIDED: Sequential Approach.**
        1.  Primary: Vector similarity search on `transcript_embeddings`, filtering by chunk-level `metadata` (entities, timestamps).
        2.  Fallback: If needed, structured query on `files` table (filtering by `file_metadata` entities, timestamps, or full-text search).
    *   How should results be ranked or prioritized? *(Decision still pending, can be default similarity score initially).*
    *   *Why:* Defines the core retrieval mechanism within the Netlify function.
*   **Storage/Upsert Logic:**
    *   **DECIDED: Differentiated Metadata Storage.** File-level summary/entities in `files.file_metadata`, chunk-level entities/timestamps in `transcript_embeddings.metadata`.
    *   When data is stored, should it upsert or add? *(Decision still pending, can default to adding new entries initially).*
    *   How to define "similar" for upserting? *(Decision still pending if upserting is chosen).*
    *   *Why:* Determines how new information interacts with existing data.

## Phase 3: Custom GPT Configuration & Action Schema

*   **GPT Persona & Tone:**
    *   How should the Memory Locker GPT behave? (e.g., Formal assistant? Casual friend? Empathetic listener?)
    *   What tone should it use in its responses?
    *   *Why:* Defines the user experience when interacting with the GPT.
*   **Entity Extraction Details:**
    *   What specific types of entities are most important to extract? (Provide a list: e.g., People, Places, Dates, Organizations, Projects, Topics, explicit Reminders).
    *   Are there specific formats to look for (e.g., specific date formats, project codes)?
    *   Should the GPT try to resolve relative dates ("last Tuesday") to absolute dates?
    *   *Why:* Guides the creation of precise instructions for the GPT on what information to identify and structure for the Action.
*   **Action Invocation Triggers:**
    *   Under what specific circumstances should the GPT *always* call the `Memory Action`? (e.g., Any mention of past events? Explicit commands like "remember this"? Questions about the past?)
    *   When should it *consider* calling the Action? (e.g., When discussing known entities?)
    *   When should it *avoid* calling the Action? (e.g., General knowledge questions? Creative writing tasks unrelated to stored memories?)
    *   *Why:* Critical for tuning the GPT's instruction set to ensure the Action is used appropriately and efficiently.
*   **Handling Action Failures:**
    *   How should the GPT respond to the user if the `Memory Action` fails (e.g., Netlify function returns an error)? (e.g., "Sorry, I couldn't access my memory bank right now."? Ask the user to try again?)
    *   *Why:* Defines the user-facing error handling experience.
*   **Authentication Secret:**
    *   What secret API key should the Netlify function expect from the GPT Action call to authenticate it? (You will generate this key and provide it securely).
    *   *Why:* Secures your Netlify function endpoint so only your authorised GPT Action can call it.
*   **Metadata Location & Strategy:**
    *   **DECIDED:**
        *   `files.file_metadata`: Store file-level summary/info and a list of *all key entities* mentioned in the entire `transcript_text`.
        *   `transcript_embeddings.metadata`: Store chunk-level info, specifically entities *mentioned within that chunk* and the interaction timestamp.
    *   *Why:* Provides precision for vector search filtering and a broader context for fallback file searches.
*   **Row-Level Security (RLS) and Netlify Function:**
    *   **DECIDED: Netlify function will use the Supabase service role key, bypassing RLS** for full database access within the single-user-per-deployment context.
    *   *Why:* Simplifies the Action backend logic.
*   **Vector Index:**
    *   **DECIDED: An ANN index (like HNSW) is required for performance.** It will be created manually via SQL after the initial schema setup and `pgvector` enablement.
    *   *Why:* Essential for efficient vector similarity searches.

Please review these points and provide details as they become available. The more information you provide upfront, the smoother the development process will be. We can discuss these further as needed.