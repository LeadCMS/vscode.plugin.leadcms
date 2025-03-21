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
    
    constructor(configService: ConfigService) {
        this.configService = configService;
        this.initialize();
    }

    private initialize(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            this.workspacePath = workspaceFolders[0].uri.fsPath;
            this.indexFilePath = path.join(this.workspacePath, '.onlinesales', 'content-index.json');
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
    private toRelativePath(absolutePath: string): string {
        if (!this.workspacePath) {
            throw new Error('No workspace path available');
        }
        
        return path.relative(this.workspacePath, absolutePath);
    }
    
    /**
     * Convert a relative path to an absolute path
     */
    private toAbsolutePath(relativePath: string): string {
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
            // Ensure directory exists
            await fs.ensureDir(path.dirname(this.indexFilePath!));
            
            // Save index file
            await fs.writeFile(
                this.indexFilePath!, 
                JSON.stringify(this.index, null, 2), 
                'utf8'
            );
            
            Logger.info('Content index saved successfully');
        } catch (error) {
            Logger.error('Failed to save content index:', error);
            throw new Error('Failed to save content index');
        }
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
            
            // Add content MDX entry
            this.index!.entries[contentRelPath] = {
                id: content.id,
                fileType: FileType.CONTENT,
                contentType: content.type,
                localPath: contentRelPath, // Store relative path instead of absolute
                hash: mdxHash,
                lastSyncedAt: now,
                lastModifiedRemote: content.updatedAt,
                status: FileStatus.SYNCED,
                relatedEntryIds: [metadataRelPath]
            };
            
            // Add metadata JSON entry
            this.index!.entries[metadataRelPath] = {
                id: content.id,
                fileType: FileType.METADATA,
                contentType: content.type,
                localPath: metadataRelPath, // Store relative path instead of absolute
                hash: metadataHash,
                lastSyncedAt: now,
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
            const relPath = this.toRelativePath(localPath);
            
            // Add media entry
            this.index!.entries[relPath] = {
                id: mediaId || remoteUrl, // Use URL as ID if no proper ID available
                fileType: FileType.MEDIA,
                localPath: relPath, // Store relative path instead of absolute
                hash: mediaHash,
                lastSyncedAt: now,
                status: FileStatus.SYNCED
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
        Logger.info(`Checking for renamed files, ${deletedFilesByHash.size} potential candidates`);
        
        // Special logging for debugging rename detection
        if (deletedFilesByHash.size > 0) {
            Logger.info('Potentially renamed files (by hash):');
            for (const [hash, { path: oldPath }] of deletedFilesByHash.entries()) {
                Logger.info(`  ${oldPath} (hash: ${hash.substring(0, 8)}...)`);
            }
        }
        
        // Look for new files and potential renames
        const scanDirectory = async (dir: string, contentType?: string): Promise<void> => {
            if (!(await fs.pathExists(dir))) {
                Logger.info(`Directory does not exist, skipping scan: ${dir}`);
                return;
            }
            
            const items = await fs.readdir(dir);
            
            for (const item of items) {
                const fullPath = path.join(dir, item);
                
                try {
                    const stats = await fs.stat(fullPath);
                    
                    if (stats.isDirectory()) {
                        // If this is under content dir, track the content type
                        const isContentSubdir = dir === path.join(this.workspacePath!, 'content');
                        await scanDirectory(fullPath, isContentSubdir ? item : contentType);
                    } else {
                        const relPath = this.toRelativePath(fullPath);
                        
                        // Skip if already in index and not marked as deleted
                        if (this.index!.entries[relPath] && 
                            this.index!.entries[relPath].status !== FileStatus.DELETED) {
                            continue;
                        }
                        
                        // Determine file type based on extension and path
                        let fileType: FileType | undefined;
                        if (item.endsWith('.mdx')) {
                            fileType = FileType.CONTENT;
                        } else if (item.endsWith('.json') && contentType) {
                            fileType = FileType.METADATA;
                        } else {
                            const ext = path.extname(item).toLowerCase();
                            if (dir.includes('media') || mediaExtensions.includes(ext)) {
                                fileType = FileType.MEDIA;
                                Logger.info(`Found media file: ${relPath} (extension: ${ext})`);
                            }
                        }
                        
                        // If not a tracked file type, skip
                        if (!fileType) {
                            continue;
                        }
                        
                        // Calculate hash
                        let hash;
                        try {
                            hash = await this.calculateFileHash(fullPath);
                            Logger.info(`Calculated hash for new file ${relPath}: ${hash.substring(0, 8)}...`);
                        } catch (error) {
                            Logger.error(`Failed to calculate hash for ${fullPath}:`, error);
                            continue;
                        }
                        
                        // Check if this matches a deleted file's hash (potential rename)
                        const deletedMatch = deletedFilesByHash.get(hash);
                        
                        if (deletedMatch) {
                            const { path: oldPath, entry: oldEntry } = deletedMatch;
                            
                            // This is a renamed file!
                            Logger.info(`MATCH FOUND! Renamed file detected: ${oldPath} -> ${relPath}`);
                            Logger.info(`  File type: ${fileType}, Content type: ${contentType || 'none'}`);
                            Logger.info(`  Hash: ${hash.substring(0, 8)}...`);
                            
                            // Remove from deleted list
                            changes.deleted = changes.deleted.filter(p => p !== oldPath);
                            
                            // Create a new entry for the renamed file
                            this.index!.entries[relPath] = {
                                ...oldEntry,
                                localPath: relPath,
                                originalPath: oldPath,
                                status: FileStatus.RENAMED,
                                lastModifiedLocal: new Date().toISOString()
                            };
                            
                            // Delete the old entry
                            delete this.index!.entries[oldPath];
                            
                            // Record the rename
                            changes.renamed.push({ from: oldPath, to: relPath });
                            
                            // Remove from the map to prevent further matches
                            deletedFilesByHash.delete(hash);
                            continue;
                        } else {
                            Logger.info(`No rename match found for ${relPath}`);
                        }
                        
                        // This is a new file
                        this.index!.entries[relPath] = {
                            id: `new-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                            fileType,
                            contentType,
                            localPath: relPath,
                            hash,
                            lastSyncedAt: new Date().toISOString(),
                            status: FileStatus.NEW
                        };
                        
                        changes.new.push(relPath);
                        Logger.info(`New file added to index: ${relPath}`);
                    }
                } catch (error) {
                    Logger.error(`Error processing file ${fullPath}:`, error);
                }
            }
        };
        
        // Recursively scan content and media directories
        Logger.info('Starting directory scan for new and renamed files');
        await scanDirectory(path.join(this.workspacePath!, 'content'));
        await scanDirectory(path.join(this.workspacePath!, 'media'));
        
        Logger.info(`Directory scan complete. Found ${changes.new.length} new files and ${changes.renamed.length} renamed files`);
        
        // Save updated index
        await this.saveIndex();
        
        return changes;
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
            mdxEntry.id = contentId;
            mdxEntry.hash = mdxHash;
            mdxEntry.lastSyncedAt = now;
            mdxEntry.lastModifiedRemote = updatedAt;
            mdxEntry.status = FileStatus.SYNCED;
        } else {
            // Create new entry
            this.index!.entries[mdxRelPath] = {
                id: contentId,
                fileType: FileType.CONTENT,
                localPath: mdxRelPath, // Store relative path instead of absolute
                hash: mdxHash,
                lastSyncedAt: now,
                lastModifiedRemote: updatedAt,
                status: FileStatus.SYNCED,
                relatedEntryIds: [metaRelPath]
            };
        }
        
        // Update metadata entry
        const metaEntry = this.index!.entries[metaRelPath];
        if (metaEntry) {
            metaEntry.id = contentId;
            metaEntry.hash = metaHash;
            metaEntry.lastSyncedAt = now;
            metaEntry.lastModifiedRemote = updatedAt;
            metaEntry.status = FileStatus.SYNCED;
        } else {
            // Create new entry
            this.index!.entries[metaRelPath] = {
                id: contentId,
                fileType: FileType.METADATA,
                localPath: metaRelPath, // Store relative path instead of absolute
                hash: metaHash,
                lastSyncedAt: now,
                lastModifiedRemote: updatedAt,
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
        
        this.index!.lastFullSyncAt = new Date().toISOString();
        await this.saveIndex();
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
        const oldRelPath = this.toRelativePath(oldPath);
        const newRelPath = this.toRelativePath(newPath);
        
        // Check if the old path exists in our index
        const entry = this.index!.entries[oldRelPath];
        if (!entry) {
            Logger.warn(`Attempted to rename ${oldRelPath}, but it's not in the index`);
            return;
        }
        
        // Create a new entry for the renamed file
        this.index!.entries[newRelPath] = {
            ...entry,
            localPath: newRelPath,
            originalPath: oldRelPath,
            status: FileStatus.RENAMED,
            lastModifiedLocal: new Date().toISOString()
        };
        
        // Delete the old entry
        delete this.index!.entries[oldRelPath];
        
        await this.saveIndex();
    }

    /**
     * Manually mark a file as renamed
     */
    public async markFileRenamed(oldPath: string, newPath: string): Promise<void> {
        this.ensureWorkspaceExists();
        
        if (!this.index) {
            await this.loadIndex();
        }
        
        const oldRelPath = this.toRelativePath(oldPath);
        const newRelPath = this.toRelativePath(newPath);
        
        Logger.info(`Manually marking file as renamed: ${oldRelPath} -> ${newRelPath}`);
        
        const oldEntry = this.index!.entries[oldRelPath];
        if (!oldEntry) {
            Logger.warn(`Cannot mark file as renamed: ${oldRelPath} not found in index`);
            return;
        }
        
        // Create entry at new path
        this.index!.entries[newRelPath] = {
            ...oldEntry,
            localPath: newRelPath,
            originalPath: oldRelPath,
            status: FileStatus.RENAMED,
            lastModifiedLocal: new Date().toISOString()
        };
        
        // Remove old entry
        delete this.index!.entries[oldRelPath];
        
        await this.saveIndex();
        Logger.info(`Successfully marked file as renamed: ${oldRelPath} -> ${newRelPath}`);
    }

    /**
     * Debug helper: List all indexed files with their hashes
     */
    public async listIndexedFiles(): Promise<void> {
        this.ensureWorkspaceExists();
        
        if (!this.index) {
            await this.loadIndex();
        }
        
        Logger.info('===== INDEX CONTENTS =====');
        Logger.info(`Total entries: ${Object.keys(this.index!.entries).length}`);
        
        for (const [relPath, entry] of Object.entries(this.index!.entries)) {
            const fullPath = this.toAbsolutePath(relPath);
            const exists = await fs.pathExists(fullPath);
            
            Logger.info(`${relPath} (${entry.fileType})`);
            Logger.info(`  Status: ${entry.status}, Exists: ${exists ? 'Yes' : 'No'}`);
            Logger.info(`  Hash: ${entry.hash.substring(0, 8)}...`);
            if (entry.originalPath) {
                Logger.info(`  Original path: ${entry.originalPath}`);
            }
        }
        
        Logger.info('========================');
    }
}
