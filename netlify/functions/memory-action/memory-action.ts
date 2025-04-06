import { Handler, HandlerEvent, HandlerContext } from "@netlify/functions";
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import stemmer from '@stdlib/nlp-porter-stemmer';
import { parse, formatISO, startOfDay, endOfDay, addDays, subDays, startOfWeek, endOfWeek, startOfMonth, endOfMonth, addMonths, subMonths, set, isMatch, parseISO, isValid, format } from 'date-fns';

// --- Interfaces for API Contract ---

// Interface for normalized date object
interface NormalizedDate {
    original: string;
    normalized: string | null; // ISO 8601 format or null if failed
}

interface ExtractedEntities {
    people?: string[];
    dates?: (string | NormalizedDate)[]; // Allow storing original strings or normalized objects
    locations?: string[];
    topics?: string[];
    type?: string; // Added based on schema
    sentiment?: string; // Added based on schema
    [key: string]: any; // Allow flexible entity types, keep for now
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
    file_metadata: { // Assuming file_metadata is an object
        dates?: NormalizedDate[]; // Expect normalized dates here now
        [key: string]: any; // Allow other properties
    } | null;
}

// --- Constants ---
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536; // Dimension for text-embedding-3-small
const CHUNK_SIZE = 1000; // Target size in characters
const CHUNK_OVERLAP = 200; // Overlap in characters
const VECTOR_MATCH_THRESHOLD = 0.5; // Similarity threshold for vector search (Lowered from 0.75)
const VECTOR_MATCH_COUNT = 5;     // Max number of chunks to retrieve via vector search
const FALLBACK_MATCH_COUNT = 10; // Added fallback match count
const STORAGE_REFERENCE_DATE = new Date('2025-04-06T12:00:00Z'); // Fixed reference for storing test data

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
 * Normalizes a date string to ISO 8601 format using a reference date.
 * Handles relative terms like "today", "yesterday", "next week", etc.
 * Returns null if parsing/normalization fails.
 */
function normalizeDateString(dateString: string, referenceDate: Date): NormalizedDate {
    const lowerCaseDateString = dateString.toLowerCase().trim();
    let normalizedDate: Date | null = null;

    try {
        // Specific keywords first
        if (lowerCaseDateString === 'today') {
            normalizedDate = startOfDay(referenceDate);
        } else if (lowerCaseDateString === 'yesterday') {
            normalizedDate = startOfDay(subDays(referenceDate, 1));
        } else if (lowerCaseDateString === 'tomorrow') {
            normalizedDate = startOfDay(addDays(referenceDate, 1));
        } else if (lowerCaseDateString === 'last weekend') {
             // Assuming weekend is Sat/Sun. Get start of last week's Saturday.
             const lastWeekStart = startOfWeek(subDays(referenceDate, 7), { weekStartsOn: 0 }); // Last Sunday
             normalizedDate = addDays(lastWeekStart, 6); // Saturday of last week
             // Note: This returns a single date. Range handling might be needed.
        } else if (lowerCaseDateString === 'next weekend') {
            // Get start of next week's Saturday.
            const nextWeekStart = startOfWeek(addDays(referenceDate, 7), { weekStartsOn: 0 }); // Next Sunday
            normalizedDate = addDays(nextWeekStart, 6); // Saturday of next week
            // Note: This returns a single date.
        } else if (lowerCaseDateString.startsWith('next ')) {
            const parts = lowerCaseDateString.split(' ');
            if (parts.length === 2) {
                // Simple handling for 'next month', 'next week', 'next tuesday' etc.
                // Requires more robust parsing for specific days relative to referenceDate
                // For now, approximate:
                if (parts[1] === 'month') normalizedDate = startOfMonth(addMonths(referenceDate, 1));
                else if (parts[1] === 'week') normalizedDate = startOfWeek(addDays(referenceDate, 7), { weekStartsOn: 1 }); // Assuming week starts Mon
                // Add more specific day handling if needed ('next tuesday')
            }
        } else if (lowerCaseDateString.startsWith('last ')) {
             const parts = lowerCaseDateString.split(' ');
            if (parts.length === 2) {
                if (parts[1] === 'month') normalizedDate = startOfMonth(subMonths(referenceDate, 1));
                else if (parts[1] === 'week') normalizedDate = startOfWeek(subDays(referenceDate, 7), { weekStartsOn: 1 });
                 // Add more specific day handling if needed ('last tuesday')
            }
        } else if (lowerCaseDateString === 'eod friday') {
            // Find the next Friday (or today if it is Friday) and set time to 17:00
            let nextFriday = referenceDate;
            while (nextFriday.getDay() !== 5) {
                nextFriday = addDays(nextFriday, 1);
            }
            normalizedDate = set(startOfDay(nextFriday), { hours: 17 });
        } else {
            // Attempt parsing common formats (requires date-fns v2+)
             // Try ISO format first
            if (isMatch(dateString, "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'") || isMatch(dateString, "yyyy-MM-dd")) {
                 const parsed = parseISO(dateString);
                 if (isValid(parsed)) normalizedDate = parsed;
            }
            // Add more specific format parsing if needed, e.g., 'MM/dd/yyyy', 'MMMM d, yyyy'
            // Example:
            // else if (isMatch(dateString, 'MM/dd/yyyy')) {
            //    normalizedDate = parse(dateString, 'MM/dd/yyyy', referenceDate);
            // }
            if (!normalizedDate) {
                console.warn(`Could not parse date string: "${dateString}" with basic patterns.`);
            }
        }

    } catch (error) {
        console.error(`Error normalizing date string "${dateString}":`, error);
        normalizedDate = null; // Ensure null on error
    }

    return {
        original: dateString,
        normalized: normalizedDate ? formatISO(normalizedDate) : null
    };
}

