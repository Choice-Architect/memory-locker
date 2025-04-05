import { Handler, HandlerEvent, HandlerContext } from "@netlify/functions";
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { PorterStemmer } from 'natural';

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
    // user_id?: string; (Removed)
    mode: 'store' | 'query' | 'combined';
}

interface ContextObject {
    chunk: string;
    timestamp: string; // ISO 8601 format
    entities_in_chunk: ExtractedEntities; // Note: Currently storing file-level entities here
    file_id?: string; // Reference to the source file (Corrected: UUID as string)
    chunk_id?: string; // Reference to the specific chunk (Corrected: UUID as string)
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

// Define interface for the structure returned by search_memory_chunks RPC
interface SearchResultItem {
    // id?: string; // Chunk ID from transcript_embeddings if returned by RPC (Corrected: UUID as string)
    file_id: string; // Corrected: UUID as string
    content_chunk: string;
    metadata?: {
        created_at?: string;
        entities_in_chunk?: ExtractedEntities;
        [key: string]: any;
    };
    similarity?: number;
}

// Define interface for the structure returned by the fallback files query
interface FallbackResultItem {
    id: string; // Corrected: UUID as string
    transcript_text: string;
    created_at: string | null;
    file_metadata: ExtractedEntities | null;
}

// --- Constants ---
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536; // Dimension for text-embedding-3-small
const CHUNK_SIZE = 1000; // Target size in characters
const CHUNK_OVERLAP = 200; // Overlap in characters
const VECTOR_MATCH_THRESHOLD = 0.5; // Similarity threshold for vector search (Lowered from 0.75)
const VECTOR_MATCH_COUNT = 5;     // Max number of chunks to retrieve via vector search
const FALLBACK_MATCH_COUNT = 10; // Added fallback match count

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
        let fileId: string | null = null;


