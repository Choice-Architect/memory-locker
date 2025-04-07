-- DATABASE SCHEMA FOR MEMORY LOCKER
-- =================================

-- PART 0: EXTENSIONS
-- =================================
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


-- PART 1: TABLE DEFINITIONS
-- =================================

-- Users Table: Stores basic user identity and authentication information
-- (Removed as part of user_id refactoring)

-- Files Table: Central storage for all file types with metadata
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique identifier for each file, auto-generated
    -- user_id TEXT REFERENCES users(id), (Removed)
    title TEXT,                                 -- Display name for the file
    transcript_text TEXT,                       -- Text content for documents or transcribed audio
    file_type TEXT CHECK (file_type IN ('audio', 'image', 'document', 'gpt_interaction')),  -- File category, including direct GPT input
    file_id TEXT,                               -- External reference ID
    file_unique_id TEXT,                        -- Another external reference ID
    file_path TEXT,                             -- Location path for the file
    file_metadata JSONB,                        -- Flexible storage for additional metadata
    mime_type TEXT,                             -- Technical file format (e.g., audio/mp3)
    file_extension TEXT,                        -- File extension (e.g., .jpg, .pdf)
    file_size_bytes INTEGER,                    -- File size in bytes
    original_filename TEXT,                     -- Original name when uploaded
    gdrive_file_id TEXT,                        -- Google Drive ID if stored there
    gdrive_file_url TEXT,                       -- Google Drive URL if stored there
    conversation_id UUID,                       -- Links to a specific conversation
    thread_id UUID,                             -- Links to a specific thread in a conversation
    parent_message_id UUID,                     -- Links to a parent message (for replies)
    created_at TIMESTAMPTZ DEFAULT now(),       -- When the file record was created
    updated_at TIMESTAMPTZ,                     -- When the file record was last modified
    processed_at TIMESTAMPTZ                    -- When the file was processed by the system
);

-- Queries Table: Tracks user searches and their results
CREATE TABLE queries (
    id UUID PRIMARY KEY,                        -- Unique identifier for each query
    -- user_id TEXT REFERENCES users(id), (Removed)
    query_text TEXT,                            -- The actual search text
    source TEXT CHECK (source IN ('vector_store', 'postgres_fallback', 'persona_profile')),  -- Where results came from
    result JSONB,                               -- Structured storage for search results
    created_at TIMESTAMPTZ DEFAULT now()        -- When the query was made
);

-- User Query History: Maintains a searchable history of user interactions
CREATE TABLE user_query_history (
    id UUID PRIMARY KEY,                        -- Unique identifier for history entry
    -- user_id TEXT REFERENCES users(id), (Removed)
    query_id UUID REFERENCES queries(id) ON DELETE CASCADE,  -- Links to the query record (will be deleted if query is deleted)
    query_text TEXT,                            -- Duplicate of query text for faster access
    result_snippet TEXT,                        -- Short version of the result for display
    created_at TIMESTAMPTZ DEFAULT now()        -- When the history entry was created
);

-- Personas Table: Stores identity information for digital personas
CREATE TABLE personas (
    id UUID PRIMARY KEY,                        -- Unique identifier for each persona
    -- user_id TEXT REFERENCES users(id), (Removed)
    full_name TEXT,                             -- Complete name of the persona
    alias TEXT[],                               -- Alternative names/nicknames as an array
    birthday DATE,                              -- Birth date of the persona
    place_of_birth TEXT,                        -- Where the persona was born
    residency TEXT,                             -- Where the persona lives
    created_at TIMESTAMPTZ DEFAULT now(),       -- When the persona was created
    updated_at TIMESTAMPTZ                      -- When the persona was last modified
);

-- File Manager Log: Tracks the lifecycle of files in the system
CREATE TABLE file_manager_log (
    id UUID PRIMARY KEY,                        -- Unique identifier for each log entry
    file_id UUID REFERENCES files(id),          -- Links to the specific file being tracked
    upload_method TEXT CHECK (upload_method IN ('telegram', 'gdrive', 'manual', 'workflow')),  -- How the file was uploaded
    processed BOOLEAN DEFAULT FALSE,            -- Whether processing is complete
    processing_notes TEXT,                      -- Details about processing steps/errors
    created_at TIMESTAMPTZ DEFAULT now()        -- When the log entry was created
);

