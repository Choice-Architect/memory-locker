import { Handler, HandlerEvent, HandlerContext } from "@netlify/functions";
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import stemmer from '@stdlib/nlp-porter-stemmer';
import {
    formatISO,
    isValid,
    parseISO,
    endOfDay,
    startOfDay,
    startOfWeek,
    endOfWeek,
    startOfMonth,
    endOfMonth,
    startOfYear,
    endOfYear,
    subDays,
    subWeeks,
    subMonths,
    subYears,
    addYears,
    isFuture,
    isPast,
    isSameDay,
    isBefore,
    isAfter,
    addWeeks,
    addDays,
    set,
    format,
    setDay,
    addMonths,
    getWeek,
    getYear,
    getMonth,
    getDate,
    getDay,
    nextMonday,
    nextTuesday,
    nextWednesday,
    nextThursday,
    nextFriday,
    nextSaturday,
    nextSunday,
    previousMonday,
    previousTuesday,
    previousWednesday,
    previousThursday,
    previousFriday,
    previousSaturday,
    previousSunday,
    parse as dateFnsParse,
    differenceInCalendarDays
} from 'date-fns';
import * as chrono from 'chrono-node';

// --- Interfaces for API Contract ---

// v1.7: Interface for the flexible date input from GPT
export type InputDateEntity = string | { original: string; normalized?: string; };

// Interface for Enhanced Date Components (Stored in Metadata/Context)
// REMOVED 'original' and 'note'. All properties are optional.
// v1.7.1: REMOVED time_hour, time_minute, time_second. Only period remains.
export interface EnhancedNormalizedDate {
    year?: number;           // e.g., 2024
    month?: number;          // e.g., 4 (1-12)
    day?: number;            // e.g., 2 (1-31)
    day_of_week?: number;    // e.g., 2 (0=Sun, 1=Mon, 2=Tue...)
    week_number?: number;    // e.g., 14 (ISO 8601 week number, 1-53)
    period?: 'Morning' | 'Afternoon' | 'Evening' | 'Night'; // Derived periods
}

interface ExtractedEntities { // Kept for Request Payload structure
    people?: string[];
    // v1.7: Input uses flexible date types
    dates?: InputDateEntity[];
    locations?: string[];
    topics?: string[];
    type?: string;
    sentiment?: string;
    priority?: number;
    conversation_id?: string;
    thread_id?: string;
    [key: string]: any; // Allow flexible entity types
}

// Interface for entities AFTER internal processing (using v1.7 EnhancedNormalizedDate)
// This is what gets stored in metadata and returned in context objects.
interface ProcessedEntities {
    people?: string[];
    dates?: EnhancedNormalizedDate[]; // Use the v1.7 enhanced structure
    locations?: string[];
    topics?: string[];
    type?: string;
    sentiment?: string;
    priority?: number;
    conversation_id?: string;
    thread_id?: string;
    [key: string]: any;
}

interface RequestPayload {
    query_text: string;
    extracted_entities: ExtractedEntities; // Input uses the original ExtractedEntities
    mode: 'store' | 'query' | 'combined';
}

interface ContextObject {
    chunk: string;
    timestamp: string; // ISO 8601 format
    entities_in_chunk: ProcessedEntities; // Output uses ProcessedEntities with v1.7 EnhancedNormalizedDate
    file_id: string; // UUID as string - Now guaranteed for both sources
    chunk_id?: string; // UUID as string (from vector search)
    chunk_index?: number; // (from vector search)
    similarity?: number; // Raw vector similarity
    rank?: number; // Raw FTS rank
    // v1.8 additions
    source?: 'vector' | 'fts'; // Source of this specific context object before RRF
    rrf_score?: number; // Score after RRF, added internally
    // Deprecated properties (to be removed in final ContextObject)
    // initial_score?: number; // Used during reranking
    // metadata_boost_score?: number; // Used during reranking
    // final_score?: number; // Used during reranking
}

// v1.8: Updated SuccessResponse for hybrid source
interface SuccessResponse {
    retrieved_context: ContextObject[]; // Will contain cleaned ContextObjects (no internal scores)
    storage_status: string;
    // v1.8: Updated enum to match openapi.json (Removed old values)
    query_source: 'hybrid' | 'none' | 'error';
    message_for_gpt?: string;
    error: null;
}

interface ErrorResponse {
    error: string;
}

// Define interface for the structure returned by search_memory_chunks RPC
interface SearchResultItem {
    file_id: string; // UUID as string
    content_chunk: string;
    // Metadata from DB should now contain ProcessedEntities structure
    metadata?: ProcessedEntities & { created_at?: string; [key: string]: any };
    similarity?: number;
    chunk_index?: number;
}

// Define interface for the structure returned by the fallback files query
interface FallbackResultItem {
    id: string; // UUID as string
    file_id: string; // Alias for id
    transcript_text: string;
    created_at: string | null;
    // file_metadata from DB should now contain ProcessedEntities structure
    file_metadata: ProcessedEntities | null;
    rank?: number;
}

// Interface for internal re-ranking
interface ScoredContextObject extends ContextObject {
    initial_score: number; // Normalized RRF score (0-1)
    metadata_boost_score: number; // Sum of weighted boosts
    final_score: number; // Clamped sum of initial + boost
}

// --- Constants ---
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const VECTOR_MATCH_THRESHOLD = 0.5;
const VECTOR_MATCH_COUNT = 15;
const FALLBACK_MATCH_COUNT = 20;
const FINAL_MATCH_COUNT = 5; // Number of results after re-ranking

