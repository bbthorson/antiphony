# Shared Directory

This directory contains code that is shared between different parts of the Vox Pop application.

## Structure

### `types/`
Contains the core data model definitions, split into Records and Views.

- **`records.ts`**: Raw Firestore data schemas.
  ```json
  // Record Example
  {
    "id": "123",
    "creatorId": "user_456",
    "audioUrl": "..."
  }
  ```
- **`views.ts`**: Hydrated API response schemas.
  ```json
  // View Example
  {
    "record": { ... },
    "author": {
      "id": "user_456",
      "handle": "@cooluser"
    }
  }
  ```

### `codecs.ts`
Strict validation schemas for API requests.

### `utils/`
Shared utility functions.
