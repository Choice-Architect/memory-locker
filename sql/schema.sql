SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fts_search_files"("query_string" "text", "match_count" integer) RETURNS TABLE("id" "uuid", "transcript_text" "text", "created_at" timestamp with time zone, "file_metadata" "jsonb", "rank" real)
    LANGUAGE "sql" VOLATILE
    SET "search_path" TO 'pg_catalog', 'public', 'extensions'
    AS $$
  SELECT
    f.id,
    f.transcript_text,
    f.created_at,
    f.file_metadata,
    ts_rank(f.transcript_tsv, websearch_to_tsquery('english', query_string)) as rank
  FROM files f
  WHERE f.transcript_tsv @@ websearch_to_tsquery('english', query_string)
  ORDER BY rank DESC
  LIMIT match_count;
$$;


ALTER FUNCTION "public"."fts_search_files"("query_string" "text", "match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_memory_chunks"("query_embedding" "extensions"."vector", "match_threshold" double precision, "match_count" integer) RETURNS TABLE("file_id" "uuid", "content_chunk" "text", "metadata" "jsonb", "similarity" double precision, "chunk_index" integer)
    LANGUAGE "sql" VOLATILE
    SET "search_path" TO 'pg_catalog', 'public', 'extensions'
    AS $$
  SELECT
    te.file_id,
    te.content_chunk,
    te.metadata,
    1 - (te.embedding <=> query_embedding) as similarity,
    (te.metadata->>'chunk_index')::int as chunk_index
  FROM transcript_embeddings te
  WHERE 1 - (te.embedding <=> query_embedding) > match_threshold
  ORDER BY te.embedding <=> query_embedding
  LIMIT match_count;
$$;


ALTER FUNCTION "public"."search_memory_chunks"("query_embedding" "extensions"."vector", "match_threshold" double precision, "match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_transcript_tsv"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    -- Use coalesce to handle potential null transcript_text
    NEW.transcript_tsv := to_tsvector('english', coalesce(NEW.transcript_text, ''));
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_transcript_tsv"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."update_transcript_tsv"() IS 'Trigger function to update files.transcript_tsv on insert/update';


SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."file_manager_log" (
    "id" "uuid" NOT NULL,
    "file_id" "uuid",
    "upload_method" "text",
    "processed" boolean DEFAULT false,
    "processing_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "file_manager_log_upload_method_check" CHECK (("upload_method" = ANY (ARRAY['telegram'::"text", 'gdrive'::"text", 'manual'::"text", 'workflow'::"text"])))
);


ALTER TABLE "public"."file_manager_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."files" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text",
    "transcript_text" "text",
    "file_type" "text",
    "file_id" "text",
    "file_unique_id" "text",
    "file_path" "text",
    "file_metadata" "jsonb",
    "mime_type" "text",
    "file_extension" "text",
    "file_size_bytes" integer,
    "original_filename" "text",
    "gdrive_file_id" "text",
    "gdrive_file_url" "text",
    "conversation_id" "uuid",
    "thread_id" "uuid",
    "parent_message_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone,
    "processed_at" timestamp with time zone,
    "transcript_tsv" "tsvector",
    CONSTRAINT "files_file_type_check" CHECK (("file_type" = ANY (ARRAY['audio'::"text", 'image'::"text", 'document'::"text", 'gpt_interaction'::"text"])))
);


ALTER TABLE "public"."files" OWNER TO "postgres";


COMMENT ON COLUMN "public"."files"."transcript_tsv" IS 'Pre-computed tsvector for full-text search on transcript_text';



CREATE TABLE IF NOT EXISTS "public"."persona_transactions" (
    "id" "uuid" NOT NULL,
    "persona_id" "uuid",
    "file_id" "uuid",
    "query_id" "uuid",
    "memory_entry" "text",
    "memory_type" "text",
    "extracted_by" "text",
    "timestamp_in_file" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "persona_transactions_extracted_by_check" CHECK (("extracted_by" = ANY (ARRAY['AI'::"text", 'User'::"text", 'System'::"text"])))
);


ALTER TABLE "public"."persona_transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."personas" (
    "id" "uuid" NOT NULL,
    "full_name" "text",
    "alias" "text"[],
    "birthday" "date",
    "place_of_birth" "text",
    "residency" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone
);


ALTER TABLE "public"."personas" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."queries" (
    "id" "uuid" NOT NULL,
    "query_text" "text",
    "source" "text",
    "result" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "queries_source_check" CHECK (("source" = ANY (ARRAY['vector_store'::"text", 'postgres_fallback'::"text", 'persona_profile'::"text"])))
);


ALTER TABLE "public"."queries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."transcript_embeddings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "file_id" "uuid" NOT NULL,
    "content_chunk" "text" NOT NULL,
    "chunk_index" integer,
    "embedding" "extensions"."vector"(1536),
    "embedding_model" "text" DEFAULT 'text-embedding-3-small'::"text",
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone
);


