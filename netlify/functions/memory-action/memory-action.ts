import { Handler, HandlerEvent, HandlerContext } from "@netlify/functions";
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// --- Interfaces for API Contract ---

interface ExtractedEntities {
    people?: string[];
    dates?: string[];
    locations?: string[];
    topics?: string[];
    // Add other entity types as needed
    [key: string]: string[] | undefined; // Allow flexible entity types
}

interface RequestPayload {
    query_text: string;
    extracted_entities: ExtractedEntities;
    user_id?: string; // Consider how user identity is managed if needed later
    mode: 'store' | 'query' | 'combined';
}

interface ContextObject {
    chunk: string;
    timestamp: string; // ISO 8601 format
    entities_in_chunk: ExtractedEntities; // Note: Currently storing file-level entities here
    file_id?: number; // Reference to the source file
    chunk_id?: number; // Reference to the specific chunk
}

interface SuccessResponse {
    retrieved_context: ContextObject[];
    storage_status: string;
    query_source: 'vector_store' | 'postgres_fallback' | 'none' | 'combined' | 'error'; // Added combined/error
    message_for_gpt?: string;
    error: null;
}

interface ErrorResponse {
    error: string;
}

// --- Constants ---
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536; // Dimension for text-embedding-3-small
const CHUNK_SIZE = 1000; // Target size in characters
const CHUNK_OVERLAP = 200; // Overlap in characters
const VECTOR_MATCH_THRESHOLD = 0.75; // Similarity threshold for vector search
const VECTOR_MATCH_COUNT = 5;     // Max number of chunks to retrieve via vector search

// --- Environment Variables ---
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const actionSecretKey = process.env.ACTION_SECRET_KEY || '';
const openaiApiKey = process.env.OPENAI_API_KEY || '';

// --- Client Initialization ---
let supabase: SupabaseClient;
let openai: OpenAI;

const initializeClients = () => {
    if (!supabase) {
        if (!supabaseUrl || !supabaseServiceRoleKey) {
            throw new Error("Supabase URL or Service Role Key is missing.");
        }
        supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
             auth: {
                persistSession: false // Recommended for serverless functions
            }
        });
    }
    if (!openai) {
        if (!openaiApiKey) {
            throw new Error("OpenAI API Key is missing.");
        }
        openai = new OpenAI({ apiKey: openaiApiKey });
    }
};

// --- Utility Functions ---

/**
 * Simple text chunking function.
 */
function chunkText(text: string, size: number, overlap: number): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + size, text.length);
        chunks.push(text.substring(start, end));
        if (end === text.length) break;
        start += size - overlap;
        // Ensure start doesn't go backward if overlap is large or size is small
        start = Math.max(start, end - overlap);
    }
    return chunks;
}

/**
 * Generates embeddings for an array of text chunks using OpenAI API.
 */
async function generateEmbeddings(chunks: string[]): Promise<(number[] | null)[]> {
    if (!chunks || chunks.length === 0) return [];
    try {
        const response = await openai.embeddings.create({
            model: EMBEDDING_MODEL,
            input: chunks,
            dimensions: EMBEDDING_DIMENSIONS // Specify dimensions for newer models
        });

        // Check if response format is as expected
        if (!response || !response.data || response.data.length !== chunks.length) {
            throw new Error('Unexpected response format from OpenAI embedding API');
        }

        // Sort embeddings back to the original order based on index
        const embeddingsMap = new Map<number, number[]>();
        response.data.forEach(item => {
            embeddingsMap.set(item.index, item.embedding);
        });

        const sortedEmbeddings: (number[] | null)[] = [];
        for (let i = 0; i < chunks.length; i++) {
            sortedEmbeddings.push(embeddingsMap.get(i) || null);
        }
        return sortedEmbeddings;

    } catch (error) {
        console.error("Error generating embeddings:", error);
        throw new Error(`Failed to generate embeddings: ${error instanceof Error ? error.message : String(error)}`);
    }
}


