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
    addMonths
} from 'date-fns';
import * as chrono from 'chrono-node';

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
    similarity?: number; // Added: Optional similarity score from vector search
    rank?: number; // Added: Optional rank score from FTS
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
    rank?: number; // Added: Optional rank score from FTS
}

// NEW Interface for internal re-ranking
interface ScoredContextObject extends ContextObject {
    initial_score: number; // Normalized initial score (0-1)
    metadata_boost_score: number; // Calculated boost
    final_score: number;  // Score after boost
}

// --- Constants ---
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536; // Dimension for text-embedding-3-small
const CHUNK_SIZE = 1000; // Target size in characters
const CHUNK_OVERLAP = 200; // Overlap in characters
const VECTOR_MATCH_THRESHOLD = 0.5; // Similarity threshold for vector search (Lowered from 0.75)
const VECTOR_MATCH_COUNT = 15;     // Max number of chunks to retrieve via vector search (Updated for re-ranking)
const FALLBACK_MATCH_COUNT = 20; // Max number of files to retrieve via FTS fallback (Updated for re-ranking)
const FINAL_MATCH_COUNT = 5;     // Final number of results to return after re-ranking
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

// ADD NEW deriveDateRange function
/**
 * Analyzes an array of EnhancedNormalizedDate objects to derive a specific,
 * historical date range suitable for filtering.
 * Prefers the first specific, past range found.
 * Returns null if no suitable range can be determined.
 */
function deriveDateRange(dates: EnhancedNormalizedDate[] | undefined, referenceDate: Date = new Date()): { startDate: string; endDate: string } | null {
    if (!dates || dates.length === 0) {
        return null;
    }

    console.log("Deriving date range from:", JSON.stringify(dates));

    for (const dateInfo of dates) {
        let potentialStart: Date | null = null;
        let potentialEnd: Date | null = null;

        // Try using chrono's parsed date directly if fully specified and in the past
        if (dateInfo.normalized && dateInfo.year && dateInfo.month && dateInfo.day) {
            try {
                const parsed = parseISO(dateInfo.normalized);
                if (isValid(parsed) && isPast(parsed)) {
                    // Use the specific day
                    potentialStart = startOfDay(parsed);
                    potentialEnd = endOfDay(parsed);
                    console.log(`Derived range from normalized date: ${dateInfo.original}`);
                } else {
                     console.log(`Normalized date ${dateInfo.normalized} is invalid or in the future, skipping.`);
                }
            } catch (e) {
                console.warn(`Error parsing normalized date ${dateInfo.normalized}, ignoring.`);
            }
        }

        // Handle specific relative terms if no date derived yet
        // Check keywords in the original string instead of removed properties
        const lowerOriginal = dateInfo.original.toLowerCase();
        if (!potentialStart && /\blast\b/.test(lowerOriginal)) {
            if (/\bday\b/.test(lowerOriginal) || /yesterday/i.test(lowerOriginal)) {
                potentialStart = startOfDay(subDays(referenceDate, 1));
                potentialEnd = endOfDay(subDays(referenceDate, 1));
                console.log(`Derived range from relative term: yesterday/last day`);
            }
             else if (/\bweek\b/.test(lowerOriginal)) {
                potentialStart = startOfWeek(subWeeks(referenceDate, 1)); // Consider locale for start of week
                potentialEnd = endOfWeek(subWeeks(referenceDate, 1));
                console.log(`Derived range from relative term: last week`);
            }
             else if (/\bmonth\b/.test(lowerOriginal)) {
                potentialStart = startOfMonth(subMonths(referenceDate, 1));
                potentialEnd = endOfMonth(subMonths(referenceDate, 1));
                console.log(`Derived range from relative term: last month`);
            }
             else if (/\byear\b/.test(lowerOriginal)) {
                potentialStart = startOfYear(subYears(referenceDate, 1));
                potentialEnd = endOfYear(subYears(referenceDate, 1));
                console.log(`Derived range from relative term: last year`);
            }
        }

        // If we found a valid past range, return it (prioritizing the first one found)
        if (potentialStart && potentialEnd && isValid(potentialStart) && isValid(potentialEnd) && isPast(potentialEnd)) {
            return {
                startDate: formatISO(potentialStart),
                endDate: formatISO(potentialEnd),
            };
        }
    }

    console.log("No specific, historical date range could be derived.");
    return null; // No suitable range found
}