ALTER TABLE "public"."transcript_embeddings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_query_history" (
    "id" "uuid" NOT NULL,
    "query_id" "uuid",
    "query_text" "text",
    "result_snippet" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_query_history" OWNER TO "postgres";


ALTER TABLE ONLY "public"."file_manager_log"
    ADD CONSTRAINT "file_manager_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."files"
    ADD CONSTRAINT "files_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."persona_transactions"
    ADD CONSTRAINT "persona_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personas"
    ADD CONSTRAINT "personas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."queries"
    ADD CONSTRAINT "queries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."transcript_embeddings"
    ADD CONSTRAINT "transcript_embeddings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_query_history"
    ADD CONSTRAINT "user_query_history_pkey" PRIMARY KEY ("id");



CREATE INDEX "files_transcript_tsv_idx" ON "public"."files" USING "gin" ("transcript_tsv");



CREATE INDEX "idx_file_manager_log_file_id" ON "public"."file_manager_log" USING "btree" ("file_id");



CREATE INDEX "idx_file_manager_log_processed" ON "public"."file_manager_log" USING "btree" ("processed");



CREATE INDEX "idx_files_conversation_id" ON "public"."files" USING "btree" ("conversation_id");



CREATE INDEX "idx_files_created_at" ON "public"."files" USING "btree" ("created_at");



CREATE INDEX "idx_files_file_type" ON "public"."files" USING "btree" ("file_type");



CREATE INDEX "idx_files_thread_id" ON "public"."files" USING "btree" ("thread_id");



CREATE INDEX "idx_gin_files_metadata" ON "public"."files" USING "gin" ("file_metadata" "jsonb_path_ops");



CREATE INDEX "idx_transactions_file_id" ON "public"."persona_transactions" USING "btree" ("file_id");



CREATE INDEX "idx_transactions_memory_type" ON "public"."persona_transactions" USING "btree" ("memory_type");



CREATE INDEX "idx_transactions_persona_id" ON "public"."persona_transactions" USING "btree" ("persona_id");



CREATE INDEX "idx_transactions_query_id" ON "public"."persona_transactions" USING "btree" ("query_id");



CREATE INDEX "idx_transcript_embeddings_created_at" ON "public"."transcript_embeddings" USING "btree" ("created_at");



CREATE INDEX "idx_transcript_embeddings_file_id" ON "public"."transcript_embeddings" USING "btree" ("file_id");



CREATE INDEX "idx_transcript_embeddings_metadata_gin" ON "public"."transcript_embeddings" USING "gin" ("metadata" "jsonb_path_ops");



CREATE INDEX "idx_user_query_history_query_id" ON "public"."user_query_history" USING "btree" ("query_id");



CREATE INDEX "transcript_embeddings_embedding_hnsw_idx" ON "public"."transcript_embeddings" USING "hnsw" ("embedding" "extensions"."vector_cosine_ops");



CREATE OR REPLACE TRIGGER "files_tsv_update" BEFORE INSERT OR UPDATE ON "public"."files" FOR EACH ROW EXECUTE FUNCTION "public"."update_transcript_tsv"();



ALTER TABLE ONLY "public"."file_manager_log"
    ADD CONSTRAINT "file_manager_log_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id");



ALTER TABLE ONLY "public"."persona_transactions"
    ADD CONSTRAINT "persona_transactions_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id");



ALTER TABLE ONLY "public"."persona_transactions"
    ADD CONSTRAINT "persona_transactions_persona_id_fkey" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."persona_transactions"
    ADD CONSTRAINT "persona_transactions_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "public"."queries"("id");



ALTER TABLE ONLY "public"."transcript_embeddings"
    ADD CONSTRAINT "transcript_embeddings_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_query_history"
    ADD CONSTRAINT "user_query_history_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "public"."queries"("id") ON DELETE CASCADE;



CREATE POLICY "Allow ALL for service_role (file_manager_log)" ON "public"."file_manager_log" USING (true);



CREATE POLICY "Allow ALL for service_role (files)" ON "public"."files" USING (true);



CREATE POLICY "Allow ALL for service_role (persona_transactions)" ON "public"."persona_transactions" USING (true);



CREATE POLICY "Allow ALL for service_role (personas)" ON "public"."personas" USING (true);



CREATE POLICY "Allow ALL for service_role (queries)" ON "public"."queries" USING (true);



CREATE POLICY "Allow ALL for service_role (transcript_embeddings)" ON "public"."transcript_embeddings" USING (true);



CREATE POLICY "Allow ALL for service_role (user_query_history)" ON "public"."user_query_history" USING (true);



ALTER TABLE "public"."file_manager_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."files" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."persona_transactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."personas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."queries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."transcript_embeddings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_query_history" ENABLE ROW LEVEL SECURITY;


REVOKE USAGE ON SCHEMA "public" FROM PUBLIC;
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON TABLE "public"."files" TO "service_role";



GRANT ALL ON TABLE "public"."transcript_embeddings" TO "service_role";



RESET ALL;
