/**
 * Represents the status of a file in the workspace relative to the CMS
 */
export enum FileStatus {
    SYNCED = 'synced',       // File is in sync with CMS version
    MODIFIED = 'modified',   // File has been modified locally
    NEW = 'new',             // File is new locally, not yet in CMS
    DELETED = 'deleted',     // File exists in index but has been deleted locally
    RENAMED = 'renamed',     // File has been renamed locally
    CONFLICT = 'conflict'    // Both local and remote versions have changed
}

/**
 * Type of content being tracked
 */
export enum FileType {
    CONTENT = 'content',
    METADATA = 'metadata',
    MEDIA = 'media'
}

/**
 * Represents an entry in the content index
 */
export interface IndexEntry {
    // CMS identifiers
    id: string;                // Content ID in the CMS
    fileType: FileType;        // Type of file (content, metadata, media)
    contentType?: string;      // For content: 'blog', 'page', etc.

    // Local file information
    localPath: string;         // Path on local filesystem
    originalPath?: string;     // Original path if renamed
    originalState?: Omit<IndexEntry, 'originalState'>; // Original state before rename
    hash: string;              // Content hash for change detection
    
    // Sync metadata
    lastSyncedAt?: string;      // Timestamp of last sync with CMS
    lastModifiedLocal?: string;// Timestamp of last local modification
    lastModifiedRemote?: string;// Timestamp of last remote modification
    status: FileStatus;        // Current status
    
    // Relationships
    relatedEntryIds?: string[]; // For metadata: ID of related content file, vice versa
    mediaReferences?: string[]; // For content: list of media IDs referenced
}

/**
 * The main index structure for the entire workspace
 */
export interface ContentIndex {
    version: number;            // Schema version for future compatibility
    lastFullSyncAt: string;     // Timestamp of last full sync
    entries: Record<string, IndexEntry>; // Map of relative path -> entry
}

/**
 * Changed files grouped by their status
 */
export interface ChangeReport {
    new: string[];
    modified: string[];
    deleted: string[];
    renamed: Array<{from: string, to: string}>;
    conflict: string[];
}
