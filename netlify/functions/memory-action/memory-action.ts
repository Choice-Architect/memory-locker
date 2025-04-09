import { Handler, HandlerEvent, HandlerContext } from "@netlify/functions";
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import stemmer from '@stdlib/nlp-porter-stemmer';
import { parse, formatISO, startOfDay, endOfDay, addDays, subDays, startOfWeek, endOfWeek, startOfMonth, endOfMonth, addMonths, subMonths, set, isMatch, parseISO, isValid, getDay, nextDay, setHours, setMinutes, setSeconds, setMilliseconds, getYear, Day } from 'date-fns';

// --- Interfaces for API Contract ---

// Updated Interface for normalized date object (Old - will be replaced by EnhancedNormalizedDate in outputs)
interface NormalizedDate {
    original: string;
    normalized: string | null; // ISO 8601 format or null if failed
    note?: string; // Added: Reason for failure (e.g., 'vague', 'parse_error')
}

// NEW Interface for Enhanced Date Handling with Components
interface EnhancedNormalizedDate {
    original: string;        // The original string like "last Tuesday afternoon"
    normalized?: string | null; // ISO 8601 if fully resolved, else null
    note?: string;           // Explanation if partial or failed (e.g., "Partial parse: Day and period identified relative to reference date")
    // --- Component Fields (all optional) ---
    year?: number;           // e.g., 2024
    month?: number;          // e.g., 4 (1-12)
    day?: number;            // e.g., 2 (1-31)
    day_of_week?: number;    // e.g., 2 (0=Sun, 1=Mon, 2=Tue...)
    time_hour?: number;      // e.g., 15 (0-23)
    time_minute?: number;    // e.g., 0
    time_second?: number;    // e.g., 0
    period?: 'AM' | 'PM' | 'Morning' | 'Afternoon' | 'Evening' | 'Night'; // e.g., "Afternoon"
    relative_marker?: 'last' | 'this' | 'next' | 'previous'; // e.g., "last"
    relative_unit?: 'day' | 'week' | 'month' | 'year' | 'weekend'; // e.g., "week" (implicitly via Tuesday)
}

interface ExtractedEntities {
    people?: string[];
    // Input can still be flexible string or NormalizedDate for initial capture
    // but will be processed into EnhancedNormalizedDate internally.
    dates?: (string | NormalizedDate)[];
    locations?: string[];
    topics?: string[];
    type?: string; // Added based on schema
    sentiment?: string; // Added based on schema
    priority?: number; // Added: Optional user-assigned priority (1-10)
    conversation_id?: string; // Added: Optional conversation identifier
    thread_id?: string; // Added: Optional thread identifier
    language?: 'en' | 'fr' | 'ar'; // Added: Optional language code
    [key: string]: any; // Allow flexible entity types, keep for now
}

// Interface for entities AFTER internal processing (using EnhancedNormalizedDate)
// This is what gets stored in metadata and returned in context objects.
interface ProcessedEntities {
    people?: string[];
    dates?: EnhancedNormalizedDate[]; // Use the new enhanced structure
    locations?: string[];
    topics?: string[];
    type?: string;
    sentiment?: string;
    priority?: number;
    conversation_id?: string;
    thread_id?: string;
    language?: 'en' | 'fr' | 'ar';
    [key: string]: any;
}

interface RequestPayload {
    query_text: string;
    extracted_entities: ExtractedEntities; // Input uses the original ExtractedEntities
    // user_id?: string; (Removed)
    mode: 'store' | 'query' | 'combined';
}

interface ContextObject {
    chunk: string;
    timestamp: string; // ISO 8601 format (Could be chunk creation or file creation)
    entities_in_chunk: ProcessedEntities; // Output uses ProcessedEntities with EnhancedNormalizedDate
    file_id?: string; // Reference to the source file (Corrected: UUID as string)
    chunk_id?: string; // Reference to the specific chunk (Corrected: UUID as string)
    chunk_index?: number; // Added: Index of the chunk within its file
}

interface SuccessResponse {
    retrieved_context: ContextObject[];
    storage_status: string;
    query_source: 'vector_store' | 'postgres_fallback' | 'postgres_fallback_metadata' | 'postgres_fallback_text' | 'none' | 'combined' | 'error'; // Added combined/error and specific fallbacks
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
    // Metadata from DB should now contain ProcessedEntities structure
    metadata?: ProcessedEntities & { created_at?: string; [key: string]: any };
    similarity?: number;
    chunk_index?: number; // Added this field here too
}