        // 2. Process based on mode
        if (payload.mode === 'store' || payload.mode === 'combined') {
            console.log("Processing 'store' mode...");
            const textToStore = payload.query_text;
            const fileMetadata = payload.extracted_entities; // Using extracted entities as file metadata for now

            // a. Insert into 'files' table
            console.log("Preparing to insert into files table...");
            const fileInsertData: { [key: string]: any } = {
                transcript_text: textToStore, // Store the full text
                file_metadata: fileMetadata, // Store all extracted entities
                title: textToStore.substring(0, 50) + (textToStore.length > 50 ? '...' : ''), // Simple title
                file_type: 'gpt_interaction', // Mark as originating from GPT interaction
                // user_id field removed
            };

            /*
            if (payload.user_id) {
                console.log(`Inserting with user_id: ${payload.user_id}`);
                fileInsertData.user_id = payload.user_id;
            } else {
                console.log("No user_id provided in payload, inserting without it.");
            }
            */

            const { data: fileData, error: fileError } = await supabase
                .from('files')
                .insert(fileInsertData) // Use the constructed object
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
                            // storage_status = `Stored file record (ID: ${fileId}) but failed to store embeddings: ${embeddingError.message}`;
                            // Optionally throw error instead: throw new Error(`Failed to store embeddings: ${embeddingError.message}`);
                            // THROW the error to ensure the function reports failure
                            throw new Error(`Failed to store embeddings: ${embeddingError.message}`);
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
            if (!queryText) {
                 throw new Error("query_text is required for 'query' or 'combined' mode.");
            }

            // a. Generate embedding for the query text
            console.log("Generating embedding for query text...");
            const queryEmbeddings = await generateEmbeddings([queryText]);
            if (!queryEmbeddings || queryEmbeddings.length === 0 || !queryEmbeddings[0]) {
                throw new Error("Failed to generate embedding for the query text.");
            }
            const queryEmbedding = queryEmbeddings[0];

            // b. Search for similar chunks in 'transcript_embeddings' using the SQL function
            console.log("Searching for relevant memory chunks via vector search...");
            const searchParams = {
                query_embedding: queryEmbedding,
                match_threshold: VECTOR_MATCH_THRESHOLD,
                match_count: VECTOR_MATCH_COUNT
                // No user_id included here as it was removed from payload and function logic
            };

            const { data: searchResults, error: searchError } = await supabase.rpc(
                'search_memory_chunks',
                searchParams
            );

            // Explicitly type the search results
            const typedSearchResults = searchResults as SearchResultItem[] | null;

            if (searchError) {
                console.error("Error during vector search RPC call:", searchError);
                // Don't throw here, proceed to fallback or report error
                query_source = 'error';
                message_for_gpt = `Error searching memories via vector: ${searchError.message}. Trying fallback.`; // Update message
            } else if (typedSearchResults && typedSearchResults.length > 0) {
                console.log(`Found ${typedSearchResults.length} potentially relevant chunks via vector search.`);
                query_source = 'vector_store';
                // Map results to ContextObject format, using the defined type for 'result'
                retrieved_context = typedSearchResults.map((result: SearchResultItem) => ({
                    // chunk_id: result.id, // Assuming the RPC returns the transcript_embeddings.id
                    file_id: result.file_id,
                    chunk: result.content_chunk,
                    // timestamp: result.metadata?.created_at || new Date(0).toISOString(), // Use timestamp from metadata if available
                    // Attempt to get timestamp robustly
                    timestamp: typeof result.metadata === 'object' && result.metadata !== null && 'created_at' in result.metadata
                               ? String(result.metadata.created_at)
                               : new Date(0).toISOString(), // Default if not found
                    entities_in_chunk: typeof result.metadata === 'object' && result.metadata !== null && 'entities_in_chunk' in result.metadata
                               ? result.metadata.entities_in_chunk as ExtractedEntities
                               : {}, // Default if not found or wrong type
                    // Add similarity score if needed for GPT context/debugging?
                    // similarity_score: result.similarity // Assuming the function returns similarity
                }));
            }

            // c. Fallback Search Logic (if vector search yielded no results or errored initially)
            if (retrieved_context.length === 0) {
                console.log("Vector search yielded no results or failed. Attempting fallback search on 'files' table...");

                // Use extracted topics for fallback if available, otherwise use full query text
                const topics = payload.extracted_entities?.topics;
                let fallbackQuery = supabase
                    .from('files')
                    .select('id, transcript_text, created_at, file_metadata'); // Select needed columns

                if (topics && topics.length > 0) {
                    console.log(`Using extracted topics for fallback search: ${topics.join(', ')}`);
                    // Stem each topic before creating the ILIKE pattern
                    const orFilter = topics
                        .map(topic => `transcript_text.ilike.%${PorterStemmer.stem(topic)}%`)
                        .join(',');
                    console.log(`Stemmed topics OR filter: ${orFilter}`); // Log the filter being used
                    fallbackQuery = fallbackQuery.or(orFilter);
                } else {
                    // Fallback to searching the whole query text if no specific topics extracted
                    console.log("No specific topics extracted, falling back to ILIKE on full query text.");
                    const fallbackPattern = `%${queryText}%`;
                    fallbackQuery = fallbackQuery.ilike('transcript_text', fallbackPattern);
                }

                // Add limit and execute
                fallbackQuery = fallbackQuery.limit(FALLBACK_MATCH_COUNT);
                const { data: fallbackResults, error: fallbackError } = await fallbackQuery;

                // Explicitly type the fallback results
                const typedFallbackResults = fallbackResults as FallbackResultItem[] | null;

                if (fallbackError) {
                    console.error("Error during fallback search on files table:", fallbackError);
                    // If vector search also failed, report combined errors. Otherwise, just report fallback error.
                    if (query_source === 'error') {
                        message_for_gpt += ` Fallback search also failed: ${fallbackError.message}`;
                    } else {
                         query_source = 'error'; // Mark as error state
                         message_for_gpt = `Vector search found nothing. Fallback search failed: ${fallbackError.message}`;
                    }
                } else if (typedFallbackResults && typedFallbackResults.length > 0) {
                    console.log(`Found ${typedFallbackResults.length} potentially relevant files via fallback search.`);
                     // If vector search was okay but found nothing, set source to fallback.
                     // If vector search errored, keep source as error but add fallback results.
                     if (query_source !== 'error') {
                        query_source = 'postgres_fallback';
                    }
                    message_for_gpt = message_for_gpt ? message_for_gpt + ` Found ${typedFallbackResults.length} file(s) via fallback.` : `Found ${typedFallbackResults.length} file(s) via fallback search (full text match).`;

                    // Map fallback results to ContextObject format, using the defined type for 'file'
                    const fallbackContext: ContextObject[] = typedFallbackResults.map((file: FallbackResultItem) => ({
                        file_id: file.id, // Use the file's UUID as file_id
                        // IMPORTANT: For fallback, the 'chunk' is the *entire* transcript_text
                        chunk: file.transcript_text,
                        timestamp: file.created_at ? new Date(file.created_at).toISOString() : new Date(0).toISOString(),
                         // Use file_metadata as entities - assumption is file-level entities apply to whole text
                        entities_in_chunk: typeof file.file_metadata === 'object' && file.file_metadata !== null
                                            ? file.file_metadata as ExtractedEntities
                                            : {},
                        // chunk_id: undefined // No specific chunk ID for fallback results
                    }));
                    retrieved_context.push(...fallbackContext); // Append fallback results
                } else {
                    console.log("Fallback search on 'files' table also found no results.");
                     // If vector search already errored, message_for_gpt is set. Otherwise...
                     if (query_source !== 'error') {
                        query_source = 'none'; // No results from either method
                        message_for_gpt = "I couldn't find any relevant information using vector search or direct text search.";
                    } else {
                         message_for_gpt += " Fallback search also found nothing.";
                    }
                }
            }

        } // End of 'query'/'combined' block

        // Final response construction
        console.log(`DEBUG: Final retrieved_context before returning: ${JSON.stringify(retrieved_context.slice(0, 1))}... (${retrieved_context.length} items)`); // Log first item for structure check

        const successResponse: SuccessResponse = {
            retrieved_context: retrieved_context,
            storage_status: storage_status,
            query_source: retrieved_context.length > 0 ? query_source : 'none', // Ensure source is 'none' if context is empty
            message_for_gpt: message_for_gpt,
            error: null,
        };

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(successResponse),
        };

    } catch (error: unknown) {
        console.error("Handler Error:", error);
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
        return {
            statusCode: 500, // Use 500 for internal server errors
            headers,
            body: JSON.stringify({ error: errorMessage } as ErrorResponse),
        };
    }
};

export { handler }; 