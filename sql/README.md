# Memory Locker Supabase SQL Schema

This folder contains the SQL schema for the Memory Locker application's Supabase database.

## Files

- `schema.sql` - The main schema file with all table definitions, security policies, and indexes
- `common_queries.sql` - Example SQL queries for common operations

## Database Structure

The database is designed to handle multiple file types (audio, images, documents) and their processing through various AI services.

### Main Tables

1. **users** - User accounts
2. **files** - Central storage for all file types with metadata
3. **queries** - Search queries and results
4. **user_query_history** - History of user interactions
5. **personas** - Digital personas with identity information
6. **persona_transactions** - Memories and information extracted for personas
7. **file_manager_log** - File processing tracking
8. **transcript_embeddings** - Vector embeddings for semantic search

### Vector Search

The `transcript_embeddings` table stores text chunks and their vector embeddings using OpenAI's small embedding model (`text-embedding-3-small`). This enables powerful semantic search capabilities:

- Each text chunk is stored with its 1536-dimension vector embedding
- The table uses Postgres' `pgvector` extension for similarity searches
- Embeddings are linked to their source files for context
- **Important:** For efficient vector search, an HNSW index should be created manually *after* applying this schema.

### Relationships

- Files are owned by users
- Queries are made by users
- Personas are created by users
- Persona transactions link to personas, files, and queries
- Query history links to users and queries
- Vector embeddings link to their source files

### Security

Row-level security (RLS) is **enabled** on all tables. However, no specific `ALLOW` policies are defined (using a 'default deny' approach). This means only roles that bypass RLS (like the `service_role` key used by the backend function) have access. It acts as a defense-in-depth measure.

## How to Use

1. Go to your Supabase project's SQL Editor
2. Copy and paste the contents of `schema.sql`
3. Run the SQL to create the database structure
4. Use examples from `common_queries.sql` for common operations

## Vector Setup Requirements

To use the vector embeddings functionality:

1. Enable the `pgvector` extension in your Supabase project:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

2. When generating embeddings (e.g., within the Netlify function), use the **`text-embedding-3-small`** model.
3. Store the resulting **1536-dimension** vectors in the `transcript_embeddings.embedding` column.
4. Perform similarity searches using the `<=>` operator (cosine distance).
5. **Create an HNSW index manually after setting up the table:** Ensure only *one* HNSW index exists on the `embedding` column for optimal performance.
   ```sql
   -- Example using cosine distance, recommended for OpenAI embeddings
   CREATE INDEX ON transcript_embeddings USING hnsw (embedding vector_cosine_ops);
   ```
   *(You might need to drop automatically generated or duplicate indexes on this column if they exist)*.

## Notes

- UUID is used as the primary key type for all tables
- Timestamps are used to track creation and update times
- Foreign keys maintain referential integrity
- Indexing is added for common search operations
- An HNSW index on transcript_embeddings.embedding is crucial for performance and must be added manually.

### Schema Parts

1.  **Tables:** Defines the structure for storing users, files, embeddings, personas, queries, logs, and transactions.
2.  **Security Policies (RLS):** Enables Row Level Security on all tables using a 'default deny' approach (no specific `ALLOW` policies). Access relies on roles that bypass RLS (e.g., `service_role`).
3.  **Performance Indexes:** Includes standard B-tree indexes for common query filtering and an HNSW index on the `transcript_embeddings.embedding` column for efficient vector similarity searches.
4.  **Functions:** Contains helper functions, such as `search_memory_chunks` for performing vector searches.

### Key Tables

1. **users** - User accounts
2. **files** - Central storage for all file types with metadata
3. **queries** - Search queries and results
4. **user_query_history** - History of user interactions
5. **personas** - Digital personas with identity information
6. **persona_transactions** - Memories and information extracted for personas
7. **file_manager_log** - File processing tracking
8. **transcript_embeddings** - Vector embeddings for semantic search 