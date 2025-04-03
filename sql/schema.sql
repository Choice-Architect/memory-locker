-- DATABASE SCHEMA FOR MEMORY LOCKER
-- =================================

-- PART 1: TABLE DEFINITIONS
-- =================================

-- Users Table: Stores basic user identity and authentication information
CREATE TABLE users (
    id UUID PRIMARY KEY,                        -- Unique identifier for each user
    username TEXT,                              -- User's chosen display name
    email TEXT UNIQUE,                          -- User's email (must be unique)
    created_at TIMESTAMPTZ DEFAULT now(),       -- When the user account was created
    updated_at TIMESTAMPTZ                      -- When the user account was last modified
);

-- Files Table: Central storage for all file types with metadata
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique identifier for each file, auto-generated
    user_id UUID REFERENCES users(id),          -- Links to the owner in users table
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
    user_id UUID REFERENCES users(id),          -- Links to the user who made the query
    query_text TEXT,                            -- The actual search text
    source TEXT CHECK (source IN ('vector_store', 'postgres_fallback', 'persona_profile')),  -- Where results came from
    result JSONB,                               -- Structured storage for search results
    created_at TIMESTAMPTZ DEFAULT now()        -- When the query was made
);

-- User Query History: Maintains a searchable history of user interactions
CREATE TABLE user_query_history (
    id UUID PRIMARY KEY,                        -- Unique identifier for history entry
    user_id UUID REFERENCES users(id),          -- Links to the user who made the query
    query_id UUID REFERENCES queries(id) ON DELETE CASCADE,  -- Links to the query record (will be deleted if query is deleted)
    query_text TEXT,                            -- Duplicate of query text for faster access
    result_snippet TEXT,                        -- Short version of the result for display
    created_at TIMESTAMPTZ DEFAULT now()        -- When the history entry was created
);

-- Personas Table: Stores identity information for digital personas
CREATE TABLE personas (
    id UUID PRIMARY KEY,                        -- Unique identifier for each persona
    user_id UUID REFERENCES users(id),          -- Links to the user who owns this persona
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

-- Enable Row Level Security on all tables
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE persona_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_query_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_manager_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_embeddings ENABLE ROW LEVEL SECURITY;

-- Create access policies for files table
CREATE POLICY "Users can view their own files" 
ON files FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can insert their own files" 
ON files FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can update their own files" 
ON files FOR UPDATE USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can delete their own files" 
ON files FOR DELETE USING (user_id = (SELECT auth.uid()));

-- Create access policies for queries table
CREATE POLICY "Users can view their own queries" 
ON queries FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can insert their own queries" 
ON queries FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

-- Create access policies for personas table
CREATE POLICY "Users can view their own personas" 
ON personas FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can insert their own personas" 
ON personas FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can update their own personas" 
ON personas FOR UPDATE USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can delete their own personas" 
ON personas FOR DELETE USING (user_id = (SELECT auth.uid()));

-- Create access policies for persona_transactions table
CREATE POLICY "Users can view transactions for their personas" 
ON persona_transactions FOR SELECT
USING (EXISTS (
    SELECT 1 FROM personas 
    WHERE personas.id = persona_transactions.persona_id 
    AND personas.user_id = (SELECT auth.uid())
));

CREATE POLICY "Users can insert transactions for their personas" 
ON persona_transactions FOR INSERT
WITH CHECK (EXISTS (
    SELECT 1 FROM personas 
    WHERE personas.id = persona_transactions.persona_id 
    AND personas.user_id = (SELECT auth.uid())
));

-- Create access policies for user_query_history table
CREATE POLICY "Users can view their own query history" 
ON user_query_history FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can insert their own query history" 
ON user_query_history FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

-- Create access policies for file_manager_log table
CREATE POLICY "Users can view logs for their files" 
ON file_manager_log FOR SELECT
USING (EXISTS (
    SELECT 1 FROM files 
    WHERE files.id = file_manager_log.file_id 
    AND files.user_id = (SELECT auth.uid())
));

-- Create access policies for transcript_embeddings table
CREATE POLICY "Users can access their own embeddings" 
ON transcript_embeddings FOR SELECT
USING (EXISTS (
    SELECT 1 FROM files 
    WHERE files.id = transcript_embeddings.file_id 
    AND files.user_id = (SELECT auth.uid())
));

-- PART 3: PERFORMANCE INDEXES
-- =================================

-- Indexes for files table
CREATE INDEX idx_files_user_id ON files(user_id);
CREATE INDEX idx_files_file_type ON files(file_type);
CREATE INDEX idx_files_conversation_id ON files(conversation_id);

-- Indexes for queries table
CREATE INDEX idx_queries_user_id ON queries(user_id);

-- Indexes for personas table
CREATE INDEX idx_personas_user_id ON personas(user_id);

-- Indexes for persona_transactions table
CREATE INDEX idx_transactions_persona_id ON persona_transactions(persona_id);
CREATE INDEX idx_transactions_file_id ON persona_transactions(file_id);
CREATE INDEX idx_transactions_query_id ON persona_transactions(query_id);
CREATE INDEX idx_transactions_memory_type ON persona_transactions(memory_type);

-- Indexes for user_query_history table
CREATE INDEX idx_user_query_history_user_id ON user_query_history(user_id);
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