// v1.8: Added constants for RRF and Entity Weighting
const RRF_K = 60; // RRF constant
const ENTITY_WEIGHTS = {
    people: 0.10,
    locations: 0.10,
    topics: 0.05,
    type: 0.05,
    sentiment: 0.05,
    date_day: 0.15,     // Highest date precision
    date_month: 0.10,   // Medium date precision
    date_year: 0.05,    // Lowest date precision
    date_period: 0.05,  // Morning, Afternoon, etc.
    fts_date_range: 0.10 // Boost for FTS results falling in query date range (applied once)
};

// Simple list of common English stop words - Keep as is
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
                persistSession: false
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
 * Checks if there's any overlap between two arrays. Case-insensitive for strings.
 */
function checkOverlap(arr1?: any[], arr2?: any[]): boolean {
    if (!arr1 || !arr2) return false;
    const set1 = new Set(arr1.map(item => typeof item === 'string' ? item.toLowerCase() : item));
    return arr2.some(item => set1.has(typeof item === 'string' ? item.toLowerCase() : item));
}

// --- START: v1.7 Date Parsing Helper Functions ---

/**
 * v1.7: Parses a date string in "Month DD, YYYY" format using date-fns.
 * @param normalizedDateString The date string (e.g., "April 11, 2025").
 * @param referenceDate The reference date (currently unused for this format).
 * @returns A partial EnhancedNormalizedDate object with date components, or empty if parsing fails.
 */
function parseNormalizedDate(normalizedDateString: string, referenceDate: Date): Partial<EnhancedNormalizedDate> {
    console.log(`Parsing normalized date string: "${normalizedDateString}"`);
    const result: Partial<EnhancedNormalizedDate> = {};
    try {
        // Use 'MMMM d, yyyy' to handle single-digit days correctly (e.g., "May 1, 2025")
        const parsedDate = dateFnsParse(normalizedDateString, 'MMMM d, yyyy', referenceDate);

        if (isValid(parsedDate)) {
            console.log(`  -> Successfully parsed to date: ${parsedDate.toISOString()}`);
            result.year = getYear(parsedDate);
            result.month = getMonth(parsedDate) + 1; // Adjust to 1-12
            result.day = getDate(parsedDate);
            result.day_of_week = getDay(parsedDate); // 0=Sun, 6=Sat
            try {
                result.week_number = getWeek(parsedDate, { weekStartsOn: 1 }); // ISO week number (Monday=1)
            } catch (e) {
                console.warn(`Could not determine week number for ${normalizedDateString}:`, e);
            }
        } else {
            console.warn(`  -> Failed to parse normalized date string: "${normalizedDateString}" using format 'MMMM d, yyyy'.`);
        }
    } catch (e) {
        console.error(`Error parsing normalized date string "${normalizedDateString}":`, e);
        }
        return result;
    }

/**
 * v1.7.1: Extracts ONLY the period of day (Morning, Afternoon, Evening, Night)
 * from the original date/time string based on keywords.
 * Does not attempt to parse specific hours or minutes.
 *
 * @param originalString The original date string provided by the user/GPT.
 * @returns An object containing only the `period` if found, otherwise an empty object.
 */
function extractTimeInfo(originalString: string): Partial<EnhancedNormalizedDate> {
    const lowerCaseString = originalString.toLowerCase();
    const components: Partial<EnhancedNormalizedDate> = {};

    // Define keywords for periods
    const periods = {
        Morning: [/\bmorning\b/, /\b(?:am|a\.m\.)\b/],
        Afternoon: [/\bafternoon\b/, /\bnoon\b/, /\b(?:pm|p\.m\.)\b/], // Treat PM as Afternoon/Evening
        Evening: [/\bevening\b/, /\b(?:pm|p\.m\.)\b/, /\b(?:eod|cob)\b/], // EOD/COB likely Evening
        Night: [/\bnight\b/, /\bmidnight\b/]
    };

    // Check for period keywords (prioritize later periods if both AM/PM and keyword exist)
    if (periods.Night.some(regex => regex.test(lowerCaseString))) {
        components.period = 'Night';
    } else if (periods.Evening.some(regex => regex.test(lowerCaseString))) {
        components.period = 'Evening';
    } else if (periods.Afternoon.some(regex => regex.test(lowerCaseString))) {
        // If PM is found, but not Evening/Night keywords, default to Afternoon
        components.period = 'Afternoon';
    } else if (periods.Morning.some(regex => regex.test(lowerCaseString))) {
        components.period = 'Morning';
    }

    // Simple PM check to potentially override Morning to Afternoon if only PM is specified without other keywords
    if (/\b(?:pm|p\.m\.)\b/.test(lowerCaseString) && components.period === 'Morning') {
         components.period = 'Afternoon'; // Or Evening? Afternoon is safer default.
    }

     // Remove chrono-node usage as it's not needed for period-only extraction
    // console.log(`     -> Final time components extracted: ${JSON.stringify(components)}`);
    return components;
}

/**
 * v1.7: Parses an original date string (when GPT couldn't normalize) using only date-fns.
 * Attempts a limited set of common, unambiguous formats. Does NOT use chrono-node.
 * @param originalString The raw date string from user input or entities.
 * @param referenceDate The reference date for context (e.g., for year inference if needed).
 * @returns A partial EnhancedNormalizedDate object with date components, or empty if parsing fails.
 */