// NEW checkOverlap helper function for re-ranking
/**
 * Checks if two arrays share at least one common element.
 * Performs case-insensitive comparison for strings.
 * Handles null/undefined arrays gracefully.
 */
function checkOverlap(arr1?: any[], arr2?: any[]): boolean {
    if (!arr1 || !arr2 || arr1.length === 0 || arr2.length === 0) {
        return false;
    }

    const set1 = new Set(arr1.map(item => (typeof item === 'string' ? item.toLowerCase() : item)));

    for (const item2 of arr2) {
        const normalizedItem2 = typeof item2 === 'string' ? item2.toLowerCase() : item2;
        if (set1.has(normalizedItem2)) {
            return true;
        }
    }

    return false;
}

/**
 * Refined date parsing function (v1.4).
 * Assumes input 'dateString' is English (due to GPT pre-translation).
 * Uses chrono-node for initial parsing, then date-fns for corrections and specific resolutions.
 * Aims to return accurate year, month, day, and time components, with a correctly formatted normalized string.
 */
function parseDateStringToEnhanced(dateString: string, referenceDate: Date): EnhancedNormalizedDate {
    // Input Assumption: dateString is assumed to be English.

    const results = chrono.parse(dateString, referenceDate, { forwardDate: true });

    if (results.length === 0) {
        return { original: dateString, note: "No date components found" };
    }

    const result = results[0];
    const components = result.start;
    const chronoDate = result.date(); // Get the initial Date object from chrono

    // Use ?? undefined to handle potential null returns from .get()
    let correctedYear: number | undefined = components.get('year') ?? undefined;
    let correctedMonth: number | undefined = components.get('month') ?? undefined; // 1-12
    let correctedDay: number | undefined = components.get('day') ?? undefined;
    let correctedHour: number | undefined = undefined;
    let correctedMinute: number | undefined = undefined;
    let correctedSecond: number | undefined = undefined;

    let dateIsCertain = false;
    let timeIsCertain = false;
    let finalDate: Date | null = null; // To store the date-fns calculated date

    // --- 1. Day Boundary Correction ---
    // If chrono resolved to the *next* day for end-of-day phrases, correct it back to referenceDate's day.
    const lowerCaseDateString = dateString.toLowerCase();
    if (/\b(end of day|tonight|eod)\b/.test(lowerCaseDateString)) {
        if (isValid(chronoDate) && !isSameDay(chronoDate, referenceDate)) {
            console.log(`Correcting day boundary for '${dateString}'`);
            correctedYear = referenceDate.getFullYear();
            correctedMonth = referenceDate.getMonth() + 1; // JS month is 0-indexed
            correctedDay = referenceDate.getDate();
        } else if (isValid(chronoDate) && isSameDay(chronoDate, referenceDate)) {
            // If it's already the same day, keep chrono's components
            correctedYear = chronoDate.getFullYear();
            correctedMonth = chronoDate.getMonth() + 1;
            correctedDay = chronoDate.getDate();
        }
         else {
             // Fallback if chronoDate invalid
             correctedYear = referenceDate.getFullYear();
             correctedMonth = referenceDate.getMonth() + 1;
             correctedDay = referenceDate.getDate();
         }
        // Explicitly unset time for these phrases
        correctedHour = undefined;
        correctedMinute = undefined;
        correctedSecond = undefined;
    }

    // --- 2. Relative Date Resolution (using date-fns) ---
    let calculatedDate: Date | null = null; // Use this to store date-fns results

    // Check chrono certainty vs. keywords
    if (components.isCertain('weekday') && !components.isCertain('day')) {
        const weekday = components.get('weekday') ?? referenceDate.getDay(); // Default to current day if null
        if (/\bnext\b/i.test(dateString)) {
            calculatedDate = setDay(referenceDate, weekday, { weekStartsOn: 1 }); // Assuming week starts Monday
             if (calculatedDate && (isBefore(calculatedDate, referenceDate) || isSameDay(calculatedDate, referenceDate))) {
                  calculatedDate = addWeeks(calculatedDate, 1);
             }
             console.log(`Resolved 'next weekday' for '${dateString}'`);
        } else if (/\blast\b/i.test(dateString)) {
            calculatedDate = setDay(referenceDate, weekday, { weekStartsOn: 1 });
            if (calculatedDate && (isAfter(calculatedDate, referenceDate) || isSameDay(calculatedDate, referenceDate))) {
                 calculatedDate = subWeeks(calculatedDate, 1);
            }
            console.log(`Resolved 'last weekday' for '${dateString}'`);
        }
        // If just a weekday name without 'next'/'last', chrono might get it right, but let's check
        else if (isValid(chronoDate) && isSameDay(chronoDate, referenceDate) && referenceDate.getDay() !== weekday) {
             // Chrono might default to today, use setDay to be sure
             calculatedDate = setDay(referenceDate, weekday, { weekStartsOn: 1 });
             // Ambiguous - assume future? Or nearest? Let's assume nearest future/past based on chrono guess
             if(calculatedDate) {
                 if(isAfter(chronoDate, referenceDate)) { // Chrono guessed future
                    if (isBefore(calculatedDate, referenceDate) || isSameDay(calculatedDate, referenceDate)) {
                        calculatedDate = addWeeks(calculatedDate, 1);
                    }
                 } else { // Chrono guessed past or today
                     if (isAfter(calculatedDate, referenceDate) || isSameDay(calculatedDate, referenceDate)) {
                        calculatedDate = subWeeks(calculatedDate, 1);
                     }
                 }
             }
             console.log(`Resolved specific weekday '${dateString}'`);
        }


    } else if (/\btomorrow\b/i.test(dateString)) {
        calculatedDate = addDays(referenceDate, 1);
        console.log(`Resolved 'tomorrow' for '${dateString}'`);
    } else if (/\byesterday\b/i.test(dateString)) {
        calculatedDate = subDays(referenceDate, 1);
        console.log(`Resolved 'yesterday' for '${dateString}'`);
    } else if (/\blast week\b/i.test(dateString)) {
        // Get year/month of start of last week. Day becomes uncertain.
        const startOfLastWeek = startOfWeek(subWeeks(referenceDate, 1), { weekStartsOn: 1 });
        correctedYear = startOfLastWeek.getFullYear();
        correctedMonth = startOfLastWeek.getMonth() + 1;
        correctedDay = undefined; // Day is uncertain
        console.log(`Resolved 'last week' for '${dateString}'`);
    } else if (/\bnext week\b/i.test(dateString)) {
         const startOfNextWeek = startOfWeek(addWeeks(referenceDate, 1), { weekStartsOn: 1 });
         correctedYear = startOfNextWeek.getFullYear();
         correctedMonth = startOfNextWeek.getMonth() + 1;
         correctedDay = undefined;
         console.log(`Resolved 'next week' for '${dateString}'`);
    } else if (/\blast month\b/i.test(dateString)) {
        const startOfLastMonth = startOfMonth(subMonths(referenceDate, 1));
        correctedYear = startOfLastMonth.getFullYear();
        correctedMonth = startOfLastMonth.getMonth() + 1;
        correctedDay = undefined;
        console.log(`Resolved 'last month' for '${dateString}'`);
    } else if (/\bnext month\b/i.test(dateString)) {
        const startOfNextMonth = startOfMonth(addMonths(referenceDate, 1));
        correctedYear = startOfNextMonth.getFullYear();
        correctedMonth = startOfNextMonth.getMonth() + 1;
        correctedDay = undefined;
        console.log(`Resolved 'next month' for '${dateString}'`);
    }
    // ... add more relative resolutions if needed ...

    // If date-fns calculated a date, use its components
    if (calculatedDate && isValid(calculatedDate)) {
        correctedYear = calculatedDate.getFullYear();
        correctedMonth = calculatedDate.getMonth() + 1;
        correctedDay = calculatedDate.getDate();
        finalDate = calculatedDate; // Store for normalization
    } else if (isValid(chronoDate)) {
        // If no specific relative rule matched, but chrono gave a valid date, use it
        // Re-apply boundary correction if it happened
         if (/\b(end of day|tonight|eod)\b/.test(lowerCaseDateString) && !isSameDay(chronoDate, referenceDate)) {
             finalDate = set(referenceDate, { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 });
             correctedYear = finalDate.getFullYear();
             correctedMonth = finalDate.getMonth() + 1;
             correctedDay = finalDate.getDate();
         } else {
             finalDate = chronoDate;
             // Use chrono's components if not overridden by boundary correction
             correctedYear = correctedYear ?? finalDate.getFullYear();
             correctedMonth = correctedMonth ?? finalDate.getMonth() + 1;
             correctedDay = correctedDay ?? finalDate.getDate();
         }
    }


    // --- 3. Time Component Handling ---
    // Use ?? undefined to handle potential null returns
    timeIsCertain = components.isCertain('hour');
    if (timeIsCertain) {
        correctedHour = components.get('hour') ?? undefined;
        // Only set minute/second if hour is certain AND they are provided/certain
        if (correctedHour !== undefined) {
             correctedMinute = components.get('minute') ?? 0; // Default minute/second to 0 if hour is certain but they aren't
             correctedSecond = components.get('second') ?? 0;
        } else {
            // If hour became undefined somehow, reset others
             timeIsCertain = false;
             correctedMinute = undefined;
             correctedSecond = undefined;
        }

        // Apply time to the finalDate if it exists
        if (finalDate) {
            finalDate = set(finalDate, {
                hours: correctedHour,
                minutes: correctedMinute,
                seconds: correctedSecond,
                milliseconds: 0 // Ensure ms is 0 for consistency
            });
        }

    } else {
        correctedHour = undefined;
        correctedMinute = undefined;
        correctedSecond = undefined;
        // Remove time components from finalDate if it exists
        if (finalDate) {
             finalDate = startOfDay(finalDate);
        }
    }

    // --- 4. Explicit Anchor Prioritization ---
    // If chrono was certain about year/month from the text, ensure they override relative calculations
    // Use ?? undefined
    const chronoCertainYear = components.get('year') ?? undefined;
    const chronoCertainMonth = components.get('month') ?? undefined;

    if (components.isCertain('year') && chronoCertainYear !== correctedYear) {
         console.log(`Prioritizing explicit year ${chronoCertainYear} for '${dateString}'`);
         correctedYear = chronoCertainYear;
         // If year changes, day might become invalid if month is Feb etc. Recalculate finalDate if possible.
         if(correctedMonth && correctedDay && finalDate) {
             try {
                 finalDate = set(finalDate, { year: correctedYear });
                 if (!isValid(finalDate)) finalDate = null; // Invalidate if date is wrong (e.g. Feb 30)
             } catch { finalDate = null; }
         } else { finalDate = null; } // Cannot determine full date anymore
    }
     if (components.isCertain('month') && chronoCertainMonth !== correctedMonth) {
         console.log(`Prioritizing explicit month ${chronoCertainMonth} for '${dateString}'`);
         correctedMonth = chronoCertainMonth;
         // Recalculate finalDate if possible
         if(correctedYear && correctedDay && correctedMonth && finalDate) {
             try {
                // date-fns month is 0-indexed
                finalDate = set(finalDate, { month: correctedMonth - 1 });
                if (!isValid(finalDate)) finalDate = null;
             } catch { finalDate = null; }
         } else { finalDate = null; }
    }
    // Re-check date certainty after anchor prioritization potentially changed things
    dateIsCertain = correctedYear !== undefined && correctedMonth !== undefined && correctedDay !== undefined && finalDate !== null && isValid(finalDate);


    // --- 5. Normalize Output String ---
    let normalized: string | null = null;
    if (dateIsCertain && finalDate) {
        if (timeIsCertain) {
            normalized = formatISO(finalDate); // Full ISO string with time
        } else {
            normalized = format(finalDate, 'yyyy-MM-dd'); // Date only
        }
    } else if (correctedYear !== undefined && correctedMonth !== undefined) {
        // Allow YYYY-MM if day is uncertain but month/year known (e.g., "last month")
        // normalized = format(new Date(correctedYear, correctedMonth - 1), 'yyyy-MM'); // Might be useful later?
        normalized = null; // For now, require day certainty for a normalized string
    } else if (correctedYear !== undefined) {
         // Allow YYYY if only year known
         // normalized = format(new Date(correctedYear, 0), 'yyyy');
         normalized = null;
    }


    // --- 6. Construct Final Object (Simplified Output) ---
    const output: EnhancedNormalizedDate = {
        original: dateString,
        normalized: normalized,
        note: results[0]?.text !== dateString ? `Parsed section: "${results[0]?.text}"` : undefined,
        year: correctedYear,
        month: correctedMonth,
        day: correctedDay,
        day_of_week: finalDate ? (finalDate.getDay()) : (components.get('weekday') ?? undefined), // Use calculated day of week if possible, handle null
        period: components.get('meridiem') === 0 ? 'AM' : components.get('meridiem') === 1 ? 'PM' : undefined, // Map meridiem if available
        // Only include time if it was certain
        ...(timeIsCertain && correctedHour !== undefined && {
            time_hour: correctedHour,
            time_minute: correctedMinute,
            time_second: correctedSecond,
        })
    };

    // Add a note if parsing was partial or uncertain
    if (!dateIsCertain && !timeIsCertain && !output.note) {
         output.note = "Could not fully resolve date/time components.";
    } else if (!dateIsCertain && timeIsCertain && !output.note) {
         output.note = "Could not fully resolve date components, but time was specified.";
    } else if (dateIsCertain && !timeIsCertain && !output.note && components.isCertain('hour')) {
        // This case happens if time was found but explicitly removed (e.g., "end of day")
        output.note = "Date resolved, time components ignored due to phrasing.";
     }


    console.log(`Parsed '${dateString}' ->`, JSON.stringify(output));
    return output;
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

// NEW rerankResults function (Task 5)
/**
 * Re-ranks retrieved context objects based on initial score and metadata overlap.
 */
async function rerankResults(
    candidates: ContextObject[],
    queryMetadata: ProcessedEntities,
    query_source: Extract<SuccessResponse['query_source'], 'vector_store' | 'postgres_fallback_text'>
): Promise<ContextObject[]> {
    if (!candidates || candidates.length === 0) {
        return [];
    }

    console.log(`Re-ranking ${candidates.length} candidates from source: ${query_source}`);

    // Pre-calculate date range once if needed for FTS date boost
    let queryDateRange: { startDate: string; endDate: string } | null = null;
    if (query_source === 'postgres_fallback_text') {
        queryDateRange = deriveDateRange(queryMetadata.dates);
        if (queryDateRange) {
            console.log(`Re-ranking: Derived query date range for FTS boost: ${queryDateRange.startDate} to ${queryDateRange.endDate}`);
        } else {
             console.log("Re-ranking: No specific past date range derived from query for FTS boost.");
        }
    }

    const scoredCandidates: ScoredContextObject[] = candidates.map(candidate => {
        // a. Map to Scored Objects & b. Calculate initial_score
        let initial_score = 0;
        if (query_source === 'vector_store') {
            // Use similarity score from vector search (already mapped in ContextObject)
            initial_score = candidate.similarity || 0;
            // Ensure similarity is within 0-1 range (clamp if necessary, though unlikely)
            initial_score = Math.max(0, Math.min(1, initial_score));
        } else { // postgres_fallback_text
            // Use rank score from FTS (already mapped in ContextObject)
            initial_score = candidate.rank || 0;
             // Assume rank is already normalized (0-1). If not, normalization needed here.
             initial_score = Math.max(0, Math.min(1, initial_score)); // Clamp just in case
        }

        // c. Calculate metadata_boost_score
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

        // NEW: Apply Date Range Boost (FTS Only)
        if (query_source === 'postgres_fallback_text' && queryDateRange) {
            try {
                const candidateTimestamp = parseISO(candidate.timestamp);
                const rangeStart = parseISO(queryDateRange.startDate);
                const rangeEnd = parseISO(queryDateRange.endDate);

                if (isValid(candidateTimestamp) && isValid(rangeStart) && isValid(rangeEnd)) {
                    if (candidateTimestamp >= rangeStart && candidateTimestamp <= rangeEnd) {
                        console.log(`Applying +0.10 date boost to FTS result (timestamp: ${candidate.timestamp})`);
                        metadata_boost_score += 0.10;
                    }
                }
            } catch (e) {
                console.warn(`Error comparing dates for FTS boost for timestamp ${candidate.timestamp}:`, e);
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

        // 1. Pre-process extracted entities (normalize dates)
        const referenceDateForNormalization = new Date();
        console.log(`Parsing dates with reference: ${referenceDateForNormalization.toISOString()}`);

        // FIX: Refactor processedMetadata initialization and date parsing assignment
        const initialEntities = payload.extracted_entities;
        // Initialize with other properties, dates will be added after parsing
        let processedMetadata: ProcessedEntities = {
            people: initialEntities.people,
            locations: initialEntities.locations,
            topics: initialEntities.topics,
            type: initialEntities.type,
            sentiment: initialEntities.sentiment,
            priority: initialEntities.priority,
            dates: undefined
        };

        // Parse dates from the *original* payload's dates array
        if (initialEntities.dates && Array.isArray(initialEntities.dates)) {
            const parsedDates: EnhancedNormalizedDate[] = initialEntities.dates
                .map(dateInput => {
                    // SIMPLIFIED TYPE CHECKING:
                    // 1. Handle string input directly
                    if (typeof dateInput === 'string') {
                        return parseDateStringToEnhanced(dateInput, referenceDateForNormalization);
                    }
                    // 2. Handle object input if it has a valid 'original' string property
                    else if (typeof dateInput === 'object' && dateInput !== null && typeof dateInput.original === 'string') {
                        console.warn(`Re-parsing object with 'original' property: ${JSON.stringify(dateInput)}`);
                        return parseDateStringToEnhanced(dateInput.original, referenceDateForNormalization);
                    }
                    // 3. Handle any other format as unexpected/invalid
                    else {
                        console.warn(`Unexpected date format in extracted_entities: ${JSON.stringify(dateInput)}`);
                        return null; // Invalid input format
                    }
                })
                // Use type guard filter to ensure the result is EnhancedNormalizedDate[]
                .filter((d): d is EnhancedNormalizedDate => d !== null);

            processedMetadata.dates = parsedDates; // Assign the correctly typed array
        } else {
            processedMetadata.dates = []; // Ensure it's an empty array if no dates were input
        }

        console.log("Processed Metadata (Dates Enhanced):", JSON.stringify(processedMetadata));


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
            fileId = fileData.id;
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

            if (!queryText) {
                 throw new Error("query_text is required for 'query' or 'combined' mode.");
            }

            // a. Generate embedding for the query text
            console.log("Generating embedding for query text...");
            const queryEmbeddingResponse = await openai.embeddings.create({
                model: EMBEDDING_MODEL,
                input: queryText,
                dimensions: EMBEDDING_DIMENSIONS,
            });
            const queryEmbedding = queryEmbeddingResponse?.data[0]?.embedding;

            if (!queryEmbedding) {
                throw new Error("Failed to generate query embedding.");
            }

            // b. Vector Search Call Update
            console.log("Attempt 1: Searching via vector search...");

            // UPDATE RPC Call parameters:
            const { data: searchResults, error: searchError } = await supabase.rpc(
                'search_memory_chunks',
                { // Use named parameters matching the *new* SQL function definition
                    query_embedding: queryEmbedding,
                    match_threshold: VECTOR_MATCH_THRESHOLD,
                    match_count: VECTOR_MATCH_COUNT,
                    filter_topics: queryMetadata.topics || null,
                    filter_people: queryMetadata.people || null,
                    filter_locations: queryMetadata.locations || null,
                    filter_type: queryMetadata.type || null,
                    filter_sentiment: queryMetadata.sentiment || null,
                }
            );
            const typedSearchResults = searchResults as SearchResultItem[] | null;

            let vectorSearchFailed = false;
            if (searchError) {
                console.error("Error during vector search RPC call:", searchError);
                query_source = 'error';
                message_for_gpt = `Error during vector search: ${searchError.message}. Trying fallback.`;
                vectorSearchFailed = true;
            } else if (typedSearchResults && typedSearchResults.length > 0) {
                console.log(`Found ${typedSearchResults.length} chunks via vector search.`);
                query_source = 'vector_store';
                // Map results - Ensure dates are handled as EnhancedNormalizedDate[]
                retrieved_context = typedSearchResults.map((result: SearchResultItem) => ({
                    file_id: result.file_id,
                    chunk: result.content_chunk,
                    timestamp: result.metadata?.created_at ?? new Date(0).toISOString(),
                    chunk_index: result.chunk_index,
                    similarity: result.similarity,
                    entities_in_chunk: typeof result.metadata === 'object' && result.metadata !== null
                        ? { // Reconstruct entities
                            people: result.metadata.people,
                            dates: (result.metadata.dates as EnhancedNormalizedDate[]) || [],
                            locations: result.metadata.locations,
                            topics: result.metadata.topics,
                            type: result.metadata.type,
                            sentiment: result.metadata.sentiment,
                            priority: result.metadata.priority,
                          }
                        : {},
                }));
            } else {
                console.log("Vector search yielded no results.");
            }


            // c. Fallback Logic Update
            if (retrieved_context.length === 0) {

                // Attempt Text Search Fallback (Now the primary fallback)
                if (retrieved_context.length === 0) {
                    console.log("Attempt 2: Fallback - Full-Text Search on 'files' table using query entities...");

                    // 1. Gather all string entities from the query metadata (EXCLUDING language)
                    const entityValues: string[] = [];
                    // Include original date strings in FTS query
                    (queryMetadata.dates || []).forEach(d => entityValues.push(d.original));
                    (queryMetadata.people || []).forEach(p => entityValues.push(p));
                    (queryMetadata.locations || []).forEach(l => entityValues.push(l));
                    (queryMetadata.topics || []).forEach(t => entityValues.push(t));
                    if (queryMetadata.type) entityValues.push(queryMetadata.type);
                    if (queryMetadata.sentiment) entityValues.push(queryMetadata.sentiment);
                    // DO NOT include queryMetadata.language

                    // Remove duplicates and empty strings
                    const uniqueEntities = [...new Set(entityValues)].filter(e => e && e.trim() !== '');

                    if (uniqueEntities.length > 0) {
                        // 2. Construct the FTS query string
                        const ftsQueryString = uniqueEntities
                            .map(term => term.replace(/['&|!():*]/g, '')) // Basic escaping
                            .filter(term => term.trim() !== '')
                            .join(' | ');

                        console.log(`Fallback FTS: Searching for entities: ${ftsQueryString}`);

                        // 3. Build the Supabase query with FTS
                        let ftsQueryBuilder = supabase
                            .from('files')
                            .select('id, transcript_text, created_at, file_metadata, rank:ts_rank_cd(transcript_tsv, to_tsquery(\'english\', $1))')
                            .textSearch('transcript_tsv', ftsQueryString, {
                                config: 'english',
                                type: 'websearch'
                            })
                            .order('rank', { ascending: false })
                            .limit(FALLBACK_MATCH_COUNT);

                        // --- START: Integrate Conditional Date Filtering (Task 2b) ---
                        /*
                        const dateRange = deriveDateRange(queryMetadata.dates); // Pass the processed dates
                        if (dateRange) {
                             console.log(`Applying FTS date range filter: ${dateRange.startDate} to ${dateRange.endDate}`);
                             ftsQueryBuilder = ftsQueryBuilder.gte('created_at', dateRange.startDate);
                             ftsQueryBuilder = ftsQueryBuilder.lte('created_at', dateRange.endDate);
                        }
                         else {
                            console.log("No date range filter applied to FTS.");
                        }
                        */
                        // --- END: Integrate Conditional Date Filtering ---

                        // 4. Execute the FTS query
                        console.log("Executing Fallback FTS Query...");
                        const { data: ftsResults, error: ftsError } = await ftsQueryBuilder;
                        const typedTextResults = ftsResults as (FallbackResultItem & { rank?: number })[] | null;

                        if (ftsError) {
                            console.error("Error during fallback FTS search:", ftsError);
                            // Simpler error message handling now
                            if (!vectorSearchFailed) message_for_gpt = `Vector search found nothing. Fallback text search failed: ${ftsError.message}`;
                            else message_for_gpt += ` Fallback text search also failed: ${ftsError.message}`;
                            if (query_source !== 'error') query_source = 'error';
                        } else if (typedTextResults && typedTextResults.length > 0) {
                            console.log(`Found ${typedTextResults.length} files via fallback FTS search.`);
                            query_source = 'postgres_fallback_text'; // Set correct source

                            if (vectorSearchFailed) {
                                message_for_gpt += ` Found ${typedTextResults.length} potential match(es) via text fallback.`;
                            } else {
                                message_for_gpt = `Found ${typedTextResults.length} potential match(es) via text search.`;
                            }

                            // Map results - Ensure dates handled as EnhancedNormalizedDate[]
                            retrieved_context = typedTextResults.map((file) => ({
                                file_id: file.id,
                                chunk: file.transcript_text.substring(0, 3000) + (file.transcript_text.length > 3000 ? '...' : ''),
                                rank: file.rank,
                                timestamp: file.created_at ? new Date(file.created_at).toISOString() : new Date(0).toISOString(),
                                chunk_index: undefined,
                                entities_in_chunk: typeof file.file_metadata === 'object' && file.file_metadata !== null
                                    ? { /* Reconstruction logic */
                                        people: file.file_metadata.people,
                                        dates: (file.file_metadata.dates as EnhancedNormalizedDate[]) || [],
                                        locations: file.file_metadata.locations,
                                        topics: file.file_metadata.topics,
                                        type: file.file_metadata.type,
                                        sentiment: file.file_metadata.sentiment,
                                        priority: file.file_metadata.priority,
                                      }
                                    : {},
                            }));
                        } else {
                            console.log("Fallback FTS search also found no results.");
                            if (query_source !== 'error') {
                                query_source = 'none';
                                message_for_gpt = "I couldn't find any relevant information using vector or text search."; // Updated message
                            } else {
                                message_for_gpt += " Fallback text search also found nothing.";
                            }
                        }
                    } else {
                        console.log("No valid non-language entities found in the query to perform FTS fallback, skipping.");
                        if (query_source !== 'error') {
                            query_source = 'none';
                            message_for_gpt = "I couldn't find any relevant information based on the query filters, and no specific entities were provided for text search.";
                        } else {
                            message_for_gpt += " No specific non-language entities provided for text fallback.";
                        }
                    }
                } // End Text Search Fallback attempt

            } // End of Fallback Logic block

            // --- START: Integrate Re-ranking Call (Task 6) ---
            if (retrieved_context.length > 0 && (query_source === 'vector_store' || query_source === 'postgres_fallback_text')) {
                console.log(`Calling rerankResults for ${retrieved_context.length} candidates from ${query_source}...`);
                retrieved_context = await rerankResults(retrieved_context, queryMetadata, query_source);
                // query_source remains unchanged, reflecting the initial retrieval method
            } else {
                 console.log("Skipping re-ranking due to no initial results or non-rankable source.");
            }
            // --- END: Integrate Re-ranking Call ---

        } // End of 'query'/'combined' block

        // Final response construction
        console.log(`DEBUG: Final retrieved_context count after potential re-ranking: ${retrieved_context.length}`);

        const successResponse: SuccessResponse = {
            retrieved_context: retrieved_context, // Use the potentially re-ranked context
            storage_status: storage_status,
            query_source: retrieved_context.length > 0 ? query_source : (query_source === 'error' ? 'error' : 'none'), // Refine source logic
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
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: errorMessage } as ErrorResponse),
        };
    }
};

export { handler }; 