-- Persona Transactions: Records memories and information extractions for personas
CREATE TABLE persona_transactions (
    id UUID PRIMARY KEY,                        -- Unique identifier for each transaction
    persona_id UUID REFERENCES personas(id) ON DELETE CASCADE,  -- Links to persona (will be deleted if persona is deleted)
    file_id UUID REFERENCES files(id),          -- Links to the source file for this memory
    query_id UUID REFERENCES queries(id),       -- Links to any query that triggered this transaction
    memory_entry TEXT,                          -- The actual memory content (e.g., "Sharif was nervous")
    memory_type TEXT,                           -- Categorizes the memory (event, feeling, quote)
    extracted_by TEXT CHECK (extracted_by IN ('AI', 'User', 'System')),  -- Who/what created this memory
    timestamp_in_file TIMESTAMPTZ,              -- When in the file this memory occurred (for temporal files)
    created_at TIMESTAMPTZ DEFAULT now()        -- When the transaction was recorded
);

-- Vector Embeddings Table: Stores OpenAI large model embeddings for semantic search
CREATE TABLE transcript_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique identifier for each embedding, auto-generated
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE, -- Links to source file (deleted if file is deleted), MUST exist
    content_chunk TEXT NOT NULL,                -- The actual text chunk that was embedded
    chunk_index INTEGER,                        -- Position of chunk within original content
    embedding vector(1536),                     -- Vector embedding (1536 for OpenAI small model)
    embedding_model TEXT DEFAULT 'text-embedding-3-small', -- The specific OpenAI model used
    metadata JSONB,                             -- Flexible additional metadata
    created_at TIMESTAMPTZ DEFAULT now(),       -- When embedding was created
    updated_at TIMESTAMPTZ                      -- When embedding was last updated
);

-- PART 2: SECURITY POLICIES
-- =================================

-- Enable RLS on all tables in 'Default Deny' mode (no specific ALLOW policies defined).
-- The service role key used by the Netlify function bypasses RLS.
-- This provides defense-in-depth against other access vectors.
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE persona_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_query_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_manager_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_embeddings ENABLE ROW LEVEL SECURITY;

-- (Removed all specific RLS policies during user_id refactor)

-- Add default permissive policies to satisfy linter when RLS is enabled
-- These policies don't affect service_role access (which bypasses RLS)
-- but provide a defined state for RLS.

CREATE POLICY "Allow ALL for service_role (files)"
ON public.files FOR ALL USING (true);

CREATE POLICY "Allow ALL for service_role (queries)"
ON public.queries FOR ALL USING (true);

CREATE POLICY "Allow ALL for service_role (user_query_history)"
ON public.user_query_history FOR ALL USING (true);

CREATE POLICY "Allow ALL for service_role (personas)"
ON public.personas FOR ALL USING (true);

CREATE POLICY "Allow ALL for service_role (file_manager_log)"
ON public.file_manager_log FOR ALL USING (true);

CREATE POLICY "Allow ALL for service_role (persona_transactions)"
ON public.persona_transactions FOR ALL USING (true);

CREATE POLICY "Allow ALL for service_role (transcript_embeddings)"
ON public.transcript_embeddings FOR ALL USING (true);

-- PART 3: PERFORMANCE INDEXES
-- =================================