function parseOriginalStringDate(originalString: string, referenceDate: Date): Partial<EnhancedNormalizedDate> {
    console.log(`Parsing original (non-normalized) date string: "${originalString}"`);
    const result: Partial<EnhancedNormalizedDate> = {};
    // Prioritize formats that are less ambiguous or common first
    const formatsToTry = [
        'MM/dd/yyyy', 'M/d/yyyy',
        'yyyy-MM-dd',
        'yyyy/MM/dd',
        'MMMM d, yyyy', 'MMM d, yyyy', // "April 11, 2025", "Apr 11, 2025"
        'MMMM dd, yyyy', 'MMM dd, yyyy', // "April 11, 2025", "Apr 11, 2025"
        'd MMMM yyyy', 'd MMM yyyy', // "11 April 2025", "11 Apr 2025"
        'dd MMMM yyyy', 'dd MMM yyyy' // "11 April 2025", "11 Apr 2025"
        // Add more unambiguous formats if needed, but avoid overly flexible ones
    ];

    // Attempt to crudely strip ordinals (st, nd, rd, th) before parsing
    const stringWithoutOrdinals = originalString.replace(/(?<=\d)(st|nd|rd|th)/gi, '');

    for (const format of formatsToTry) {
        try {
            const parsedDate = dateFnsParse(stringWithoutOrdinals, format, referenceDate);
            if (isValid(parsedDate)) {
                console.log(`  -> Successfully parsed original string using format '${format}': ${parsedDate.toISOString()}`);
                result.year = getYear(parsedDate);
                result.month = getMonth(parsedDate) + 1;
            result.day = getDate(parsedDate);
        result.day_of_week = getDay(parsedDate);
        try {
                result.week_number = getWeek(parsedDate, { weekStartsOn: 1 });
                } catch (e) {
                    console.warn(`  -> Could not determine week number for ${originalString}:`, e);
                }
                // Successfully parsed, break the loop
                return result;
            }
        } catch (e) {
            // Ignore errors and try the next format
        }
    }

    // If no format matched:
    console.warn(`  -> Failed to parse original date string "${originalString}" using any of the predefined date-fns formats.`);
    return {}; // Return empty object indicating failure
}

// --- END: v1.7 Date Parsing Helper Functions ---

/**
 * Maps a database result (from vector search or FTS) to a ContextObject.
 * Minor update: Ensure it uses the v1.7 ProcessedEntities/EnhancedNormalizedDate structure.
 */
function mapDbResultToContextObject(
    dbResult: SearchResultItem | FallbackResultItem,
    sourceType: 'vector_store' | 'postgres_fallback_text'
): ContextObject {
    let contextObject: Partial<ContextObject> = {};

    if (sourceType === 'vector_store') {
        const result = dbResult as SearchResultItem;
        contextObject.file_id = result.file_id;
        contextObject.chunk = result.content_chunk;
        contextObject.timestamp = result.metadata?.created_at ?? new Date(0).toISOString();
        contextObject.chunk_index = result.chunk_index;
        contextObject.similarity = result.similarity;
        // Map metadata assuming it uses the new ProcessedEntities structure
        contextObject.entities_in_chunk = typeof result.metadata === 'object' && result.metadata !== null
            ? {
                people: result.metadata.people,
                dates: (result.metadata.dates as EnhancedNormalizedDate[]) || [], // Cast to v1.7 type
                locations: result.metadata.locations,
                topics: result.metadata.topics,
                type: result.metadata.type,
                sentiment: result.metadata.sentiment,
                priority: result.metadata.priority,
              }
            : {};
    } else { // postgres_fallback_text
        const file = dbResult as FallbackResultItem;
        contextObject.file_id = file.id;
        // Truncation logic remains the same
        contextObject.chunk = file.transcript_text.substring(0, 3000) + (file.transcript_text.length > 3000 ? '...' : '');
        contextObject.rank = file.rank;
        contextObject.timestamp = file.created_at ? new Date(file.created_at).toISOString() : new Date(0).toISOString();
        contextObject.chunk_index = undefined; // Still file-level
        // Map metadata assuming it uses the new ProcessedEntities structure
        contextObject.entities_in_chunk = typeof file.file_metadata === 'object' && file.file_metadata !== null
            ? {
                people: file.file_metadata.people,
                dates: (file.file_metadata.dates as EnhancedNormalizedDate[]) || [], // Cast to v1.7 type
                locations: file.file_metadata.locations,
                topics: file.file_metadata.topics,
                type: file.file_metadata.type,
                sentiment: file.file_metadata.sentiment,
                priority: file.file_metadata.priority,
              }
            : {};
    }

    // Ensure all required fields are present (even if empty/default)
    contextObject.chunk = contextObject.chunk ?? '';
    contextObject.timestamp = contextObject.timestamp ?? new Date(0).toISOString();
    contextObject.entities_in_chunk = contextObject.entities_in_chunk ?? {};

    return contextObject as ContextObject;
}

/**
 * Simple text chunking function. (Keep as is)
 */
function chunkText(text: string, size: number, overlap: number): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + size, text.length);
        chunks.push(text.substring(start, end));
        if (end === text.length) break;
        start += size - overlap;
        start = Math.max(start, end - overlap);
    }
    return chunks;
}

/**
 * Generates embeddings for an array of text chunks using OpenAI API. (Keep as is)
 */