// Define interface for the structure returned by the fallback files query
interface FallbackResultItem {
    id: string; // Corrected: UUID as string
    transcript_text: string;
    created_at: string | null;
    // file_metadata from DB should now contain ProcessedEntities structure
    file_metadata: ProcessedEntities | null;
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

// Simple list of common English stop words
const STOP_WORDS = new Set([
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren\'t', 'as', 'at',
    'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can\'t', 'cannot',
    'could', 'couldn\'t', 'did', 'didn\'t', 'do', 'does', 'doesn\'t', 'doing', 'don\'t', 'down', 'during', 'each',
    'few', 'for', 'from', 'further', 'had', 'hadn\'t', 'has', 'hasn\'t', 'have', 'haven\'t', 'having', 'he', 'he\'d',
    'he\'ll', 'he\'s', 'her', 'here', 'here\'s', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'how\'s', 'i', 'i\'d',
    'i\'ll', 'i\'m', 'i\'ve', 'if', 'in', 'into', 'is', 'isn\'t', 'it', 'it\'s', 'its', 'itself', 'let\'s', 'me',
    'more', 'most', 'mustn\'t', 'my', 'myself', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
    'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'shan\'t', 'she', 'she\'d', 'she\'ll', 'she\'s',
    'should', 'shouldn\'t', 'so', 'some', 'such', 'than', 'that', 'that\'s', 'the', 'their', 'theirs', 'them',
    'themselves', 'then', 'there', 'there\'s', 'these', 'they', 'they\'d', 'they\'ll', 'they\'re', 'they\'ve', 'this',
    'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'wasn\'t', 'we', 'we\'d', 'we\'ll', 'we\'re',
    'we\'ve', 'were', 'weren\'t', 'what', 'what\'s', 'when', 'when\'s', 'where', 'where\'s', 'which', 'while', 'who',
    'who\'s', 'whom', 'why', 'why\'s', 'with', 'won\'t', 'would', 'wouldn\'t', 'you', 'you\'d', 'you\'ll', 'you\'re',
    'you\'ve', 'your', 'yours', 'yourself', 'yourselves'
]);

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
 * Handles relative terms like "today", "yesterday", specific dates/times, weekdays, months.
 * Identifies and rejects vague terms.
 * Returns a NormalizedDate object { original, normalized, note? }.
 */
function normalizeDateString(dateString: string, referenceDate: Date): NormalizedDate {
    const lowerCaseDateString = dateString.toLowerCase().trim();
    let normalizedDateObj: Date | null = null;
    let note: string | undefined = undefined;
    // Default to start of day unless time is parsed
    let timeInfo = { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 };

    try {
        // --- Check for Vague Terms First --- (Return immediately if vague)
        const vagueTerms = ["end of", "middle of", "sometime", "around", "a few", "several"];
        if (vagueTerms.some(term => lowerCaseDateString.includes(term))) {
             note = "Could not normalize due to vague phrasing.";
             console.log(`Date normalization skipped for '${dateString}': ${note}`);
             return { original: dateString, normalized: null, note };
        }

        // --- Handle Time Extraction (simple cases like 'at 4PM', '9am', '14:30') ---        
        const timeRegex = /\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s?(am|pm)?\b/i;
        const timeMatch = lowerCaseDateString.match(timeRegex);
        let datePart = lowerCaseDateString; // Start with the full string for date parsing

        if (timeMatch) {
            let hours = parseInt(timeMatch[1], 10);
            const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
            const period = timeMatch[3] ? timeMatch[3].toLowerCase() : null;

            // Adjust hours for AM/PM if present
            if (period === 'pm' && hours < 12) hours += 12;
            if (period === 'am' && hours === 12) hours = 0; // Midnight case

            if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
                 timeInfo = { hours, minutes, seconds: 0, milliseconds: 0 };
                 // Remove the time part from the string so we can parse the date part
                 // Be careful not to remove parts of the date itself (e.g., 'Call at 10 on the 10th')
                 datePart = lowerCaseDateString.replace(timeMatch[0], '').replace(/^at\s+|\s+at$/g, '').trim(); 
                 // If datePart becomes empty after removing time, assume 'today'
                 if (!datePart || datePart === 'at') datePart = 'today';
                 console.log(`Extracted time: ${hours}:${minutes}, remaining date part: '${datePart}'`);
            } else {
                console.warn(`Ignoring invalid time parsed: ${timeMatch[0]}`);
            }
        }
        // If no specific time is found, default to start of day (already handled by timeInfo default)

        // --- Date Parsing Logic ---
        if (!datePart) {
             // This might happen if the original string was *only* a time like "4pm"
             datePart = 'today'; 
        }

        if (datePart === 'today') {
            normalizedDateObj = referenceDate;
        } else if (datePart === 'yesterday') {
            normalizedDateObj = subDays(referenceDate, 1);
        } else if (datePart === 'tomorrow') {
            normalizedDateObj = addDays(referenceDate, 1);
        } else if (datePart === 'last month') {
             normalizedDateObj = startOfMonth(subMonths(referenceDate, 1));
        } else if (datePart === 'next month') {
             normalizedDateObj = startOfMonth(addMonths(referenceDate, 1));
        } else if (datePart.startsWith('next ')) {
            const weekdayMatch = datePart.match(/next (monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
            if (weekdayMatch) {
                const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
                const targetDay = weekdays.indexOf(weekdayMatch[1]);
                if (targetDay !== -1) {
                    normalizedDateObj = nextDay(referenceDate, targetDay as Day);
                }
            } else if (datePart === 'next week') {
                 normalizedDateObj = startOfWeek(addDays(referenceDate, 7), { weekStartsOn: 1 }); // Assuming week starts Mon
            }
            // Add 'next weekend' etc. if needed
        } else if (datePart.startsWith('last ')) {
             const weekdayMatch = datePart.match(/last (monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
            if (weekdayMatch) {
                 const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
                 const targetDay = weekdays.indexOf(weekdayMatch[1]);
                 if (targetDay !== -1) {
                     // Find previous instance by going back day by day
                     let tempDate = subDays(referenceDate, 1);
                     while (getDay(tempDate) !== targetDay) {
                         tempDate = subDays(tempDate, 1);
                     }
                     normalizedDateObj = tempDate;
                 }
            } else if (datePart === 'last week') {
                  normalizedDateObj = startOfWeek(subDays(referenceDate, 7), { weekStartsOn: 1 });
            }
             // Add 'last weekend' etc. if needed
        } else {
            // --- Attempt parsing various explicit formats --- 
            const formatsToTry = [
                { format: "yyyy-MM-dd'T'HH:mm:ss.SSSX", iso: true }, // ISO8601 with Z or offset
                { format: 'yyyy-MM-dd HH:mm:ss', iso: false }, // Space separated datetime
                { format: 'yyyy-MM-dd', iso: false },          // Date only
                { format: 'MM/dd/yyyy', iso: false },          // Common US
                { format: 'd/M/yyyy', iso: false },            // Common EU
                { format: 'MMMM d, yyyy', iso: false },        // July 15, 2024
                { format: 'MMM d, yyyy', iso: false },         // Jul 15, 2024
                { format: 'MMMM d', iso: false, inferYear: true }, // June 4th
                { format: 'MMM d', iso: false, inferYear: true },  // Jun 4th
            ];

            for (const fmt of formatsToTry) {
                let dateStringToParse = datePart;
                let effectiveFormat = fmt.format;

                if (fmt.inferYear && !/\d{4}/.test(dateStringToParse)) {
                    // Append reference year if format needs it and year isn't present
                    dateStringToParse = `${dateStringToParse}, ${getYear(referenceDate)}`;
                    effectiveFormat = fmt.format + ', yyyy'; // Adjust format for parsing
                }
                
                try {
                    const parsed = fmt.iso ? parseISO(dateStringToParse) : parse(dateStringToParse, effectiveFormat, referenceDate);
                    if (isValid(parsed)) {
                        normalizedDateObj = parsed;
                        // If the successful format included time, update timeInfo
                        if (effectiveFormat.includes('H') || effectiveFormat.includes('h') || effectiveFormat.includes('k') || effectiveFormat.includes('K')) {
                            timeInfo = { hours: parsed.getHours(), minutes: parsed.getMinutes(), seconds: parsed.getSeconds(), milliseconds: parsed.getMilliseconds() };
                        }
                        break; // Found a valid parse, stop trying formats
                    }
                } catch (e) { /* Ignore parse error for this format, try next */ }
            }

            if (!normalizedDateObj) {
                console.warn(`Could not parse date part: "${datePart}" with known patterns.`);
                note = "Could not parse this date format.";
            }
        }

        // --- Final Assembly --- 
        // Apply time info (either parsed or default start-of-day) and check validity again
         if (normalizedDateObj && isValid(normalizedDateObj)) {
             // Set the time components. If time wasn't explicitly parsed, this sets to 00:00:00.000
             normalizedDateObj = set(normalizedDateObj, timeInfo);
         } else if (!note) { 
             // If we reached here without a date object and without a specific note, set a generic failure note.
             note = "Normalization failed.";
             normalizedDateObj = null;
         } else {
              normalizedDateObj = null; // Ensure null if previous steps failed with a note
         }

    } catch (error) {
        console.error(`Critical Error normalizing date string "${dateString}":`, error);
        normalizedDateObj = null; // Ensure null on critical error
        note = "Internal error during date normalization.";
    }

    // Return the final object
    const finalNormalizedString = normalizedDateObj && isValid(normalizedDateObj) ? formatISO(normalizedDateObj) : null;
    // Ensure a note is provided if normalization failed
    const finalNote = finalNormalizedString === null ? (note || "Normalization failed.") : undefined;

    console.log(`Normalization Result for '${dateString}': ${finalNormalizedString || 'Failed'} ${finalNote ? '('+finalNote+')' : ''}`);

    return {
        original: dateString,
        normalized: finalNormalizedString,
        note: finalNote
    };
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
            // Always use the current time as the reference for normalization
            const referenceDateForNormalization = new Date();

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

            // --> Enhancement: Add Priority
            if (payload.extracted_entities.priority && typeof payload.extracted_entities.priority === 'number') {
                fileMetadata.priority = payload.extracted_entities.priority;
                console.log(`Stored priority: ${fileMetadata.priority}`);
            }

            // --> Enhancement: Add Language
            fileMetadata.language = payload.extracted_entities.language || 'en'; // Default to 'en'
            console.log(`Stored language: ${fileMetadata.language}`);


            // a. Insert into 'files' table
            console.log("Preparing to insert into files table with processed metadata:", JSON.stringify(fileMetadata));
            const fileInsertData: { [key: string]: any } = {
                transcript_text: textToStore,
                // transcript_tsv: supabase.sql`to_tsvector('english', ${textToStore})`, // Removed - Handled by DB trigger/backfill
                file_metadata: fileMetadata, // Store processed metadata with normalized dates
                title: textToStore.substring(0, 50) + (textToStore.length > 50 ? '...' : ''),
                file_type: 'gpt_interaction',
                // --> Enhancement: Add Conversation/Thread IDs
                conversation_id: payload.extracted_entities.conversation_id || null,
                thread_id: payload.extracted_entities.thread_id || null,
            };


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
                            chunk_index: index, // --> Enhancement: Store chunk index
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
            const queryMetadata = processedMetadata; // Use processedMetadata which has normalized dates
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

            // b. Vector Search (Primary Attempt)
            console.log("Attempt 1: Searching for relevant memory chunks via vector search...");
            const searchParams = {
                query_embedding: queryEmbedding,
                match_threshold: VECTOR_MATCH_THRESHOLD,
                match_count: VECTOR_MATCH_COUNT,
                filter_topics: queryMetadata.topics || null,
                filter_people: queryMetadata.people || null,
                filter_locations: queryMetadata.locations || null,
                filter_type: queryMetadata.type || null,
                filter_sentiment: queryMetadata.sentiment || null,
                filter_date_start: queryDates.length > 0 ? queryDates[0].normalized : null,
                filter_date_end: queryDates.length > 1 ? queryDates[queryDates.length - 1].normalized : (queryDates.length === 1 ? queryDates[0].normalized : null)
            };

            const { data: searchResults, error: searchError } = await supabase.rpc(
                'search_memory_chunks',
                searchParams
            );
            const typedSearchResults = searchResults as SearchResultItem[] | null;

            let vectorSearchFailed = false;
            if (searchError) {
                console.error("Error during vector search RPC call:", searchError);
                query_source = 'error'; // Mark as error, but proceed to fallback
                message_for_gpt = `Error during vector search: ${searchError.message}. Trying fallback.`;
                vectorSearchFailed = true;
            } else if (typedSearchResults && typedSearchResults.length > 0) {
                console.log(`Found ${typedSearchResults.length} chunks via vector search.`);
                query_source = 'vector_store';
                retrieved_context = typedSearchResults.map((result: SearchResultItem) => ({
                    file_id: result.file_id,
                    chunk: result.content_chunk,
                    timestamp: typeof result.metadata === 'object' && result.metadata !== null && 'created_at' in result.metadata
                               ? String(result.metadata.created_at)
                               : new Date(0).toISOString(),
                    chunk_index: typeof result === 'object' && result !== null && 'chunk_index' in result ? Number(result.chunk_index) : undefined,
                    entities_in_chunk: typeof result.metadata === 'object' && result.metadata !== null
                        ? { // Reconstruct entities from metadata
                            people: result.metadata.people,
                            dates: (result.metadata.dates as NormalizedDate[]) || [],
                            locations: result.metadata.locations,
                            topics: result.metadata.topics,
                            type: result.metadata.type,
                            sentiment: result.metadata.sentiment
                          }
                        : {},
                }));
            } else {
                console.log("Vector search yielded no results.");
                // query_source remains 'none' for now, will be updated by fallback
            }


            // c. Fallback Logic (Tiered: Metadata -> Text)
            if (retrieved_context.length === 0) { // Only run fallback if vector search found nothing or failed

                console.log("Attempt 2: Fallback - Metadata Search on 'files' table...");
                let fallbackQueryMeta = supabase
                    .from('files')
                    .select('id, transcript_text, created_at, file_metadata')
                    .order('created_at', { ascending: false }) // Default ordering
                    .limit(FALLBACK_MATCH_COUNT);

                let metaFiltersApplied = false;

                // Apply Date Filter
                if (queryDates.length > 0) {
                    const startDate = queryDates[0].normalized;
                    const endDate = queryDates.length > 1 && queryDates[queryDates.length - 1].normalized !== startDate ? queryDates[queryDates.length - 1].normalized : startDate;
                    if (startDate) {
                        try {
                            const endOfDayISO = formatISO(endOfDay(parseISO(endDate || startDate)));
                            console.log(`Fallback Meta: Applying created_at filter: >= ${startDate} AND < ${endOfDayISO}`);
                            fallbackQueryMeta = fallbackQueryMeta.gte('created_at', startDate);
                            fallbackQueryMeta = fallbackQueryMeta.lt('created_at', endOfDayISO);
                            metaFiltersApplied = true;
                        } catch (dateParseError) {
                             console.error(`Fallback Meta: Error parsing dates for created_at filter: ${startDate}, ${endDate}`, dateParseError);
                        }
                    }
                }

                // Apply Metadata Entity Filters
                if (queryMetadata.people && queryMetadata.people.length > 0) {
                    console.log(`Fallback Meta: Applying filter: file_metadata->people @> ${JSON.stringify(queryMetadata.people)}`);
                    fallbackQueryMeta = fallbackQueryMeta.contains('file_metadata->people', queryMetadata.people);
                    metaFiltersApplied = true;
                }
                if (queryMetadata.locations && queryMetadata.locations.length > 0) {
                    console.log(`Fallback Meta: Applying filter: file_metadata->locations @> ${JSON.stringify(queryMetadata.locations)}`);
                     fallbackQueryMeta = fallbackQueryMeta.contains('file_metadata->locations', queryMetadata.locations);
                    metaFiltersApplied = true;
                }
                 if (queryMetadata.topics && queryMetadata.topics.length > 0) {
                     console.log(`Fallback Meta: Applying filter: file_metadata->topics @> ${JSON.stringify(queryMetadata.topics)}`);
                     fallbackQueryMeta = fallbackQueryMeta.contains('file_metadata->topics', queryMetadata.topics);
                    metaFiltersApplied = true;
                }
                if (queryMetadata.priority) {
                    console.log(`Fallback Meta: Applying filter: file_metadata->>priority = ${queryMetadata.priority}`);
                    fallbackQueryMeta = fallbackQueryMeta.eq('file_metadata->>priority', queryMetadata.priority);
                     metaFiltersApplied = true;
                }

                // Execute Metadata Fallback only if filters were applicable
                if (metaFiltersApplied) {
                    console.log("Executing Fallback Metadata Query...");
                    const { data: metaResults, error: metaError } = await fallbackQueryMeta;
                    const typedMetaResults = metaResults as FallbackResultItem[] | null;

                    if (metaError) {
                        console.error("Error during fallback metadata search:", metaError);
                         if (!vectorSearchFailed) message_for_gpt = `Vector search found nothing. Fallback metadata search failed: ${metaError.message}`;
                         else message_for_gpt += ` Fallback metadata search also failed: ${metaError.message}`;
                         if (!vectorSearchFailed) query_source = 'error'; // Mark error if not already marked
                    } else if (typedMetaResults && typedMetaResults.length > 0) {
                        console.log(`Found ${typedMetaResults.length} files via fallback metadata search.`);
                         query_source = 'postgres_fallback_metadata'; // Set specific source
                         if (vectorSearchFailed) message_for_gpt += ` Found ${typedMetaResults.length} file(s) via metadata fallback.`;
                         else message_for_gpt = `Found ${typedMetaResults.length} file(s) via metadata search.`;

                        retrieved_context = typedMetaResults.map((file: FallbackResultItem) => ({
                             file_id: file.id,
                             chunk: file.transcript_text,
                             timestamp: file.created_at ? new Date(file.created_at).toISOString() : new Date(0).toISOString(),
                             chunk_index: undefined,
                             entities_in_chunk: typeof file.file_metadata === 'object' && file.file_metadata !== null
                                 ? { /* Reconstruction logic */
                                     people: file.file_metadata.people,
                                     dates: file.file_metadata.dates || [],
                                     locations: file.file_metadata.locations,
                                     topics: file.file_metadata.topics,
                                     type: file.file_metadata.type,
                                     sentiment: file.file_metadata.sentiment
                                   }
                                 : {},
                         }));
                    } else {
                         console.log("Fallback metadata search found no results.");
                         // query_source remains 'none' or 'error', message updated later if text search also fails
                    }
                } else {
                    console.log("No applicable filters for fallback metadata search, skipping.");
                }


                // Attempt Text Search Fallback ONLY if Metadata Search found nothing
                if (retrieved_context.length === 0) {
                    console.log("Attempt 3: Fallback - Full-Text Search on 'files' table using query entities...");

                    // 1. Gather all string entities from the query metadata
                    const entityValues: string[] = [];
                    for (const key in queryMetadata) {
                        if (Array.isArray(queryMetadata[key])) {
                            queryMetadata[key].forEach((item: any) => {
                                if (typeof item === 'string') {
                                    entityValues.push(item);
                                } else if (typeof item === 'object' && item !== null && 'original' in item && typeof item.original === 'string') {
                                    // Handle NormalizedDate objects - use original string
                                    entityValues.push(item.original);
                                }
                            });
                        } else if (typeof queryMetadata[key] === 'string') {
                            // Include top-level string entities like 'type' or 'sentiment' if desired
                            entityValues.push(queryMetadata[key]);
                        }
                    }
                    // Remove duplicates and empty strings
                    const uniqueEntities = [...new Set(entityValues)].filter(e => e.trim() !== '');

                    if (uniqueEntities.length > 0) {
                        // 2. Construct the FTS query string (terms separated by OR '|' for websearch type)
                        // Escape special characters for to_tsquery
                        const ftsQueryString = uniqueEntities
                            .map(term => term.replace(/['&|!():*]/g, '')) // Basic escaping
                            .filter(term => term.trim() !== '')
                            .join(' | ');

                        console.log(`Fallback FTS: Searching for entities: ${ftsQueryString}`);

                        // 3. Build the Supabase query with FTS and optional date filter
                        let ftsQueryBuilder = supabase
                            .from('files')
                            .select('id, transcript_text, created_at, file_metadata, ts_rank_cd(transcript_tsv, to_tsquery(\'english\', $1)) as rank')
                            .textSearch('transcript_tsv', ftsQueryString, {
                                config: 'english',
                                type: 'websearch'
                            })
                            .order('rank', { ascending: false })
                            .limit(FALLBACK_MATCH_COUNT);

                        // Apply Date Filter again if present
                        if (queryDates.length > 0) {
                            const startDate = queryDates[0].normalized;
                            const endDate = queryDates.length > 1 && queryDates[queryDates.length - 1].normalized !== startDate ? queryDates[queryDates.length - 1].normalized : startDate;
                            if (startDate) {
                                try {
                                    const endOfDayISO = formatISO(endOfDay(parseISO(endDate || startDate)));
                                    console.log(`Fallback FTS: Applying created_at filter: >= ${startDate} AND < ${endOfDayISO}`);
                                    ftsQueryBuilder = ftsQueryBuilder.gte('created_at', startDate);
                                    ftsQueryBuilder = ftsQueryBuilder.lt('created_at', endOfDayISO);
                                } catch (dateParseError) {
                                    console.error(`Fallback FTS: Error parsing dates for created_at filter: ${startDate}, ${endDate}`, dateParseError);
                                    // Decide if you want to proceed without date filter or throw error
                                }
                            }
                        }

                        // 4. Execute the FTS query
                        console.log("Executing Fallback FTS Query...");
                        const { data: ftsResults, error: ftsError } = await ftsQueryBuilder;
                        // Note: The type needs adjustment if ts_rank is selected directly
                        const typedTextResults = ftsResults as FallbackResultItem[] | null; 

                        if (ftsError) {
                            console.error("Error during fallback FTS search:", ftsError);
                            if (!vectorSearchFailed && query_source !== 'error') message_for_gpt = `Vector/Metadata search found nothing. Fallback text search failed: ${ftsError.message}`;
                            else message_for_gpt += ` Fallback text search also failed: ${ftsError.message}`;
                            if (query_source !== 'error') query_source = 'error';
                        } else if (typedTextResults && typedTextResults.length > 0) {
                            console.log(`Found ${typedTextResults.length} files via fallback FTS search.`);
                            const previousQuerySource = query_source;
                            query_source = 'postgres_fallback_text';

                            if (vectorSearchFailed || previousQuerySource === 'error') {
                                message_for_gpt += ` Found ${typedTextResults.length} potential match(es) via text fallback.`;
                            } else {
                                message_for_gpt = `Found ${typedTextResults.length} potential match(es) via text search.`;
                            }

                            // Map results (same mapping logic as before)
                            retrieved_context = typedTextResults.map((file: FallbackResultItem) => ({
                                file_id: file.id,
                                chunk: file.transcript_text,
                                timestamp: file.created_at ? new Date(file.created_at).toISOString() : new Date(0).toISOString(),
                                chunk_index: undefined, 
                                entities_in_chunk: typeof file.file_metadata === 'object' && file.file_metadata !== null
                                    ? { 
                                        people: file.file_metadata.people,
                                        dates: file.file_metadata.dates || [],
                                        locations: file.file_metadata.locations,
                                        topics: file.file_metadata.topics,
                                        type: file.file_metadata.type,
                                        sentiment: file.file_metadata.sentiment
                                      }
                                    : {},
                            }));
                        } else {
                            console.log("Fallback FTS search also found no results.");
                            if (query_source !== 'error') {
                                query_source = 'none';
                                message_for_gpt = "I couldn't find any relevant information using vector, metadata, or text search.";
                            } else {
                                message_for_gpt += " Fallback text search also found nothing.";
                            }
                        }
                    } else {
                        console.log("No valid entities found in the query to perform FTS fallback, skipping.");
                        if (query_source !== 'error') {
                            query_source = 'none';
                            message_for_gpt = "I couldn't find any relevant information based on the query filters, and no specific entities were provided for text search.";
                        } else {
                            message_for_gpt += " No specific entities provided for text fallback.";
                        }
                    }
                } // End Text Search Fallback attempt

            } // End of Fallback Logic block (if vector results were empty)

        } // End of 'query'/'combined' block

        // --> Enhancement: Add message about date normalization failures
        let dateNormFailures: string[] = [];
        if (processedMetadata.dates && Array.isArray(processedMetadata.dates)) {
            dateNormFailures = (processedMetadata.dates as NormalizedDate[])
                .filter(d => d.normalized === null && d.original)
                .map(d => `'${d.original}'`);
        }
        if (dateNormFailures.length > 0) {
            const failureMessage = `I couldn't determine a specific date/time for ${dateNormFailures.join(', ')}. Please try providing a clearer date if needed.`;
            message_for_gpt = message_for_gpt ? `${message_for_gpt} ${failureMessage}` : failureMessage;
            console.log("Appending date normalization failure message:", failureMessage);
        }

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