// --- Handler Function ---
const handler: Handler = async (event: HandlerEvent, context: HandlerContext): Promise<{ statusCode: number; body: string; headers?: { [key: string]: string } }> => {
    const headers = { 'Content-Type': 'application/json' };
    try {
        initializeClients(); // Initialize Supabase and OpenAI clients

        // Authentication
        const providedApiKey = event.headers['x-api-key'];
        if (!providedApiKey || providedApiKey !== actionSecretKey) {
            return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' } as ErrorResponse) };
        }

        // Method Check
        if (event.httpMethod !== 'POST') {
            return { statusCode: 405, headers: { ...headers, 'Allow': 'POST' }, body: JSON.stringify({ error: 'Method Not Allowed' } as ErrorResponse) };
        }

        // Request Body Parsing and Validation
        if (!event.body) {
            throw new Error("Request body is missing.");
        }
        const payload: RequestPayload = JSON.parse(event.body);
        if (!payload.query_text || !payload.mode || !payload.extracted_entities) {
             throw new Error("Missing required fields in request body (query_text, mode, extracted_entities).");
        }

        console.log("Parsed Payload:", { mode: payload.mode, text_length: payload.query_text.length, entities: payload.extracted_entities });

        // Initialize response variables
        let retrieved_context: ContextObject[] = [];
        let storage_status: string = "No storage operation requested.";
        let query_source: SuccessResponse['query_source'] = 'none';
        let message_for_gpt: string | undefined = undefined;
        let fileId: number | null = null;


        // 2. Process based on mode
        if (payload.mode === 'store' || payload.mode === 'combined') {
            console.log("Processing 'store' mode...");
            const textToStore = payload.query_text;
            const fileMetadata = payload.extracted_entities; // Using extracted entities as file metadata for now

            // a. Insert into 'files' table
            console.log("Inserting into files table...");
            const { data: fileData, error: fileError } = await supabase
                .from('files')
                .insert({
                    transcript_text: textToStore, // Store the full text
                    file_metadata: fileMetadata, // Store all extracted entities
                    title: textToStore.substring(0, 50) + (textToStore.length > 50 ? '...' : ''), // Simple title
                    file_type: 'gpt_interaction', // Mark as originating from GPT interaction
                    user_id: payload.user_id // Add user_id if available
                })
                .select('id') // Return the ID of the new row
                .single(); // Expect only one row

            if (fileError || !fileData) {
                console.error("Error inserting into files table:", fileError);
                throw new Error(`Failed to store file record: ${fileError?.message || 'No ID returned'}`);
            }
            fileId = fileData.id;
            console.log(`File record created with ID: ${fileId}`);


            // b. Chunk the text
            console.log("Chunking text...");
            const chunks = chunkText(textToStore, CHUNK_SIZE, CHUNK_OVERLAP);
            if (chunks.length === 0) {
                 console.warn("No chunks generated for the provided text.");
                 storage_status = `Stored file record (ID: ${fileId}) but no text chunks were generated or stored.`;
            } else {
                console.log(`Generated ${chunks.length} chunks.`);

                // c. Generate embeddings for chunks
                console.log("Generating embeddings...");
                const embeddings = await generateEmbeddings(chunks);
                const validEmbeddings = embeddings.filter(e => e !== null) as number[][];
                if (validEmbeddings.length !== chunks.length) {
                    // Handle potential partial failure if needed
                    console.warn("Some embeddings could not be generated.");
                     // Decide if we proceed with partial data or throw error
                }

                if (validEmbeddings.length > 0) {
                    // d. Prepare records for 'transcript_embeddings'
                    const timestamp = new Date().toISOString();
                    const embeddingRecords = chunks.map((chunk, index) => {
                        const embedding = embeddings[index];
                        if (!embedding) return null; // Skip if embedding failed for this chunk

                        // For now, chunk metadata only includes timestamp. File-level entities are in 'files' table.
                        // Could add chunk-specific entities later if needed.
                        const chunkMetadata = {
                            created_at: timestamp,
                            // entities_in_chunk: {} // Placeholder for future chunk-specific entity extraction
                        };

                        return {
                            file_id: fileId,
                            content_chunk: chunk,
                            embedding: embedding, // Store the vector
                            metadata: chunkMetadata, // Store chunk-level metadata
                        };
                    }).filter(record => record !== null); // Filter out null records due to embedding failures

                    // e. Insert into 'transcript_embeddings' table
                    if (embeddingRecords.length > 0) {
                        console.log(`Inserting ${embeddingRecords.length} embedding records...`);
                        const { error: embeddingError } = await supabase
                            .from('transcript_embeddings')
                            .insert(embeddingRecords);

                        if (embeddingError) {
                            console.error("Error inserting into transcript_embeddings table:", embeddingError);
                            // Potentially attempt to delete the file record for consistency? Or report partial success.
                            storage_status = `Stored file record (ID: ${fileId}) but failed to store embeddings: ${embeddingError.message}`;
                            // Optionally throw error instead: throw new Error(`Failed to store embeddings: ${embeddingError.message}`);
                        } else {
                             console.log("Embedding records inserted successfully.");
                            storage_status = `Successfully stored file record (ID: ${fileId}) and ${embeddingRecords.length} text chunks with embeddings.`;
                        }
                    } else {
                        console.warn("No valid embedding records to insert.");
                        storage_status = `Stored file record (ID: ${fileId}) but no valid embeddings were generated to store.`;
                    }
                } else {
                     console.warn("No embeddings were generated successfully.");
                     storage_status = `Stored file record (ID: ${fileId}) but failed to generate any embeddings.`;
                }
            }

        } // End of 'store'/'combined' block

        if (payload.mode === 'query' || payload.mode === 'combined') {
            console.log("Processing 'query' mode...");
            const queryText = payload.query_text;

            // a. Generate embedding for the query text
            console.log("Generating query embedding...");
            const queryEmbeddingResponse = await generateEmbeddings([queryText]); // Use existing function
            const queryEmbedding = queryEmbeddingResponse[0];

            if (!queryEmbedding) {
                console.error("Failed to generate embedding for the query text.");
                message_for_gpt = "Could not process the query embedding.";
                query_source = 'error'; // Indicate an error state
                // Decide if we should throw an error or return partial results
            } else {
                console.log("Query embedding generated successfully.");

                // b. Perform filtered vector search using the RPC function
                console.log("Performing vector search...");

                // Prepare metadata filter if entities are present
                // Simple filter: matching any provided entity - adapt as needed
                // Currently, the RPC filters on transcript_embeddings.metadata, which only has created_at.
                // To filter by entities, they need to be in transcript_embeddings.metadata.
                // OR adjust the RPC function/query logic.
                // For now, we'll call without entity filtering in the RPC.
                // Filtering could potentially be done client-side after retrieval if necessary.
                const filterMetadata = {}; // Empty filter for now - adjust if needed

                const { data: vectorResults, error: rpcError } = await supabase.rpc(
                    'search_memory_chunks',
                    {
                        query_embedding: queryEmbedding,
                        match_threshold: VECTOR_MATCH_THRESHOLD,
                        match_count: VECTOR_MATCH_COUNT,
                        filter_metadata: filterMetadata // Pass the filter object
                    }
                );

                if (rpcError) {
                    console.error("Error calling search_memory_chunks RPC:", rpcError);
                    message_for_gpt = "Error searching memories.";
                    query_source = 'error';
                } else if (vectorResults && vectorResults.length > 0) {
                    console.log(`Found ${vectorResults.length} potential matches via vector search.`);
                    query_source = 'vector_store';

                    // c. Format results into ContextObject[]
                    retrieved_context = vectorResults.map((row: any) => ({
                        chunk: row.content_chunk,
                        // Assuming metadata contains timestamp, adjust if schema differs
                        timestamp: row.metadata?.created_at || new Date(0).toISOString(),
                        // Add file-level entities here? Requires fetching from files table or joining in RPC.
                        // For now, returning empty object or potentially chunk-level if added to metadata
                        entities_in_chunk: row.metadata?.entities_in_chunk || {},
                        file_id: row.file_id,
                        chunk_id: row.id,
                        similarity: row.similarity // Include similarity score if useful for GPT
                    }));

                    message_for_gpt = `Found ${vectorResults.length} relevant context snippets.`;

                    // d. (Optional Fallback Logic - Placeholder)
                    // if (vectorResults.length < SOME_THRESHOLD) {
                    //    console.log("Vector search results low, considering fallback...");
                    //    // Implement fallback search on 'files' table here
                    //    // query_source = 'combined' or 'postgres_fallback';
                    // }

                } else {
                    console.log("No relevant matches found via vector search.");
                    message_for_gpt = "I couldn't find any specific memories matching your query.";
                    query_source = 'none'; // Or 'vector_store' if you want to indicate it was tried
                }
            }
        } // End of 'query'/'combined' block


        // 3. Format Success Response
        const successResponse: SuccessResponse = {
            retrieved_context,
            storage_status,
            query_source,
            message_for_gpt,
            error: null,
        };

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(successResponse),
        };

    } catch (error: unknown) {
        // 4. Format Error Response
        console.error("Error processing request:", error); // Log the full error

        let statusCode = 500; // Default to Internal Server Error
        let errorMessage = "An unexpected internal error occurred.";

        if (error instanceof Error) {
            errorMessage = error.message; // Use the actual error message

            // Set specific status codes for common client-side errors
            if (errorMessage.includes("Unauthorized") || errorMessage.includes("API key") || errorMessage.includes("ACTION_SECRET_KEY")) {
                statusCode = 401; // Unauthorized
            } else if (errorMessage.includes("Method Not Allowed")) {
                statusCode = 405; // Method Not Allowed
            } else if (
                errorMessage.includes("Request body is missing") ||
                errorMessage.includes("Missing required fields") ||
                errorMessage.includes("Unexpected token") || // JSON parsing error
                errorMessage.includes("invalid input syntax for type json") // JSON parsing error at DB level?
            ) {
                statusCode = 400; // Bad Request
            }
             // Add more specific checks if needed (e.g., OpenAI rate limits -> 429)
            // Supabase errors might also warrant specific codes (e.g., 404 if an ID isn't found, though RPC likely handles this)
        }

        const errorResponse: ErrorResponse = { error: errorMessage };

        return {
            statusCode,
            headers,
            body: JSON.stringify(errorResponse),
        };
    }
};

export { handler }; 