async function generateEmbeddings(chunks: string[]): Promise<(number[] | null)[]> {
    if (!chunks || chunks.length === 0) return [];
    try {
        const response = await openai.embeddings.create({
            model: EMBEDDING_MODEL,
            input: chunks,
            dimensions: EMBEDDING_DIMENSIONS
        });

        if (!response || !response.data || response.data.length !== chunks.length) {
            throw new Error('Unexpected response format from OpenAI embedding API');
        }

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

// Re-ranks retrieved context objects based on initial score and metadata overlap.
async function rerankResults(
    candidates: ContextObject[],
    queryMetadata: ProcessedEntities
): Promise<ContextObject[]> {
    if (!candidates || candidates.length === 0) {
        return [];
    }

    console.log(`Re-ranking ${candidates.length} candidates...`);

    // 1. Normalize RRF Scores (Min-Max Scaling to 0-1)
    let minRrfScore = Infinity;
    let maxRrfScore = -Infinity;
    candidates.forEach(c => {
        if (c.rrf_score !== undefined) {
            minRrfScore = Math.min(minRrfScore, c.rrf_score);
            maxRrfScore = Math.max(maxRrfScore, c.rrf_score);
        }
    });

    const range = maxRrfScore - minRrfScore;

    // Define the normalization function (Moved here)
    const normalize = (score: number | undefined): number => {
        if (score === undefined) return 0; // Handle undefined scores
        if (range === 0) return 1; // Avoid division by zero if all scores are the same
        return (score - minRrfScore) / range;
    };

    const scoredCandidates: ScoredContextObject[] = candidates.map(candidate => {
        const initial_score = normalize(candidate.rrf_score);

        // b. Calculate metadata_boost_score (Granular Additive Boosting)
        let metadata_boost_score = 0.0;
        const candidateEntities = candidate.entities_in_chunk;

        // Check overlaps for different entity types (+0.05 for each type of overlap)
        if (checkOverlap(queryMetadata.people, candidateEntities?.people)) metadata_boost_score += 0.05;
        if (checkOverlap(queryMetadata.locations, candidateEntities?.locations)) metadata_boost_score += 0.05;
        if (checkOverlap(queryMetadata.topics, candidateEntities?.topics)) metadata_boost_score += 0.05;

        // Check for exact match on type
        if (queryMetadata.type && candidateEntities?.type && queryMetadata.type === candidateEntities.type) metadata_boost_score += 0.05;

        // Check for exact match on sentiment
        if (queryMetadata.sentiment && candidateEntities?.sentiment && queryMetadata.sentiment === candidateEntities.sentiment) metadata_boost_score += 0.05;

        // --- START: Revised Hierarchical Date Matching Boost ---
        if (queryMetadata.dates && queryMetadata.dates.length > 0 && candidateEntities?.dates && candidateEntities.dates.length > 0) {
            let dateBoostApplied = 0.0;
            for (const queryDate of queryMetadata.dates) {
                let bestMatchBoost = 0.0;
                for (const candidateDate of candidateEntities.dates) {
                    let currentMatchBoost = 0.0;
                    // Check Day-Level Match (highest priority)
                    if (queryDate.year && queryDate.month && queryDate.day &&
                        candidateDate.year === queryDate.year &&
                        candidateDate.month === queryDate.month &&
                        candidateDate.day === queryDate.day) {
                        currentMatchBoost = 0.05; // Higher boost for exact day
                    }
                    // Check Month-Level Match (medium priority)
                    else if (queryDate.year && queryDate.month &&
                             candidateDate.year === queryDate.year &&
                             candidateDate.month === queryDate.month) {
                        currentMatchBoost = Math.max(currentMatchBoost, 0.03); // Medium boost if month matches (don't overwrite higher day boost)
                    }
                    // Check Year-Level Match (lowest priority)
                    else if (queryDate.year && candidateDate.year === queryDate.year) {
                        currentMatchBoost = Math.max(currentMatchBoost, 0.01); // Low boost if only year matches
                    }

                    // Keep the highest boost found for this queryDate across all candidateDates
                    bestMatchBoost = Math.max(bestMatchBoost, currentMatchBoost);
                    // If we found the best possible match (day level), no need to check other candidateDates for this queryDate
                    if (bestMatchBoost === 0.05) break;
                }
                // Add the best boost found for this queryDate to the total
                dateBoostApplied += bestMatchBoost;
            }
            metadata_boost_score += dateBoostApplied;
             console.log(`Applied hierarchical date boost: +${dateBoostApplied.toFixed(3)} for candidate file ${candidate.file_id} chunk ${candidate.chunk_index}`);
        }
        // --- END: Revised Hierarchical Date Matching Boost ---

        // Language is explicitly excluded

        // --- FTS Date Range Boost (Applied only if source was FTS and query has dates) ---
        // Linter Fix: Compare candidate.source to 'fts' instead of 'postgres_fallback_text'
        if (candidate.source === 'fts' && queryMetadata.dates && queryMetadata.dates.length > 0) {
            let rangeBoostApplied = false;
            for (const queryDate of queryMetadata.dates) {
                // Derive potential range STARTING from queryDate (year, month, day if available)
                if (queryDate.year && queryDate.month && queryDate.day) {
                    try {
                        const rangeDate = new Date(queryDate.year, queryDate.month - 1, queryDate.day);
                        if (isValid(rangeDate) && isPast(rangeDate)) { // Only boost for past ranges
                             const rangeStart = startOfDay(rangeDate);
                             const rangeEnd = endOfDay(rangeDate);
                             const candidateTimestamp = parseISO(candidate.timestamp);

                            if (isValid(candidateTimestamp) && candidateTimestamp >= rangeStart && candidateTimestamp <= rangeEnd) {
                                console.log(`Applying +0.10 date boost to FTS result (timestamp: ${candidate.timestamp} within ${formatISO(rangeStart)}-${formatISO(rangeEnd)})`);
                                metadata_boost_score += 0.10;
                                rangeBoostApplied = true;
                                break; // Apply boost only once per candidate
                            }
                        }
                    } catch (e) { console.warn(`Error creating date range for FTS boost from queryDate ${JSON.stringify(queryDate)}:`, e); }
                }
                // Can add logic here for year/month ranges if needed
            }
        }

        // d. Calculate final_score
        let final_score = Math.min(1.0, initial_score + metadata_boost_score);

        // e. Populate Scored Object
        return {
            ...candidate,
            initial_score,
            metadata_boost_score,
            final_score,
        };
    });

    // f. Sort by final_score (descending)
    scoredCandidates.sort((a, b) => b.final_score - a.final_score);

    console.log("Scores after re-ranking:", scoredCandidates.map(c => ({ file_id: c.file_id, chunk_index: c.chunk_index, initial: c.initial_score.toFixed(3), boost: c.metadata_boost_score.toFixed(3), final: c.final_score.toFixed(3) })));

    // g. Trim to FINAL_MATCH_COUNT
    const topResults = scoredCandidates.slice(0, FINAL_MATCH_COUNT);

    // h. Map back to ContextObject (removing temporary scores)
    const finalContext: ContextObject[] = topResults.map(scored => {
        const { initial_score, metadata_boost_score, final_score, ...contextObject } = scored;
        return contextObject;
    });

    // i. Return
    console.log(`Returning ${finalContext.length} results after re-ranking.`);
    return finalContext;
}

// --- START: v1.8 Hybrid Search Helper Functions ---

/**
 * Executes the vector search RPC call against Supabase.
 * @param embedding The query embedding vector.
 * @param queryMetadata Processed query entities for filtering.
 * @returns A promise resolving to an array of ContextObjects from vector search, or empty array on error.
 */
async function executeVectorSearch(
    embedding: number[],
    queryMetadata: ProcessedEntities
): Promise<ContextObject[]> {
    console.log("Executing Vector Search...");
    try {
        const { data: searchResults, error: searchError } = await supabase.rpc(
            'search_memory_chunks',
            { // Use named parameters matching the SQL function definition
                query_embedding: embedding,
                match_threshold: VECTOR_MATCH_THRESHOLD,
                match_count: VECTOR_MATCH_COUNT, // Get more results initially for RRF
                filter_topics: queryMetadata.topics || null,
                filter_people: queryMetadata.people || null,
                filter_locations: queryMetadata.locations || null,
                filter_type: queryMetadata.type || null,
                filter_sentiment: queryMetadata.sentiment || null,
            }
        );

        if (searchError) {
            console.error("Error during vector search RPC call:", searchError);
            return []; // Return empty on error
        }

        const typedSearchResults = searchResults as SearchResultItem[] | null;
        if (typedSearchResults && typedSearchResults.length > 0) {
            console.log(`Vector search found ${typedSearchResults.length} raw results.`);
            // Map results to ContextObject, adding source and preserving similarity
            return typedSearchResults.map(result => ({
                chunk: result.content_chunk,
                timestamp: result.metadata?.created_at ?? new Date(0).toISOString(),
                entities_in_chunk: typeof result.metadata === 'object' && result.metadata !== null
                    ? {
                        people: result.metadata.people,
                        dates: (result.metadata.dates as EnhancedNormalizedDate[]) || [],
                        locations: result.metadata.locations,
                        topics: result.metadata.topics,
                        type: result.metadata.type,
                        sentiment: result.metadata.sentiment,
                        priority: result.metadata.priority,
                      }
                    : {},
                file_id: result.file_id,
                chunk_id: undefined, // chunk_id not returned by current RPC, adjust if needed
                chunk_index: result.chunk_index,
                similarity: result.similarity,
                source: 'vector', // Set source
                rank: undefined, // Not applicable for vector
            }));
        } else {
            console.log("Vector search yielded no results.");
            return [];
        }
    } catch (error) {
        console.error("Unexpected error during vector search execution:", error);
        return []; // Return empty on unexpected errors
    }
}

/**
 * Executes the Full-Text Search (FTS) query against the 'files' table.
 * @param queryMetadata Processed query entities.
 * @param originalQueryEntities Original entities from the request (needed for raw date strings).
 * @returns A promise resolving to an array of ContextObjects from FTS search, or empty array on error.
 */
async function executeFtsSearch(
    queryMetadata: ProcessedEntities,
    originalQueryEntities: ExtractedEntities
): Promise<ContextObject[]> {
    console.log("Executing FTS Search...");
    try {
        // 1. Gather entities for FTS (include ORIGINAL date strings from input)
        const entityValues: string[] = [];
        // Use originalQueryEntities to get raw date strings
        if (originalQueryEntities.dates) {
            originalQueryEntities.dates.forEach(dateInput => {
                if (typeof dateInput === 'string') {
                    entityValues.push(dateInput);
                } else if (typeof dateInput === 'object' && dateInput.original) {
                    entityValues.push(dateInput.original); // Use original string from object
                }
            });
        }
        // Use processedMetadata for other entities
        (queryMetadata.people || []).forEach(p => entityValues.push(p));
        (queryMetadata.locations || []).forEach(l => entityValues.push(l));
        (queryMetadata.topics || []).forEach(t => entityValues.push(t));
        if (queryMetadata.type) entityValues.push(queryMetadata.type);
        if (queryMetadata.sentiment) entityValues.push(queryMetadata.sentiment);
        // DO NOT include queryMetadata.language

        // Remove duplicates and empty strings
        const uniqueEntities = [...new Set(entityValues)].filter(e => e && e.trim() !== '');

        if (uniqueEntities.length === 0) {
            console.log("No valid non-language entities found for FTS query.");
            return [];
        }

        // 2. Construct the FTS query string
        const ftsQueryString = uniqueEntities
            .map(term => term.replace(/['&|!():*]/g, '')) // Basic escaping
            .filter(term => term.trim() !== '')
            .join(' | ');

        console.log(`FTS Search: Using query string: "${ftsQueryString}"`);

        // 3. Build the Supabase query with FTS
        const { data: ftsResults, error: ftsError } = await supabase
            .from('files')
            .select('id, transcript_text, created_at, file_metadata, rank:ts_rank_cd(transcript_tsv, to_tsquery(\'english\', $1))')
            .textSearch('transcript_tsv', ftsQueryString, {
                config: 'english',
                type: 'websearch',
                // Removed explicit rank normalization here, will use raw rank for RRF position
            })
            .order('rank', { ascending: false }) // Higher rank is better
            .limit(FALLBACK_MATCH_COUNT); // Get more results initially for RRF

        if (ftsError) {
            console.error("Error during FTS search:", ftsError);
            return [];
        }
        // Linter Fix: Add 'as any' to handle potential type mismatch from Supabase client
        const typedTextResults = ftsResults as any as (FallbackResultItem & { rank?: number })[] | null;

        if (typedTextResults && typedTextResults.length > 0) {
            console.log(`FTS search found ${typedTextResults.length} raw results.`);
            // Map results to ContextObject, adding source and preserving rank
            return typedTextResults.map(file => ({
                chunk: file.transcript_text.substring(0, 3000) + (file.transcript_text.length > 3000 ? '...' : ''), // Truncate
                timestamp: file.created_at ? new Date(file.created_at).toISOString() : new Date(0).toISOString(),
                entities_in_chunk: typeof file.file_metadata === 'object' && file.file_metadata !== null
                    ? {
                        people: file.file_metadata.people,
                        dates: (file.file_metadata.dates as EnhancedNormalizedDate[]) || [],
                        locations: file.file_metadata.locations,
                        topics: file.file_metadata.topics,
                        type: file.file_metadata.type,
                        sentiment: file.file_metadata.sentiment,
                        priority: file.file_metadata.priority,
                      }
                    : {},
                file_id: file.id, // Use 'id' from files table as file_id
                chunk_id: undefined, // Not applicable for FTS
                chunk_index: undefined, // Not applicable for FTS
                similarity: undefined, // Not applicable for FTS
                rank: file.rank, // Preserve raw FTS rank
                source: 'fts', // Set source
            }));
        } else {
            console.log("FTS search yielded no results.");
            return [];
        }
    } catch (error) {
        console.error("Unexpected error during FTS search execution:", error);
        return [];
    }
}

/**
 * Applies Reciprocal Rank Fusion (RRF) to combine results from vector and FTS searches.
 * @param vectorResults Array of ContextObjects from vector search.
 * @param ftsResults Array of ContextObjects from FTS search.
 * @param k The RRF ranking constant (default: 60).
 * @returns A single array of ContextObjects sorted by descending RRF score, with rrf_score property added.
 */
function applyRRF(
    vectorResults: ContextObject[],
    ftsResults: ContextObject[],
    k: number = RRF_K
): ContextObject[] {
    console.log(`Applying RRF with k=${k} to ${vectorResults.length} vector and ${ftsResults.length} FTS results.`);
    // Use file_id as the primary key for fusion
    const rrfScores = new Map<string, { score: number; context: ContextObject }>();

    // Process vector results (ranked by index implicitly)
    vectorResults.forEach((result, index) => {
        const rank = index + 1;
        const scoreIncrement = 1 / (k + rank);
        const existing = rrfScores.get(result.file_id);
        if (existing) {
            existing.score += scoreIncrement;
            // Keep the vector context if collision (usually more granular)
        } else {
            rrfScores.set(result.file_id, { score: scoreIncrement, context: result });
        }
    });

    // Process FTS results (ranked by index implicitly)
    ftsResults.forEach((result, index) => {
        const rank = index + 1;
        const scoreIncrement = 1 / (k + rank);
        const existing = rrfScores.get(result.file_id);
        if (existing) {
            existing.score += scoreIncrement;
            // If vector context exists, don't overwrite. FTS rank is stored on its context object.
        } else {
            // Only add if not already present from vector search
            rrfScores.set(result.file_id, { score: scoreIncrement, context: result });
        }
    });

    // Convert map to array and sort by RRF score descending
    const fusedResults = Array.from(rrfScores.values())
        .sort((a, b) => b.score - a.score);

    console.log(`RRF produced ${fusedResults.length} fused results.`);

    // Map back to ContextObject[], adding the rrf_score
    return fusedResults.map(item => ({
        ...item.context,
        rrf_score: item.score // Add the calculated RRF score
    }));
}

// --- END: v1.8 Hybrid Search Helper Functions ---

// --- Main Handler Function ---
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
        let storage_status: string = "No storage operation performed.";
        // v1.8: Default query source to 'none', will be updated based on search results
        let query_source: SuccessResponse['query_source'] = 'none';
        let message_for_gpt: string = ""; // Initialize message for GPT

        // --- Date Processing (Applied to ALL modes upfront using v1.7 logic) ---
        const processedMetadata: ProcessedEntities = { ...payload.extracted_entities, dates: [] }; // Initialize with other entities, clear dates array
        const rawInputDates = payload.extracted_entities.dates;
        const successfullyParsedDates: EnhancedNormalizedDate[] = [];
        const referenceDate = new Date(); // Use current server time as reference

        console.log("Parsing dates with reference:", referenceDate.toISOString());

        if (rawInputDates && Array.isArray(rawInputDates)) {
            for (const dateEntity of rawInputDates) { // Use for...of for clarity
                let originalString: string;
                let normalizedDateString: string | undefined = undefined;
                let datePart: Partial<EnhancedNormalizedDate> = {};

                // 1. Determine original string and potential normalized string
                if (typeof dateEntity === 'string') {
                    originalString = dateEntity;
                    console.log(`Processing date entity (string): "${originalString}"`);
                } else if (dateEntity && typeof dateEntity === 'object' && typeof dateEntity.original === 'string') {
                    originalString = dateEntity.original;
                    normalizedDateString = dateEntity.normalized ?? undefined; // Use nullish coalescing
                    console.log(`Processing date entity (object): original="${originalString}", normalized="${normalizedDateString}"`);
                } else {
                    console.warn("Skipping invalid date input format:", dateEntity);
                    continue; // Skip this iteration
                }

                // 2. Parse Date Part (v1.7 Logic)
                if (normalizedDateString) {
                    // Prioritize parsing the GPT-provided normalized date ("Month DD, YYYY")
                    datePart = parseNormalizedDate(normalizedDateString, referenceDate);
                        } else {
                    // If no normalized date, attempt to parse the original string using date-fns only
                    datePart = parseOriginalStringDate(originalString, referenceDate);
                }

                // 3. Always Extract Time Part from Original String (v1.7 Logic)
                const timePart = extractTimeInfo(originalString);

                // 4. Combine Date and Time Parts (v1.7 Logic)
                const combinedComponents: Partial<EnhancedNormalizedDate> = { ...datePart, ...timePart };

                // 5. Validation & Storage (v1.7 Logic)
                // Store if we have at least year/month/day OR if we have *only* time components (i.e., just period now)
                // (avoids storing empty objects if all parsing failed)
                if (Object.keys(combinedComponents).length > 0 &&
                    (combinedComponents.year || combinedComponents.month || combinedComponents.day ||
                     // v1.7.1: Check only for period if date components are missing
                     (!combinedComponents.year && !combinedComponents.month && !combinedComponents.day && (combinedComponents.period))))
                {
                    console.log(`  -> Storing combined components: ${JSON.stringify(combinedComponents)}`);
                    successfullyParsedDates.push(combinedComponents); // Add the valid, combined object
                } else {
                     console.warn(`  -> Discarding components for "${originalString}" as no core date/time info was extracted: ${JSON.stringify(combinedComponents)}`);
                }
            }
        }
        // Assign the successfully processed dates (EnhancedNormalizedDate[]) to the final metadata object
        processedMetadata.dates = successfullyParsedDates;
        console.log("--- Finished v1.7 Date Processing ---");
        console.log("Final Processed Metadata:", JSON.stringify(processedMetadata));
        // --- END: Date Processing (Applied to ALL modes upfront using v1.7 logic) ---

        // Mode handling: store, query, combined
        const mode = payload.mode;
        let queryEmbedding: number[] | null = null; // Initialize query embedding

        // 2. Process based on mode
        if (payload.mode === 'store' || payload.mode === 'combined') {
            console.log("Processing 'store' mode...");
            const textToStore = payload.query_text;

            // Use the processedMetadata which now contains EnhancedNormalizedDate[]
            const fileMetadata: ProcessedEntities = {
                 // Use properties from processedMetadata
                 people: processedMetadata.people,
                 locations: processedMetadata.locations,
                 topics: processedMetadata.topics,
                 type: processedMetadata.type,
                 sentiment: processedMetadata.sentiment,
                 priority: processedMetadata.priority,
                 dates: processedMetadata.dates, // Assign the newly parsed EnhancedNormalizedDate[]
                 // conversation_id and thread_id are top-level in 'files' table
            };

            console.log("Storing File Metadata:", JSON.stringify(fileMetadata));

            // a. Insert into 'files' table
            console.log("Preparing to insert into files table with processed metadata...");
            const fileInsertData: { [key: string]: any } = {
                transcript_text: textToStore,
                file_metadata: fileMetadata, // Store processed metadata with EnhancedNormalizedDate[]
                title: textToStore.substring(0, 50) + (textToStore.length > 50 ? '...' : ''),
                file_type: 'gpt_interaction',
                // Get conversation/thread IDs from the original payload
                conversation_id: payload.extracted_entities.conversation_id || null,
                thread_id: payload.extracted_entities.thread_id || null,
            };

            const { data: fileData, error: fileError } = await supabase
                .from('files')
                .insert(fileInsertData)
                .select('id')
                .single();

            if (fileError || !fileData) {
                console.error("Error inserting into files table:", fileError);
                throw new Error(`Failed to store file record: ${fileError?.message || 'No ID returned'}`);
            }
            const fileId = fileData.id;
            console.log(`File record created with ID: ${fileId}`);


            // b. Chunk the text
            console.log("Chunking text...");
            const chunks = chunkText(textToStore, CHUNK_SIZE, CHUNK_OVERLAP);
            if (chunks.length === 0) {
                 console.warn("No chunks generated for the provided text.");
                 storage_status = `Stored file record (ID: ${fileId}) but no text chunks were generated or stored.`;
                 // Skip embedding if no chunks
            } else {
                 console.log(`Generated ${chunks.length} chunks.`);

                 // c. Generate embeddings for chunks
                 console.log("Generating embeddings...");
                 const embeddings = await generateEmbeddings(chunks);
                 const validEmbeddings = embeddings.filter(e => e !== null) as number[][];
                 const validChunks = chunks.filter((_, i) => embeddings[i] !== null);

                 if (validEmbeddings.length === 0) {
                     throw new Error("Failed to generate any valid embeddings.");
                 }

                 if (validChunks.length > 0) {
                     // d. Prepare records for 'transcript_embeddings'
                     const timestamp = new Date().toISOString();
                     const embeddingRecords = validChunks.map((chunk, index) => ({
                         file_id: fileId,
                         content_chunk: chunk,
                         embedding: validEmbeddings[index],
                         metadata: {
                             ...fileMetadata,
                             created_at: timestamp,
                             chunk_index: index,
                         },
                     }));

                     // e. Insert into 'transcript_embeddings' table
                     if (embeddingRecords.length > 0) {
                         console.log(`Inserting ${embeddingRecords.length} embedding records...`);
                         const { error: embeddingError } = await supabase
                             .from('transcript_embeddings')
                             .insert(embeddingRecords as any); // Cast to any if TS complains about embedding type mismatch

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
        }

        if (payload.mode === 'query' || payload.mode === 'combined') {
            console.log("Processing 'query' mode...");
            const queryText = payload.query_text;
            // Use processedMetadata which has EnhancedNormalizedDate[]
            const queryMetadata = processedMetadata;
             // Use original entities for FTS query construction (raw date strings)
            const originalQueryEntities = payload.extracted_entities;

            if (!queryText) {
                 throw new Error("query_text is required for 'query' or 'combined' mode.");
            }

            // a. Generate embedding for the query text
            console.log("Generating embedding for query text...");
            try {
                const queryEmbeddingResponse = await openai.embeddings.create({
                    model: EMBEDDING_MODEL,
                    input: queryText,
                    dimensions: EMBEDDING_DIMENSIONS,
                });
                queryEmbedding = queryEmbeddingResponse?.data[0]?.embedding;
                if (!queryEmbedding) {
                    throw new Error("Failed to generate query embedding (empty response).");
                }
            } catch (embeddingError) {
                 console.error("Error generating query embedding:", embeddingError);
                 // Don't throw here, allow FTS to proceed if embedding fails
                 message_for_gpt = `Warning: Failed to generate query embedding. Proceeding with text search only. Error: ${embeddingError instanceof Error ? embeddingError.message : String(embeddingError)}`;
                 query_source = 'error'; // Indicate an error occurred, even if FTS works
            }


            // b. Execute Concurrent Searches (Vector + FTS)
            let vectorResults: ContextObject[] = [];
            let ftsResults: ContextObject[] = [];

            // Only run vector search if embedding was successful
            const searchPromises: Promise<ContextObject[]>[] = [];
            if (queryEmbedding) {
                searchPromises.push(executeVectorSearch(queryEmbedding, queryMetadata));
            } else {
                 searchPromises.push(Promise.resolve([])); // Add placeholder if embedding failed
            }
            // Always run FTS search
            searchPromises.push(executeFtsSearch(queryMetadata, originalQueryEntities));


            const searchResultsSettled = await Promise.allSettled(searchPromises);

            if (searchResultsSettled[0].status === 'fulfilled') {
                 vectorResults = searchResultsSettled[0].value;
            } else {
                 console.error("Vector search promise rejected:", searchResultsSettled[0].reason);
                 if(query_source !== 'error') message_for_gpt += " Vector search failed."; // Append if no embedding error yet
                 query_source = 'error';
            }

            if (searchResultsSettled[1].status === 'fulfilled') {
                 ftsResults = searchResultsSettled[1].value;
            } else {
                 console.error("FTS search promise rejected:", searchResultsSettled[1].reason);
                  if(query_source !== 'error') message_for_gpt += " Text search failed.";
                  query_source = 'error';
            }

            console.log(`Concurrent searches finished. Vector: ${vectorResults.length}, FTS: ${ftsResults.length}`);

            // c. Apply RRF
            let combinedResults: ContextObject[] = [];
            if (vectorResults.length > 0 || ftsResults.length > 0) {
                 combinedResults = applyRRF(vectorResults, ftsResults);
            } else {
                 console.log("No results from either vector or FTS search before RRF.");
            }


            // d. Determine Query Source (based on results *before* re-ranking)
            if (query_source !== 'error') { // Only set non-error source if no errors occurred
                // Simplified logic: If any results exist, it must be hybrid (or handled by 'none' later)
                if (combinedResults.length > 0) {
                    query_source = 'hybrid';
                    message_for_gpt = `Found ${combinedResults.length} potential matches from combined vector and text search.`;
                } else {
                    query_source = 'none';
                    message_for_gpt = "I couldn't find any relevant information matching your query.";
                }
            } else {
                 // Keep error message, but clarify if *any* results were found despite errors
                 if(combinedResults.length > 0) {
                      message_for_gpt += ` Found ${combinedResults.length} partial results despite errors.`;
                 } else {
                      message_for_gpt += " No results found.";
                 }
            }


            // e. Apply Re-ranking
            if (combinedResults.length > 0) {
                 console.log(`Calling rerankResults for ${combinedResults.length} candidates from source: ${query_source}...`);
                 // Pass the RRF results (with rrf_score) to the new rerankResults
                 retrieved_context = await rerankResults(combinedResults, queryMetadata);
                 // Update message if results were trimmed
                 if (retrieved_context.length < combinedResults.length && retrieved_context.length > 0) {
                     message_for_gpt += ` Displaying top ${retrieved_context.length} after re-ranking.`;
                 } else if (retrieved_context.length === 0 && combinedResults.length > 0) {
                      message_for_gpt = "Found initial matches, but none scored high enough after re-ranking.";
                      query_source = 'none'; // Set source to none if re-ranking filters everything
                 }
            } else {
                 console.log("Skipping re-ranking as there are no combined results.");
                 retrieved_context = []; // Ensure context is empty
            }

        } // End of 'query'/'combined' block


        // --- Final Response Construction ---
        console.log(`Final retrieved_context count: ${retrieved_context.length}, final query_source: ${query_source}`);

        const successResponse: SuccessResponse = {
            retrieved_context: retrieved_context, // Contains cleaned ContextObjects after re-ranking
            storage_status: storage_status,
            // Ensure query_source reflects the final state (e.g., 'none' if re-ranking removed all)
            query_source: retrieved_context.length > 0 ? query_source : (query_source === 'error' ? 'error' : 'none'),
            message_for_gpt: message_for_gpt || (query_source === 'none' ? "No relevant information found." : ""), // Provide default 'none' message if empty
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
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: errorMessage } as ErrorResponse),
        };
    }
};

export { handler }; 