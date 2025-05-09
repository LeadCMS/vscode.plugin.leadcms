import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import { ContentIndex, IndexEntry, FileStatus, FileType, ChangeReport } from '../models/index';
import { ContentDetailsDto } from '../models/content';
import { ConfigService } from './config-service';
import { Logger } from '../utils/logger';

/**
 * Service for managing the content index, which tracks the state of content
 * and media files in relation to the CMS
 */
export class IndexService {
    private workspacePath: string | undefined;
    private indexFilePath: string | undefined;
    private index: ContentIndex | undefined;
    private configService: ConfigService;
    private indexFileWatcher: vscode.FileSystemWatcher | undefined;
    private isInternalSave: boolean = false; // Flag to track our own writes
    
    constructor(configService: ConfigService) {
        this.configService = configService;
        this.initialize();
    }

    private initialize(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            this.workspacePath = workspaceFolders[0].uri.fsPath;
            this.indexFilePath = path.join(this.workspacePath, '.leadcms', 'content-index.json');
            
            // Set up file watcher for the index file
            this.setupIndexFileWatcher();
        }
    }

    private setupIndexFileWatcher(): void {
        if (!this.indexFilePath) {
            return;
        }
        
        try {
            // Create a file system watcher for the index file
            const indexFilePattern = new vscode.RelativePattern(
                path.dirname(this.indexFilePath),
                path.basename(this.indexFilePath)
            );
            
            this.indexFileWatcher = vscode.workspace.createFileSystemWatcher(indexFilePattern);
            
            // Watch for changes to the index file
            this.indexFileWatcher.onDidChange(async (uri) => {
                if (this.isInternalSave) {
                    // This change was caused by our own saveIndex call
                    this.isInternalSave = false;
                    return;
                }
                
                Logger.info('Index file changed externally, reloading...');
                await this.reloadIndex();
            });
            
            // Watch for creation of the index file (in case it was deleted and recreated)
            this.indexFileWatcher.onDidCreate(async (uri) => {
                if (!this.isInternalSave) {
                    Logger.info('Index file created externally, reloading...');
                    await this.reloadIndex();
                }
            });
            
            Logger.info('Index file watcher set up successfully');
        } catch (error) {
            Logger.error('Failed to set up index file watcher:', error);
        }
    }

    private async reloadIndex(): Promise<void> {
        if (!this.indexFilePath || !await fs.pathExists(this.indexFilePath)) {
            return;
        }
        
        try {
            const indexData = await fs.readFile(this.indexFilePath, 'utf8');
            this.index = JSON.parse(indexData) as ContentIndex;
            Logger.info(`Reloaded index from file with ${Object.keys(this.index.entries).length} entries`);
        } catch (error) {
            Logger.error('Failed to reload index from file:', error);
        }
    }

    private ensureWorkspaceExists(): void {
        this.configService.ensureWorkspaceExists();
        if (!this.workspacePath) {
            // Re-initialize to pick up any workspace that might have been opened
            this.initialize();
            if (!this.workspacePath) {
                throw new Error('No workspace folder found. Please open a folder first.');
            }
        }
    }

    /**
     * Convert an absolute path to a path relative to the workspace
     */
    public toRelativePath(absolutePath: string): string {
        if (!this.workspacePath) {
            throw new Error('No workspace path available');
        }
        
        return path.relative(this.workspacePath, absolutePath);
    }
    
    /**
     * Convert a relative path to an absolute path
     */
    public toAbsolutePath(relativePath: string): string {
        if (!this.workspacePath) {
            throw new Error('No workspace path available');
        }
        
        return path.join(this.workspacePath, relativePath);
    }

    /**
     * Load the index from disk or create a new one if it doesn't exist
     */
    public async loadIndex(): Promise<ContentIndex> {
        this.ensureWorkspaceExists();
        
        try {
            if (await fs.pathExists(this.indexFilePath!)) {
                const indexData = await fs.readFile(this.indexFilePath!, 'utf8');
                this.index = JSON.parse(indexData) as ContentIndex;
                Logger.info(`Content index loaded with ${Object.keys(this.index.entries).length} entries`);
                return this.index;
            } else {
                // Initialize new index
                this.index = {
                    version: 1,
                    lastFullSyncAt: new Date().toISOString(),
                    entries: {}
                };
                
                await this.saveIndex();
                Logger.info('New content index created');
                return this.index;
            }
        } catch (error) {
            Logger.error('Failed to load content index:', error);
            throw new Error('Failed to load content index');
        }
    }

    /**
     * Save the current index to disk
     */
    private async saveIndex(): Promise<void> {
        this.ensureWorkspaceExists();
        
        if (!this.index) {
            throw new Error('Index not loaded');
        }
        
        try {
            // Set flag to ignore our own file changes
            this.isInternalSave = true;
            
            // Ensure directory exists
            await fs.ensureDir(path.dirname(this.indexFilePath!));
            
            // Create a sorted version of the index to maintain consistent order in the saved file
            const sortedIndex = {
                ...this.index,
                entries: this.getSortedEntries(this.index.entries)
            };
            
            // Save index file with sorted entries
            await fs.writeFile(
                this.indexFilePath!,
                JSON.stringify(sortedIndex, null, 2),
                'utf8'
            );
            
            Logger.info('Content index saved successfully');
        } catch (error) {
            this.isInternalSave = false; // Reset flag in case of error
            Logger.error('Failed to save content index:', error);
            throw new Error('Failed to save content index');
        }
    }

    /**
     * Get index entries in a consistent, sorted order
     * This ensures the index file doesn't change order unnecessarily when only doing operations
     * like file rename, addition, or removal
     */
    private getSortedEntries(entries: Record<string, IndexEntry>): Record<string, IndexEntry> {
        // Create a sorted object with the same entries
        const sortedEntries: Record<string, IndexEntry> = {};
        
        // Sort keys alphabetically for consistent order
        const sortedKeys = Object.keys(entries).sort();
        
        // Add entries in sorted order
        for (const key of sortedKeys) {
            sortedEntries[key] = entries[key];
        }
        
        return sortedEntries;
    }

    /**
     * Calculate hash for a file to detect changes - with improved error handling
     */
    public async calculateFileHash(filePath: string): Promise<string> {
        try {
            const fileContent = await fs.readFile(filePath);
            const hash = crypto
                .createHash('md5')
                .update(fileContent)
                .digest('hex');
                
            return hash;
        } catch (error) {
            Logger.error(`Failed to calculate hash for file ${filePath}:`, error);
            throw new Error(`Failed to calculate hash for file ${filePath}`);
        }
    }

    /**
     * Add or update a content entry in the index during sync operations
     */
    public async addOrUpdateContentEntry(
        content: ContentDetailsDto, 
        mdxPath: string, 
        metadataPath: string
    ): Promise<void> {
        this.ensureWorkspaceExists();
        
        if (!this.index) {
            await this.loadIndex();
        }
        
        try {
            // Calculate file hashes
            const mdxHash = await this.calculateFileHash(mdxPath);
            const metadataHash = await this.calculateFileHash(metadataPath);
            
            const now = new Date().toISOString();
            
            // Convert to relative paths for storage
            const contentRelPath = this.toRelativePath(mdxPath);
            const metadataRelPath = this.toRelativePath(metadataPath);
            
            // Check existing content MDX entry
            const existingMdxEntry = this.index!.entries[contentRelPath];
            
            // Add content MDX entry with bidirectional relationship
            this.index!.entries[contentRelPath] = {
                id: content.id,
                fileType: FileType.CONTENT,
                contentType: content.type,
                localPath: contentRelPath,
                hash: mdxHash,
                lastSyncedAt: existingMdxEntry && existingMdxEntry.hash === mdxHash 
                    ? existingMdxEntry.lastSyncedAt || now  // Keep existing timestamp if hash unchanged
                    : now,                                   // Update timestamp if hash changed or new entry
                lastModifiedRemote: content.updatedAt,
                status: FileStatus.SYNCED,
                relatedEntryIds: [metadataRelPath]
            };
            
            // Check existing metadata JSON entry
            const existingMetaEntry = this.index!.entries[metadataRelPath];
            
            // Add metadata JSON entry with bidirectional relationship
            this.index!.entries[metadataRelPath] = {
                id: content.id,
                fileType: FileType.METADATA,
                contentType: content.type,
                localPath: metadataRelPath,
                hash: metadataHash,
                lastSyncedAt: existingMetaEntry && existingMetaEntry.hash === metadataHash
                    ? existingMetaEntry.lastSyncedAt || now  // Keep existing timestamp if hash unchanged
                    : now,                                    // Update timestamp if hash changed or new entry
                lastModifiedRemote: content.updatedAt,
                status: FileStatus.SYNCED,
                relatedEntryIds: [contentRelPath]
            };
            
            await this.saveIndex();
        } catch (error) {
            Logger.error('Failed to add content to index:', error);
            throw new Error('Failed to add content to index');
        }
    }

    /**
     * Add a media file to the index
     */
    public async addMediaEntry(
        mediaId: string, 
        remoteUrl: string, 
        localPath: string
    ): Promise<void> {
        this.ensureWorkspaceExists();
        
        if (!this.index) {
            await this.loadIndex();
        }
        
        try {
            // Calculate file hash
            const mediaHash = await this.calculateFileHash(localPath);
            
            const now = new Date().toISOString();
            
            // Convert to relative path if an absolute path was provided
            let relPath = localPath;
            if (path.isAbsolute(localPath)) {
                relPath = this.toRelativePath(localPath);
            }
            
            // Check if media already exists with same hash
            const existingEntry = this.index!.entries[relPath];
            
            // Add media entry
            this.index!.entries[relPath] = {
                id: mediaId || remoteUrl, // Use URL as ID if no proper ID available
                fileType: FileType.MEDIA,
                localPath: relPath,
                hash: mediaHash,
                lastSyncedAt: existingEntry && existingEntry.hash === mediaHash
                    ? existingEntry.lastSyncedAt || now  // Keep existing timestamp if hash unchanged
                    : now,                               // Update timestamp if hash changed or new entry
                status: FileStatus.SYNCED,
                lastModifiedLocal: undefined // Clear local modification timestamp when synced
            };
            
            await this.saveIndex();
        } catch (error) {
            Logger.error(`Failed to add media to index: ${localPath}`, error);
            // Continue without throwing to avoid breaking the whole sync process
            // for a single media file
        }
    }

    /**
     * Mark entries as deleted when they no longer exist on the server
     */
    public async markDeletedEntries(remoteIds: string[]): Promise<void> {
        this.ensureWorkspaceExists();
        
        if (!this.index) {
            await this.loadIndex();
        }
        
        // Create a set of remote IDs for faster lookup
        const remoteIdSet = new Set(remoteIds);
        
        // Check all entries to find those missing from remote
        for (const [relPath, entry] of Object.entries(this.index!.entries)) {
            // Skip entries that are already marked as deleted or new
            if (entry.status === FileStatus.DELETED || entry.status === FileStatus.NEW) {
                continue;
            }
            
            // Skip media files for now (handled separately)
            if (entry.fileType === FileType.MEDIA) {
                continue;
            }
            
            // If this entry's ID is not in the remote IDs, mark it as deleted
            if (!remoteIdSet.has(entry.id)) {
                Logger.info(`Marking entry as deleted: ${relPath}`);
                entry.status = FileStatus.DELETED;
            }
        }
        
        await this.saveIndex();
    }

    /**
     * Check for local changes by comparing file hashes with indexed values
     */
    public async checkLocalChanges(): Promise<ChangeReport> {
        this.ensureWorkspaceExists();
        
        if (!this.index) {
            await this.loadIndex();
        }
        
        const changes: ChangeReport = {
            new: [],
            modified: [],
            deleted: [],
            renamed: [],
            conflict: []
        };

        // List of common media file extensions
        const mediaExtensions = [
            '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', 
            '.mp4', '.webm', '.mov', '.mp3', '.wav', '.pdf',
            '.ico', '.bmp', '.tiff', '.avif'
        ];
        
        // Track deleted files by their hash to detect renames
        const deletedFilesByHash: Map<string, { path: string, entry: IndexEntry }> = new Map();
        
        Logger.info(`Starting local changes check, ${Object.keys(this.index!.entries).length} entries in index`);
        
        // First pass: check existing files for modifications or deletions
        for (const [relPath, entry] of Object.entries(this.index!.entries)) {
            const fullPath = this.toAbsolutePath(relPath);
            
            // Check if file still exists
            if (!(await fs.pathExists(fullPath))) {
                // File has been deleted locally or possibly renamed
                if (entry.status !== FileStatus.DELETED) {
                    Logger.info(`File no longer exists at ${relPath}, marking as potentially renamed`);
                    deletedFilesByHash.set(entry.hash, { path: relPath, entry });
                    entry.status = FileStatus.DELETED;
                    changes.deleted.push(relPath);
                }
                continue;
            }
            
            // Skip if already marked as modified, new, or renamed
            if (entry.status !== FileStatus.SYNCED && entry.status !== FileStatus.CONFLICT) {
                continue;
            }
            
            // Calculate current hash
            let currentHash;
            try {
                currentHash = await this.calculateFileHash(fullPath);
            } catch (error) {
                Logger.error(`Failed to calculate hash for ${fullPath}:`, error);
                continue;
            }
            
            // Compare with stored hash
            if (currentHash !== entry.hash) {
                entry.status = FileStatus.MODIFIED;
                entry.lastModifiedLocal = new Date().toISOString();
                changes.modified.push(relPath);
            }
        }
        
        Logger.info(`Completed first pass: ${changes.deleted.length} deleted, ${changes.modified.length} modified`);
        
        // Scan for new files - enhanced approach to ensure we catch all files
        try {
            // Check content directory for new files
            await this.scanContentDirectory(changes, mediaExtensions);
            
            // Fix any missing bidirectional relationships
            await this.fixMissingRelationships();
            
            Logger.info(`Directory scan complete. Found ${changes.new.length} new files`);
        } catch (error) {
            Logger.error(`Error scanning for new files:`, error);
        }
        
        // Save updated index
        await this.saveIndex();
        
        return changes;
    }

    /**
     * Enhanced method to scan the entire content directory structure
     */
    private async scanContentDirectory(
        changes: ChangeReport,
        mediaExtensions: string[]
    ): Promise<void> {
        const contentDir = path.join(this.workspacePath!, 'content');
        if (!(await fs.pathExists(contentDir))) {
            return;
        }

        // Use our getAllFiles method to get a complete list of all files
        const allFiles = await this.getAllFiles(contentDir);
        Logger.info(`Found ${allFiles.length} total files in content directory`);
        
        // Collect all files first, then establish relationships
        const newFiles: { path: string, relPath: string, fileType: FileType, contentInfo: any }[] = [];
        
        // First pass: identify all new files
        for (const filePath of allFiles) {
            const relPath = this.toRelativePath(filePath);
            
            // Skip if already in index
            if (this.index!.entries[relPath]) {
                continue;
            }
            
            // Skip files outside the content directory
            if (!relPath.startsWith('content/')) {
                continue;
            }
            
            // Determine file type based on extension and path structure
            const fileExt = path.extname(filePath).toLowerCase();
            let fileType: FileType | null = null;
            
            if (fileExt === '.mdx') {
                fileType = FileType.CONTENT;
            } else if (fileExt === '.json' && path.basename(filePath) === 'index.json') {
                fileType = FileType.METADATA;
            } else if (mediaExtensions.includes(fileExt)) {
                fileType = FileType.MEDIA;
            }
            
            // Skip files we don't track
            if (fileType === null) {
                continue;
            }
            
            // Calculate hash
            let hash;
            try {
                hash = await this.calculateFileHash(filePath);
            } catch (error) {
                Logger.error(`Failed to calculate hash for new file ${filePath}:`, error);
                continue;
            }
            
            const now = new Date().toISOString();
            
            // Extract content info for better metadata
            const contentInfo = this.extractContentInfoFromPath(filePath);
            
            // Add to index as a new file
            this.index!.entries[relPath] = {
                id: `local:${relPath}`, // Temporary ID for local files
                fileType,
                localPath: relPath,
                hash,
                status: FileStatus.NEW,
                lastModifiedLocal: now,
                contentType: contentInfo.contentType
            };
            
            // Add to our list for relationship processing
            newFiles.push({
                path: filePath,
                relPath,
                fileType,
                contentInfo
            });
            
            changes.new.push(relPath);
            Logger.info(`Added new file to index: ${relPath} (${fileType})`);
        }
        
        // Second pass: establish relationships between files
        for (const newFile of newFiles) {
            if (newFile.fileType === FileType.CONTENT || newFile.fileType === FileType.METADATA) {
                const relatedPath = this.getRelatedFilePath(newFile.path);
                
                if (relatedPath && await fs.pathExists(relatedPath)) {
                    const relatedRelPath = this.toRelativePath(relatedPath);
                    
                    // Add bidirectional relationship
                    if (this.index!.entries[newFile.relPath]) {
                        // Set or update relatedEntryIds for current file
                        if (!this.index!.entries[newFile.relPath].relatedEntryIds) {
                            this.index!.entries[newFile.relPath].relatedEntryIds = [];
                        }
                        if (!this.index!.entries[newFile.relPath].relatedEntryIds!.includes(relatedRelPath)) {
                            this.index!.entries[newFile.relPath].relatedEntryIds!.push(relatedRelPath);
                        }
                    }
                    
                    // Also set relationship on related file if it exists in index
                    if (this.index!.entries[relatedRelPath]) {
                        if (!this.index!.entries[relatedRelPath].relatedEntryIds) {
                            this.index!.entries[relatedRelPath].relatedEntryIds = [];
                        }
                        if (!this.index!.entries[relatedRelPath].relatedEntryIds!.includes(newFile.relPath)) {
                            this.index!.entries[relatedRelPath].relatedEntryIds!.push(newFile.relPath);
                        }
                    }
                }
            }
        }
    }

    /**
     * Fix any missing bidirectional relationships in the index
     */
    private async fixMissingRelationships(): Promise<void> {
        if (!this.index) {
            return;
        }
        
        const entries = this.index.entries;
        let relationshipsFixed = 0;
        
        // Identify all content and metadata files
        const contentFiles: string[] = [];
        const metadataFiles: string[] = [];
        
        for (const [relPath, entry] of Object.entries(entries)) {
            if (entry.fileType === FileType.CONTENT) {
                contentFiles.push(relPath);
            } else if (entry.fileType === FileType.METADATA) {
                metadataFiles.push(relPath);
            }
        }
        
        // For each content file, ensure it has a relationship with its metadata file
        for (const contentPath of contentFiles) {
            const contentEntry = entries[contentPath];
            
            // Skip entries that already have relationships defined
            if (contentEntry.relatedEntryIds && contentEntry.relatedEntryIds.length > 0) {
                continue;
            }
            
            // Find the matching metadata file by converting the path
            const contentAbsPath = this.toAbsolutePath(contentPath);
            const metadataAbsPath = this.getRelatedFilePath(contentAbsPath);
            
            if (!metadataAbsPath) {
                continue;
            }
            
            const metadataPath = this.toRelativePath(metadataAbsPath);
            
            // If the metadata file exists in the index, establish the relationship
            if (entries[metadataPath]) {
                // Add relationship from content to metadata
                if (!contentEntry.relatedEntryIds) {
                    contentEntry.relatedEntryIds = [];
                }
                if (!contentEntry.relatedEntryIds.includes(metadataPath)) {
                    contentEntry.relatedEntryIds.push(metadataPath);
                    relationshipsFixed++;
                }
                
                // Add relationship from metadata to content if needed
                const metadataEntry = entries[metadataPath];
                if (!metadataEntry.relatedEntryIds) {
                    metadataEntry.relatedEntryIds = [];
                }
                if (!metadataEntry.relatedEntryIds.includes(contentPath)) {
                    metadataEntry.relatedEntryIds.push(contentPath);
                    relationshipsFixed++;
                }
            }
        }
        
        if (relationshipsFixed > 0) {
            Logger.info(`Fixed ${relationshipsFixed} missing bidirectional relationships`);
        }
    }

    /**
     * Get all files in a directory recursively - improved with better error handling
     */
    private async getAllFiles(dirPath: string): Promise<string[]> {
        try {
            if (!(await fs.pathExists(dirPath))) {
                return [];
            }
            
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            
            const files: string[] = [];
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                
                try {
                    if (entry.isDirectory()) {
                        // Skip hidden directories and node_modules
                        if (entry.name.startsWith('.') || 
                            entry.name === 'node_modules') {
                            continue;
                        }
                        
                        // Recursively get files in subdirectories
                        const subFiles = await this.getAllFiles(fullPath);
                        files.push(...subFiles);
                    } else {
                        // Add all files - we'll filter by type later
                        files.push(fullPath);
                    }
                } catch (error) {
                    Logger.error(`Error processing entry ${fullPath}:`, error);
                    // Continue with other entries
                    continue;
                }
            }
            
            return files;
        } catch (error) {
            Logger.error(`Error listing directory ${dirPath}:`, error);
            return [];
        }
    }

    /**
     * Update the index after a successful push operation
     */
    public async updateAfterPush(
        contentId: string, 
        mdxPath: string, 
        metadataPath: string,
        updatedAt: string
    ): Promise<void> {
        this.ensureWorkspaceExists();
        
        if (!this.index) {
            await this.loadIndex();
        }
        
        // Convert to relative paths
        const mdxRelPath = this.toRelativePath(mdxPath);
        const metaRelPath = this.toRelativePath(metadataPath);
        const now = new Date().toISOString();
        
        // Calculate new hashes
        const mdxHash = await this.calculateFileHash(mdxPath);
        const metaHash = await this.calculateFileHash(metadataPath);
        
        // Update MDX entry
        const mdxEntry = this.index!.entries[mdxRelPath];
        if (mdxEntry) {
            const hashChanged = mdxEntry.hash !== mdxHash;
            mdxEntry.id = contentId;
            mdxEntry.hash = mdxHash;
            if (hashChanged) {
                mdxEntry.lastSyncedAt = now; // Only update if hash changed
            }
            // Always update lastModifiedRemote with the server's timestamp
            mdxEntry.lastModifiedRemote = updatedAt;
            mdxEntry.status = FileStatus.SYNCED;
            mdxEntry.lastModifiedLocal = undefined; // Always clear local modification timestamp when synced
            
            // Clear rename history when status changes to SYNCED
            if (mdxEntry.originalPath || mdxEntry.originalState) {
                Logger.info(`Clearing rename history for synced file: ${mdxRelPath}`);
                mdxEntry.originalPath = undefined;
                mdxEntry.originalState = undefined;
            }
        } else {
            // Create new entry
            this.index!.entries[mdxRelPath] = {
                id: contentId,
                fileType: FileType.CONTENT,
                localPath: mdxRelPath,
                hash: mdxHash,
                lastSyncedAt: now, // New entry, set initial sync time
                lastModifiedRemote: updatedAt, // Set server timestamp
                status: FileStatus.SYNCED,
                relatedEntryIds: [metaRelPath]
            };
        }
        
        // Update metadata entry
        const metaEntry = this.index!.entries[metaRelPath];
        if (metaEntry) {
            const hashChanged = metaEntry.hash !== metaHash;
            metaEntry.id = contentId;
            metaEntry.hash = metaHash;
            if (hashChanged) {
                metaEntry.lastSyncedAt = now; // Only update if hash changed
            }
            // Always update lastModifiedRemote with the server's timestamp
            metaEntry.lastModifiedRemote = updatedAt;
            metaEntry.status = FileStatus.SYNCED;
            metaEntry.lastModifiedLocal = undefined; // Always clear local modification timestamp when synced
            
            // Clear rename history when status changes to SYNCED
            if (metaEntry.originalPath || metaEntry.originalState) {
                Logger.info(`Clearing rename history for synced file: ${metaRelPath}`);
                metaEntry.originalPath = undefined;
                metaEntry.originalState = undefined;
                metaEntry.lastModifiedLocal = undefined;
            }
        } else {
            // Create new entry
            this.index!.entries[metaRelPath] = {
                id: contentId,
                fileType: FileType.METADATA,
                localPath: metaRelPath,
                hash: metaHash,
                lastSyncedAt: now, // New entry, set initial sync time
                lastModifiedRemote: updatedAt, // Set server timestamp
                status: FileStatus.SYNCED,
                relatedEntryIds: [mdxRelPath]
            };
        }
        
        await this.saveIndex();
    }
    
    /**
     * Get a report of all pending changes
     */
    public async getPendingChanges(): Promise<ChangeReport> {
        this.ensureWorkspaceExists();
        
        if (!this.index) {
            await this.loadIndex();
        }
        
        const changes: ChangeReport = {
            new: [],
            modified: [],
            deleted: [],
            renamed: [],
            conflict: []
        };
        
        for (const [relPath, entry] of Object.entries(this.index!.entries)) {
            switch (entry.status) {
                case FileStatus.NEW:
                    changes.new.push(relPath);
                    break;
                case FileStatus.MODIFIED:
                    changes.modified.push(relPath);
                    break;
                case FileStatus.DELETED:
                    changes.deleted.push(relPath);
                    break;
                case FileStatus.RENAMED:
                    if (entry.originalPath) {
                        changes.renamed.push({
                            from: entry.originalPath,
                            to: relPath
                        });
                    }
                    break;
                case FileStatus.CONFLICT:
                    changes.conflict.push(relPath);
                    break;
            }
        }
        
        return changes;
    }
    
    /**
     * Update index after a complete sync operation
     */
    public async updateAfterFullSync(): Promise<void> {
        if (!this.index) {
            await this.loadIndex();
        }
        
        // Check if any entry has been synced since the last full sync
        let hasUpdatedEntries = false;
        const lastFullSync = new Date(this.index!.lastFullSyncAt || 0);
        
        for (const entry of Object.values(this.index!.entries)) {
            if (entry.lastSyncedAt) {
                const lastEntrySync = new Date(entry.lastSyncedAt);
                if (lastEntrySync > lastFullSync) {
                    hasUpdatedEntries = true;
                    break;
                }
            }
        }
        
        // Only update lastFullSyncAt if at least one entry was updated
        if (hasUpdatedEntries) {
            Logger.info('Updating lastFullSyncAt because entries were updated');
            this.index!.lastFullSyncAt = new Date().toISOString();
            await this.saveIndex();
        } else {
            Logger.info('Skipping lastFullSyncAt update as no entries were updated');
        }
    }

    /**
     * Update entry after a rename operation
     */
    public async updateAfterRename(oldPath: string, newPath: string): Promise<void> {
        this.ensureWorkspaceExists();
        
        if (!this.index) {
            await this.loadIndex();
        }
        
        // Get old and new relative paths
        const oldRelPath = path.relative(this.workspacePath!, oldPath);
        const newRelPath = path.relative(this.workspacePath!, newPath);
        
        // Check if the old path exists in our index
        const entry = this.index!.entries[oldRelPath];
        if (!entry) {
            Logger.warn(`Attempted to rename ${oldRelPath}, but it's not in the index`);
            return;
        }
        
        // Extract content info to compare content type and slug
        const oldContentInfo = this.extractContentInfoFromPath(oldPath);
        const newContentInfo = this.extractContentInfoFromPath(newPath);
        
        // Only consider it a "rename back to original" if the full path matches exactly,
        // not just if the content type and slug are the same
        const isRenameBackToOriginal = entry.originalPath === newRelPath || 
            (entry.originalState && entry.originalState.localPath === newRelPath);
        
        if (isRenameBackToOriginal) {
            Logger.info(`File renamed back to original path: ${newRelPath}`);
            
            // Restore original state if available
            if (entry.originalState) {
                // Create a new entry at the original path with original state
                this.index!.entries[newRelPath] = {
                    ...entry.originalState,
                    // Keep the current hash which might have changed
                    hash: entry.hash
                };
            } else {
                // If no original state is saved, just move the entry and restore status
                this.index!.entries[newRelPath] = {
                    ...entry,
                    localPath: newRelPath,
                    status: FileStatus.SYNCED, // Reset to synced since it's back to original
                    originalPath: undefined // Clear originalPath since it's no longer renamed
                };
            }
            
            // Update related entries to reference the new path
            this.updateRelatedReferencesAfterRename(oldRelPath, newRelPath);
            
            // Delete the old entry
            delete this.index!.entries[oldRelPath];
            
            await this.saveIndex();
            return;
        }
        
        // Normal rename handling
        // Store original state if this is the first rename
        let originalState = entry.originalState;
        if (!originalState && entry.status !== FileStatus.RENAMED) {
            originalState = { ...entry };
        }
        
        // Create a new entry for the renamed file
        this.index!.entries[newRelPath] = {
            ...entry,
            localPath: newRelPath,
            originalPath: entry.originalPath || oldRelPath, // Keep track of first original path
            originalState: originalState, // Store the original state
            status: FileStatus.RENAMED,
            lastModifiedLocal: new Date().toISOString()
        };
        
        // Update related entries to reference the new path
        this.updateRelatedReferencesAfterRename(oldRelPath, newRelPath);
        
        // Delete the old entry
        delete this.index!.entries[oldRelPath];
        
        await this.saveIndex();
    }

    /**
     * Updates relatedEntryIds in all related entries after a file rename
     * @param oldPath The original path before renaming
     * @param newPath The new path after renaming
     */
    private updateRelatedReferencesAfterRename(oldPath: string, newPath: string): void {
        if (!this.index) {
            throw new Error('Index not loaded');
        }

        const entries = this.index.entries;
        const oldRelPath = path.isAbsolute(oldPath) ? this.toRelativePath(oldPath) : oldPath;
        const newRelPath = path.isAbsolute(newPath) ? this.toRelativePath(newPath) : newPath;
        
        // Find all entries that have a reference to the old path
        for (const [entryPath, entry] of Object.entries(entries)) {
            if (entryPath === newRelPath) {
                continue; // Skip the renamed entry itself
            }
            
            if (entry.relatedEntryIds && entry.relatedEntryIds.includes(oldRelPath)) {
                // Replace the old path with the new path
                entry.relatedEntryIds = entry.relatedEntryIds.map(id => 
                    id === oldRelPath ? newRelPath : id
                );
                Logger.info(`Updated reference in ${entryPath} from ${oldRelPath} to ${newRelPath}`);
            }
        }
        
        // Ensure the renamed entry has correct references too
        const renamedEntry = entries[newRelPath];
        if (renamedEntry && renamedEntry.relatedEntryIds) {
            // Look for any paths in the renamed file's related entries that might also need updating
            for (let i = 0; i < renamedEntry.relatedEntryIds.length; i++) {
                const relatedPath: string = renamedEntry.relatedEntryIds[i];
                
                // If the related entry has old folder name but should have new folder name
                if (relatedPath.includes(path.dirname(oldRelPath)) && 
                    !path.dirname(oldRelPath).endsWith(path.dirname(newRelPath))) {
                    
                    // Calculate what the new path should be
                    const updatedPath = relatedPath.replace(
                        path.dirname(oldRelPath), 
                        path.dirname(newRelPath)
                    );
                    
                    // Fix the reference if the target file exists in the index
                    if (entries[updatedPath]) {
                        renamedEntry.relatedEntryIds[i] = updatedPath;
                        Logger.info(`Fixed incorrect reference in ${newRelPath} from ${relatedPath} to ${updatedPath}`);
                    }
                }
            }
        }
    }

    /**
     * Get content type and slug from path
     * Handle both old and new structure for compatibility during migration
     */
    private extractContentInfoFromPath(filePath: string): { contentType?: string, slug?: string } {
        const relativePath = this.toRelativePath(filePath);
        const pathParts = relativePath.split(path.sep);
        
        // New structure: content/{contentType}/{slug}/index.{ext}
        if (pathParts.length >= 4 && 
            pathParts[0] === 'content' && 
            pathParts[pathParts.length - 1].startsWith('index.')) {
            
            return {
                contentType: pathParts[1],
                slug: pathParts[2]
            };
        }
        
        // Old structure: content/{contentType}/{slug}.{ext}
        if (pathParts.length >= 3 && 
            pathParts[0] === 'content') {
            
            const filename = pathParts[pathParts.length - 1];
            const slug = filename.substring(0, filename.lastIndexOf('.'));
            
            return {
                contentType: pathParts[1],
                slug: slug
            };
        }
        
        // Media file in content folder: content/{contentType}/{slug}/{filename}
        if (pathParts.length >= 4 && 
            pathParts[0] === 'content' && 
            !pathParts[pathParts.length - 1].startsWith('index.')) {
            
            return {
                contentType: pathParts[1],
                slug: pathParts[2]
            };
        }
        
        return {};
    }

    /**
     * Get the path of the related file for a content file
     * For index.mdx returns path to index.json and vice versa
     */
    private getRelatedFilePath(filePath: string): string | null {
        if (filePath.endsWith('index.mdx')) {
            return filePath.replace('index.mdx', 'index.json');
        } else if (filePath.endsWith('index.json')) {
            return filePath.replace('index.json', 'index.mdx');
        }
        return null;
    }

    /**
     * Get an entry by its file path
     */
    public getEntryByPath(filePath: string): IndexEntry | undefined {
        if (!this.index) {
            throw new Error('Index not loaded');
        }
        
        // Convert to relative path if necessary
        const relPath = path.isAbsolute(filePath) ? this.toRelativePath(filePath) : filePath;
        
        return this.index.entries[relPath];
    }
    
    /**
     * Remove an entry from the index and save
     */
    public async removeEntry(filePath: string): Promise<void> {
        if (!this.index) {
            throw new Error('Index not loaded');
        }
        
        // Convert to relative path if necessary
        const relPath = path.isAbsolute(filePath) ? this.toRelativePath(filePath) : filePath;
        
        if (this.index.entries[relPath]) {
            delete this.index.entries[relPath];
            await this.saveIndex();
        }
    }

    /**
     * Find all index entries in a specific folder
     * @param folderPath The relative folder path to search in
     * @returns Array of index entries in the folder
     */
    public async findEntriesInFolder(folderPath: string): Promise<IndexEntry[]> {
        this.ensureWorkspaceExists();
        
        try {
            if (!this.index) {
                Logger.info('Loading index before searching for entries in folder');
                await this.loadIndex();
            }
            
            // Add an additional safety check to make TypeScript happy
            if (!this.index) {
                Logger.error('Failed to load index when searching for entries in folder');
                return [];
            }
            
            const normalizedFolderPath = folderPath.endsWith(path.sep) 
                ? folderPath
                : folderPath + path.sep;
            
            const result: IndexEntry[] = [];
            
            // Find all entries where the path starts with the folder path
            for (const [entryPath, entry] of Object.entries(this.index.entries)) {
                if (entryPath.startsWith(normalizedFolderPath) || entryPath === folderPath) {
                    result.push(entry);
                }
            }
            
            Logger.info(`Found ${result.length} index entries in folder: ${folderPath}`);
            return result;
        } catch (error) {
            Logger.error(`Error finding entries in folder ${folderPath}:`, error);
            return [];
        }
    }

    /**
     * Cleanup resources used by this service
     */
    public dispose(): void {
        if (this.indexFileWatcher) {
            this.indexFileWatcher.dispose();
            this.indexFileWatcher = undefined;
        }
    }
}