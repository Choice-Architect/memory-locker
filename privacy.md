# Privacy Policy for Memory Locker (Testing Version)

## Overview
Memory Locker is currently a testing version of a personal memory assistant, intended for demonstration and testing purposes only. This privacy policy outlines how we handle information during this testing phase.

## Important Notice
- This application is currently in testing phase
- Access is limited to users with direct link sharing
- The database is designed for single-user testing scenarios
- Not intended for production use or sensitive information storage

## Data Collection and Storage
### What We Collect
- Text inputs ("memories") provided by users
- Metadata extracted from these inputs including:
  - Names of people
  - Organizations
  - Locations
  - Dates and times
  - Topics
  - Context information
  - Sentiment analysis
  - Priority levels

### How We Use Data
- Store and process text inputs for memory retrieval
- Generate embeddings for semantic search
- Create metadata tags for enhanced searchability
- Maintain connections between related information

### Storage and Security
- Data is stored in a Supabase database
- Single-user database configuration
- Basic security measures are in place, but as this is a testing version:
  - Do not store sensitive personal information
  - Do not store confidential business data
  - Do not store regulated data (medical, financial, etc.)

## Data Access and Control
- Access is limited to users with the direct application link
- Data is not shared with third parties
- No user authentication system is currently implemented
- All data in the testing database may be periodically cleared

## Technical Implementation
- Frontend: ChatGPT Custom GPT Interface
- Middleware: Netlify Functions
- Backend: Supabase (PostgreSQL + pgvector)
- Vector embeddings via OpenAI API

## Limitations and Disclaimers
1. This is a testing version only
2. No guarantees of data persistence
3. Limited security implementations
4. Not GDPR, CCPA, or HIPAA compliant
5. Not suitable for production use

## Contact Information
For questions about this privacy policy or the Memory Locker testing application, please contact the development team through the GitHub repository.

## Changes to This Policy
We may update this privacy policy as the testing phase progresses. Users will be notified of any significant changes through the GitHub repository.

Last Updated: [Current Date] 