/**
 * Given a normalized ISO date string (potentially with varying precision like YYYY-MM-DD or YYYY-MM),
 * generate an array of standardized formats (YYYY-MM-DDTHH:mm:ssZ, YYYY-MM-DD, YYYY-MM, YYYY)
 * for use in fallback queries.
 */
function generateDateFormats(normalizedDateString: string): string[] {
    const formats = new Set<string>(); // Use a Set to avoid duplicates

    try {
        // Attempt to parse the input string, assuming it's already somewhat normalized
        // Handles YYYY-MM-DDTHH:mm:ssZ, YYYY-MM-DD
        const parsedDate = parseISO(normalizedDateString);

        if (isValid(parsedDate)) {
            // Always add the most specific format possible (full ISO with time)
            // If the original didn't have time, parseISO defaults to 00:00:00Z
            formats.add(formatISO(parsedDate));

            // Add Date only format
            formats.add(format(parsedDate, 'yyyy-MM-dd'));

            // Add Month only format
            formats.add(format(parsedDate, 'yyyy-MM'));

             // Add Year only format
             formats.add(format(parsedDate, 'yyyy'));

        } else {
             // Handle cases parseISO might fail on, like YYYY-MM or YYYY
             if (normalizedDateString.match(/^\d{4}-\d{2}$/)) { // YYYY-MM
                 formats.add(normalizedDateString); // Add the original YYYY-MM
                 // Attempt to parse for year format
                 const parsedForYear = parse(normalizedDateString, 'yyyy-MM', new Date());
                 if (isValid(parsedForYear)) formats.add(format(parsedForYear, 'yyyy'));

             } else if (normalizedDateString.match(/^\d{4}$/)) { // YYYY
                 formats.add(normalizedDateString); // Add the original YYYY
             } else {
                 // If it's not a recognized format, just add the original string
                 // as a fallback, though it might not match storage formats.
                 console.warn(`generateDateFormats received potentially unparseable input: ${normalizedDateString}`);
                 if (normalizedDateString) formats.add(normalizedDateString);
             }
        }
    } catch (error) {
        console.error(`Error generating date formats for "${normalizedDateString}":`, error);
        // Add the original string as a last resort on error
        if (normalizedDateString) {
            formats.add(normalizedDateString);
        }
    }

    return Array.from(formats); // Convert Set back to array
}

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
        let processedMetadata: ExtractedEntities = { ...payload.extracted_entities }; // Copy to modify


        // 1. Normalize Dates if present
        if (processedMetadata.dates && Array.isArray(processedMetadata.dates)) {
            const referenceDateForNormalization = (payload.mode === 'store' || payload.mode === 'combined')
                ? STORAGE_REFERENCE_DATE // Use fixed date for storing test data
                : new Date(); // Use current date for queries

            console.log(`Normalizing dates with reference: ${referenceDateForNormalization.toISOString()}`);
            processedMetadata.dates = processedMetadata.dates
                .map(date => {
                     // If it's already a NormalizedDate object (e.g., from a previous step), skip
                     if (typeof date === 'object' && date !== null && 'original' in date && 'normalized' in date) {
                         return date as NormalizedDate;
                     }
                     // Otherwise, assume it's a string and normalize it
                     if (typeof date === 'string') {
                         return normalizeDateString(date, referenceDateForNormalization);
                     }
                     // If it's neither, log a warning and filter it out
                     console.warn(`Unexpected date format in extracted_entities: ${JSON.stringify(date)}`);
                     return null;
                })
                .filter(d => d !== null) as NormalizedDate[]; // Filter out any nulls from failed normalizations/bad types
        }

        // 2. Process based on mode
        if (payload.mode === 'store' || payload.mode === 'combined') {
            console.log("Processing 'store' mode...");
            const textToStore = payload.query_text;
            // Use the processedMetadata which now contains normalized dates
            const fileMetadata = processedMetadata;

            // a. Insert into 'files' table
            console.log("Preparing to insert into files table with processed metadata:", JSON.stringify(fileMetadata));
            const fileInsertData: { [key: string]: any } = {
                transcript_text: textToStore,
                file_metadata: fileMetadata, // Store processed metadata with normalized dates
                title: textToStore.substring(0, 50) + (textToStore.length > 50 ? '...' : ''),
                file_type: 'gpt_interaction',
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

                        // Store the *full fileMetadata* (including normalized dates and other entities)
                        // in each chunk's metadata field.
                        const chunkMetadata = {
                            ...fileMetadata, // Spread all file-level metadata
                            created_at: timestamp, // Add chunk creation timestamp
                            // Optionally add chunk-specific details later if needed
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
                            storage_status = "Noted."; // Concise success status
                        }
                    } else {
                        console.warn("No valid embedding records to insert.");
                        storage_status = `Stored file record (ID: ${fileId}) but no valid embeddings were generated to store.`; // Keep details for partial failure
                    }
                } else {
                     console.warn("No embeddings were generated successfully.");
                     storage_status = `Stored file record (ID: ${fileId}) but failed to generate any embeddings.`; // Keep details for failure
                }
            }

        } // End of 'store'/'combined' block

        if (payload.mode === 'query' || payload.mode === 'combined') {
            console.log("Processing 'query' mode...");
            const queryText = payload.query_text;
            // Use processedMetadata which has dates normalized relative to the *current* time
            const queryMetadata = processedMetadata;
            const queryDates = (queryMetadata.dates as NormalizedDate[] | undefined)?.filter(d => d.normalized) || [];

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

            // Prepare metadata filters from queryMetadata
            const filterTopics = queryMetadata.topics?.length ? queryMetadata.topics : null;
            const filterPeople = queryMetadata.people?.length ? queryMetadata.people : null;
            const filterLocations = queryMetadata.locations?.length ? queryMetadata.locations : null;
            const filterType = queryMetadata.type || null;
            const filterSentiment = queryMetadata.sentiment || null;

            // Determine date range from normalized query dates
            let filterDateStart: string | null = null;
            let filterDateEnd: string | null = null;
            const validNormalizedDates = (queryMetadata.dates as NormalizedDate[] | undefined)
                ?.map(d => d.normalized)
                .filter((d): d is string => d !== null)
                .map(d => parseISO(d)) // Parse to Date objects for comparison
                .filter(isValid);

            if (validNormalizedDates && validNormalizedDates.length > 0) {
                validNormalizedDates.sort((a, b) => a.getTime() - b.getTime()); // Sort dates chronologically
                // Use the earliest date as start, latest as end
                filterDateStart = formatISO(validNormalizedDates[0]);
                filterDateEnd = formatISO(validNormalizedDates[validNormalizedDates.length - 1]);
                 console.log(`Applying vector search date filter: Start=${filterDateStart}, End=${filterDateEnd}`);
            }

            // Construct the parameters for the RPC call
            const searchParams = {
                query_embedding: queryEmbedding,
                match_threshold: VECTOR_MATCH_THRESHOLD,
                match_count: VECTOR_MATCH_COUNT,
                filter_topics: filterTopics,
                filter_people: filterPeople,
                filter_locations: filterLocations,
                filter_type: filterType,
                filter_sentiment: filterSentiment,
                filter_date_start: filterDateStart,
                filter_date_end: filterDateEnd
            };

            console.log("Calling search_memory_chunks with params:", JSON.stringify(searchParams));

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
                    timestamp: typeof result.metadata === 'object' && result.metadata !== null && 'created_at' in result.metadata
                               ? String(result.metadata.created_at)
                               : new Date(0).toISOString(),
                    // Extract entities from chunk metadata (which should mirror file metadata now)
                    entities_in_chunk: typeof result.metadata === 'object' && result.metadata !== null
                               ? { // Reconstruct entities from metadata, expecting normalized dates
                                    people: result.metadata.people,
                                    dates: result.metadata.dates as NormalizedDate[],
                                    locations: result.metadata.locations,
                                    topics: result.metadata.topics,
                                    type: result.metadata.type,
                                    sentiment: result.metadata.sentiment
                                  }
                                : {},
                }));
            }

            // c. Fallback Search Logic (if vector search yielded no results or errored initially)
            if (retrieved_context.length === 0) {
                 console.log("Vector search yielded no results or failed. Attempting fallback search on 'files' table...");

                // Use extracted topics and normalized dates for fallback
                const topics = queryMetadata?.topics;
                let fallbackQuery = supabase
                    .from('files')
                    .select('id, transcript_text, created_at, file_metadata'); // Select needed columns


                // ** Filter by Dates **
                // New approach: Generate multiple formats for each query date and check if
                // any stored normalized date matches any of the generated query formats.
                let allQueryDateFormats: string[] = [];
                if (queryDates.length > 0) {
                    queryDates.forEach(dateObj => {
                        if (dateObj.normalized) {
                            const formats = generateDateFormats(dateObj.normalized);
                            allQueryDateFormats.push(...formats);
                        }
                    });
                    // Remove duplicates
                    allQueryDateFormats = [...new Set(allQueryDateFormats)];
                }

                if (allQueryDateFormats.length > 0) {
                    console.log(`Applying fallback date filter for potential formats: ${allQueryDateFormats.join(', ')}`);
                    // Construct the .or() filter string
                    // Checks if the 'dates' array contains any object whose 'normalized' property
                    // matches ANY of the generated formats.
                    const dateFilters = allQueryDateFormats.map(format =>
                        `file_metadata->dates.cs.${JSON.stringify([{"normalized": format}])}`
                    ).join(',');

                    console.log(`Fallback Date Filter Condition (OR across formats): ${dateFilters}`);
                    fallbackQuery = fallbackQuery.or(dateFilters);
                }


                // ** Filter by Topics (ILIKE on stemmed topics) **
                if (topics && topics.length > 0) {
                    console.log(`Using extracted topics for fallback search: ${topics.join(', ')}`);
                    const orFilter = topics
                        .map(topic => `transcript_text.ilike.%${stemmer(topic)}%`)
                        .join(',');
                    console.log(`Stemmed topics OR filter: ${orFilter}`);
                    // Chain the topic filter. Use .and() if date filter was applied, .or() otherwise?
                    // Let's make them additive for now (match date OR topic) - easily changed to AND if needed.
                    fallbackQuery = fallbackQuery.or(orFilter);
                } else if (queryDates.length === 0) { // Only use full text if no dates or topics provided
                    console.log("No specific topics or dates extracted, falling back to ILIKE on full query text.");
                    const fallbackPattern = `%${queryText}%`;
                    fallbackQuery = fallbackQuery.ilike('transcript_text', fallbackPattern);
                }


                // Add limit and execute
                fallbackQuery = fallbackQuery.limit(FALLBACK_MATCH_COUNT);
                console.log("Executing Fallback Query...");
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
                        file_id: file.id,
                        chunk: file.transcript_text, // Entire transcript for fallback
                        timestamp: file.created_at ? new Date(file.created_at).toISOString() : new Date(0).toISOString(),
                        // Extract entities from file_metadata, expecting normalized dates
                        entities_in_chunk: typeof file.file_metadata === 'object' && file.file_metadata !== null
                            ? { // Reconstruct based on expected structure
                                people: file.file_metadata.people,
                                dates: file.file_metadata.dates || [], // Ensure dates array exists
                                locations: file.file_metadata.locations,
                                topics: file.file_metadata.topics,
                                type: file.file_metadata.type,
                                sentiment: file.file_metadata.sentiment
                              }
                            : {},
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