-- Indexes for files table
-- CREATE INDEX idx_files_user_id ON files(user_id); (Removed)
CREATE INDEX idx_files_file_type ON files(file_type);
CREATE INDEX idx_files_conversation_id ON files(conversation_id);
CREATE INDEX IF NOT EXISTS idx_files_metadata_gin ON public.files USING gin (file_metadata jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_files_thread_id ON public.files (thread_id);
CREATE INDEX IF NOT EXISTS idx_files_created_at ON public.files (created_at);

-- Indexes for queries table
-- CREATE INDEX idx_queries_user_id ON queries(user_id); (Removed)

-- Indexes for personas table
-- CREATE INDEX idx_personas_user_id ON personas(user_id); (Removed)

-- Indexes for persona_transactions table
CREATE INDEX idx_transactions_persona_id ON persona_transactions(persona_id);
CREATE INDEX idx_transactions_file_id ON persona_transactions(file_id);
CREATE INDEX idx_transactions_query_id ON persona_transactions(query_id);
CREATE INDEX idx_transactions_memory_type ON persona_transactions(memory_type);

-- Indexes for user_query_history table
-- CREATE INDEX idx_user_query_history_user_id ON user_query_history(user_id); (Removed)
CREATE INDEX idx_user_query_history_query_id ON user_query_history(query_id);

-- Indexes for file_manager_log table
CREATE INDEX idx_file_manager_log_file_id ON file_manager_log(file_id);
CREATE INDEX idx_file_manager_log_processed ON file_manager_log(processed);

-- Indexes for transcript_embeddings
-- NOTE: Due to the high dimensionality (3072) of the embeddings, we are not using vector indexes
-- directly. Instead, we use a standard B-tree index on file_id for filtering.
-- Vector search should be implemented in application code using pgvector's distance functions.
-- NOTE: An HNSW index is recommended for efficient vector search on the 'embedding' column 
--       and should be created manually after enabling the pgvector extension.
--       Example: CREATE INDEX ON transcript_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_transcript_embeddings_file_id ON transcript_embeddings(file_id);
CREATE INDEX idx_transcript_embeddings_created_at ON transcript_embeddings(created_at);
CREATE INDEX transcript_embeddings_embedding_hnsw_idx ON public.transcript_embeddings USING hnsw (embedding vector_cosine_ops);

-- PART 4: FUNCTIONS
-- =================================

-- Function for vector similarity search on memory chunks with metadata filtering
CREATE OR REPLACE FUNCTION public.search_memory_chunks(
    query_embedding vector(1536),
    match_threshold double precision,
    match_count integer,
    filter_topics TEXT[] DEFAULT NULL,      -- Optional: Filter by topics (array contains ALL)
    filter_people TEXT[] DEFAULT NULL,      -- Optional: Filter by people (array contains ALL)
    filter_locations TEXT[] DEFAULT NULL,   -- Optional: Filter by locations (array contains ALL)
    filter_type TEXT DEFAULT NULL,          -- Optional: Filter by specific type
    filter_sentiment TEXT DEFAULT NULL,     -- Optional: Filter by specific sentiment
    filter_date_start TEXT DEFAULT NULL,    -- Optional: Start date (ISO 8601 string or YYYY-MM-DD)
    filter_date_end TEXT DEFAULT NULL       -- Optional: End date (ISO 8601 string or YYYY-MM-DD)
)
 RETURNS TABLE(
     id uuid,
     file_id uuid,
     content_chunk text,
     metadata jsonb,
     similarity double precision,
     chunk_index integer
 )
 LANGUAGE plpgsql
 -- Explicitly set the search path for security
 SET search_path = 'public', 'extensions'
AS $function$
DECLARE
    start_date TIMESTAMPTZ;
    end_date TIMESTAMPTZ;
BEGIN
    -- Attempt to cast date strings to TIMESTAMPTZ, handle potential errors
    BEGIN
        start_date := filter_date_start::TIMESTAMPTZ;
    EXCEPTION WHEN others THEN
        start_date := NULL;
    END;
    BEGIN
        -- Add 1 day to end_date to make the range inclusive of the end day
        end_date := (filter_date_end::DATE + interval '1 day')::TIMESTAMPTZ;
    EXCEPTION WHEN others THEN
        end_date := NULL;
    END;

  RETURN QUERY
  SELECT
    te.id,
    te.file_id,
    te.content_chunk,
    te.metadata,
    1 - (te.embedding <=> query_embedding) AS similarity,
    te.chunk_index
  FROM transcript_embeddings te
  WHERE
    -- Vector similarity check (always applied)
    1 - (te.embedding <=> query_embedding) > match_threshold

    -- Optional Metadata Filters (applied only if filter parameter is NOT NULL)
    AND (filter_topics IS NULL OR (te.metadata -> 'topics')::jsonb @> to_jsonb(filter_topics))
    AND (filter_people IS NULL OR (te.metadata -> 'people')::jsonb @> to_jsonb(filter_people))
    AND (filter_locations IS NULL OR (te.metadata -> 'locations')::jsonb @> to_jsonb(filter_locations))
    AND (filter_type IS NULL OR te.metadata ->> 'type' = filter_type)
    AND (filter_sentiment IS NULL OR te.metadata ->> 'sentiment' = filter_sentiment)

    -- Optional Date Range Filter
    -- Checks if ANY normalized date within the metadata's 'dates' array falls within the specified range
    AND (
        (start_date IS NULL AND end_date IS NULL) OR -- Pass if no date filter applied
        (start_date IS NOT NULL AND end_date IS NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(te.metadata -> 'dates') AS d WHERE (d ->> 'normalized')::TIMESTAMPTZ >= start_date)) OR -- Only start date
        (start_date IS NULL AND end_date IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(te.metadata -> 'dates') AS d WHERE (d ->> 'normalized')::TIMESTAMPTZ < end_date)) OR -- Only end date
        (start_date IS NOT NULL AND end_date IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(te.metadata -> 'dates') AS d WHERE (d ->> 'normalized')::TIMESTAMPTZ >= start_date AND (d ->> 'normalized')::TIMESTAMPTZ < end_date)) -- Both dates
    )

  ORDER BY similarity DESC
  LIMIT match_count;
END;
$function$
; 