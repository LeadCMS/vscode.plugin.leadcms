import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import { IndexService } from './index-service';
import { Logger } from '../utils/logger';
import { ContentReferenceUtils } from '../utils/content-reference-utils';

/**
 * Service that watches for file system changes and updates the index accordingly
 */
export class FileWatcherService {
    private contentWatcher: vscode.FileSystemWatcher | undefined;
    private fileOperationsInProgress: Set<string> = new Set();
    
    constructor(private indexService: IndexService, private workspacePath: string) {
        this.initialize();
    }
    
    /**
     * Initialize file system watchers
     */
    private initialize(): void {
        try {
            // Create watchers for content directories (which now include media files)
            const contentGlob = new vscode.RelativePattern(this.workspacePath, '**/content/**');
            
            // Set up content file watcher
            this.contentWatcher = vscode.workspace.createFileSystemWatcher(contentGlob);
            this.setupContentWatcher(this.contentWatcher);
            
            Logger.info('File watcher service initialized');
        } catch (error) {
            Logger.error('Failed to initialize file watcher service:', error);
        }
    }
    
    /**
     * Set up the watcher for content files (now includes media files)
     */
    private setupContentWatcher(watcher: vscode.FileSystemWatcher): void {
        // Watch for file renames - VS Code provides direct rename events
        vscode.workspace.onDidRenameFiles(async (event) => {
            for (const { oldUri, newUri } of event.files) {
                try {
                    const oldPath = oldUri.fsPath;
                    const newPath = newUri.fsPath;
                    
                    // Skip files that aren't in content directory
                    if (!oldPath.includes('/content/')) {
                        continue;
                    }
                    
                    Logger.info(`File renamed: ${oldPath} -> ${newPath}`);
                    
                    // Create operation ID to prevent duplicate processing
                    const opId = `rename_${oldPath}_${Date.now()}`;
                    this.fileOperationsInProgress.add(opId);
                    
                    try {
                        // Update index - use try/catch to handle files not in the index
                        try {
                            await this.indexService.updateAfterRename(oldPath, newPath);
                        } catch (indexError) {
                            Logger.warn(`Attempted to rename ${path.relative(this.workspacePath, oldPath)}, but it's not in the index`);
                            // Continue despite the index error
                        }
                        
                        // Handle linked file (MDX->JSON or JSON->MDX)
                        if (this.isContentFile(oldPath)) {
                            await this.handleLinkedFileRename(oldPath, newPath);
                        }
                        
                        // Handle media file rename
                        if (this.isMediaFile(oldPath)) {
                            await this.handleMediaFileRename(oldPath, newPath);
                        }
                        
                        // Check for content type folder renames
                        if (this.isContentTypeFolderRenamed(oldPath, newPath)) {
                            await this.handleContentTypeFolderRename(oldPath, newPath);
                        }
                    } finally {
                        // Remove operation from tracking
                        this.fileOperationsInProgress.delete(opId);
                    }
                } catch (error) {
                    Logger.error(`Error handling file rename: ${oldUri.fsPath} -> ${newUri.fsPath}`, error);
                }
            }
        });
        
        // Handle file deletion
        watcher.onDidDelete(async (uri) => {
            try {
                const deletedPath = uri.fsPath;
                
                // Skip non-content files
                if (!this.isContentFile(deletedPath)) {
                    return;
                }
                
                // Generate a unique operation ID to prevent double handling
                const opId = `delete_${deletedPath}_${Date.now()}`;
                
                // Check if we're already processing this file (e.g., as part of a rename)
                if (this.fileOperationsInProgress.has(opId) || 
                    Array.from(this.fileOperationsInProgress.values())
                        .some(id => id.includes(deletedPath))) {
                    Logger.info(`Skipping deletion handling for ${deletedPath} - already being processed`);
                    return;
                }
                
                this.fileOperationsInProgress.add(opId);
                
                Logger.info(`Content file deleted: ${deletedPath}`);
                
                // Wait a bit to ensure this isn't part of a rename operation
                setTimeout(async () => {
                    try {
                        // Double-check this isn't part of a rename that's still processing
                        if (Array.from(this.fileOperationsInProgress.values())
                            .some(id => id.includes(deletedPath) && id.startsWith('rename_'))) {
                            Logger.info(`Skipping deletion for ${deletedPath} - part of a rename operation`);
                            return;
                        }
                        
                        // Handle deletion of paired file (MDX or JSON)
                        const linkedPath = this.getLinkedFilePath(deletedPath);
                        
                        // Check if linked file exists
                        if (await fs.pathExists(linkedPath)) {
                            Logger.info(`Deleting linked file: ${linkedPath}`);
                            await fs.remove(linkedPath);
                        }
                        
                        // Handle any associated media folder
                        const fileInfo = this.extractContentFileInfo(deletedPath);
                        if (fileInfo) {
                            await this.handleContentMediaDeletion(fileInfo);
                        }
                    } catch (error) {
                        Logger.error(`Error handling linked file deletion for ${deletedPath}:`, error);
                    } finally {
                        this.fileOperationsInProgress.delete(opId);
                    }
                }, 500); // Increased timeout to give rename operations time to complete
            } catch (error) {
                Logger.error(`Error handling file deletion: ${uri.fsPath}`, error);
            }
        });
    }
    
    /**
     * Handle renaming a linked content file
     */
    private async handleLinkedFileRename(oldPath: string, newPath: string): Promise<void> {
        try {
            const linkedOldPath = this.getLinkedFilePath(oldPath);
            const linkedNewPath = this.getLinkedFilePath(newPath);
            
            Logger.info(`Checking for linked file: ${linkedOldPath}`);
            
            // Skip if the linked file doesn't exist
            if (!await fs.pathExists(linkedOldPath)) {
                Logger.info(`No linked file to rename: ${linkedOldPath} doesn't exist`);
                return;
            }
            
            Logger.info(`Renaming linked file: ${linkedOldPath} -> ${linkedNewPath}`);
            
            // Ensure the directory exists
            await fs.ensureDir(path.dirname(linkedNewPath));
            
            // Move the linked file
            await fs.move(linkedOldPath, linkedNewPath, { overwrite: false });
            
            // Update the index - handle files not in index gracefully
            try {
                await this.indexService.updateAfterRename(linkedOldPath, linkedNewPath);
            } catch (error) {
                Logger.warn(`Attempted to rename ${path.relative(this.workspacePath, linkedOldPath)}, but it's not in the index`);
                // Continue despite the index error
            }
        } catch (error) {
            Logger.error(`Failed to rename linked file: ${error}`);
        }
    }
    
    /**
     * Handle rename of content type folder (e.g., content/blog -> content/articles)
     */
    private async handleContentTypeFolderRename(oldPath: string, newPath: string): Promise<void> {
        try {
            const oldRelPath = path.relative(this.workspacePath, oldPath);
            const newRelPath = path.relative(this.workspacePath, newPath);
            
            const oldPathParts = oldRelPath.split(path.sep);
            const newPathParts = newRelPath.split(path.sep);
            
            if (oldPathParts.length < 2 || newPathParts.length < 2) {
                return;
            }
            
            const oldContentType = oldPathParts[1];
            const newContentType = newPathParts[1];
            
            Logger.info(`Content type folder renamed: ${oldContentType} -> ${newContentType}`);
            
            // Update references in all MDX files for the renamed content type
            await ContentReferenceUtils.updateAllContentTypeReferences(
                this.workspacePath,
                oldContentType,
                newContentType
            );
        } catch (error) {
            Logger.error(`Error handling content type folder rename:`, error);
        }
    }
    
    /**
     * Check if a content type folder was renamed
     */
    private isContentTypeFolderRenamed(oldPath: string, newPath: string): boolean {
        const oldRelPath = path.relative(this.workspacePath, oldPath);
        const newRelPath = path.relative(this.workspacePath, newPath);
        
        const oldPathParts = oldRelPath.split(path.sep);
        const newPathParts = newRelPath.split(path.sep);
        
        // Check if this is a content directory
        if (oldPathParts.length >= 2 && 
            newPathParts.length >= 2 && 
            oldPathParts[0] === 'content' && 
            newPathParts[0] === 'content') {
            
            // Check if content type was renamed
            return oldPathParts[1] !== newPathParts[1];
        }
        
        return false;
    }
    
    /**
     * Checks if a path is a content file (MDX or JSON in content directory)
     */
    private isContentFile(filePath: string): boolean {
        const relativePath = path.relative(this.workspacePath, filePath);
        const isInContentDir = relativePath.startsWith('content' + path.sep);
        const hasContentExt = filePath.endsWith('.mdx') || filePath.endsWith('.json');
        return isInContentDir && hasContentExt;
    }
    
    /**
     * Checks if a file is a media file by its extension
     * @param filePath Path to the file
     * @returns True if the file is a media file
     */
    private isMediaFile(filePath: string): boolean {
        try {
            // Get file extension
            const fileExt = path.extname(filePath).toLowerCase();
            
            // List of common media file extensions
            const mediaExtensions = [
                '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', 
                '.mp4', '.webm', '.mov', '.mp3', '.wav', '.pdf',
                '.ico', '.bmp', '.tiff', '.avif'
            ];
            
            // Check if extension is in the list of media extensions
            return mediaExtensions.includes(fileExt);
        } catch (error) {
            // Log error but don't throw - safer to return false if we can't determine
            Logger.error(`Error checking if file ${filePath} is a media file:`, error);
            return false;
        }
    }

    /**
     * Get the path of the linked file (JSON for MDX and vice versa)
     */
    private getLinkedFilePath(filePath: string): string {
        if (filePath.endsWith('.mdx')) {
            // For MDX files, the linked file is a JSON with the same name
            return filePath.substring(0, filePath.length - 4) + '.json';
        } else if (filePath.endsWith('.json')) {
            // For JSON files, the linked file is an MDX with the same name
            return filePath.substring(0, filePath.length - 5) + '.mdx';
        }
        
        // If it's neither MDX nor JSON, return the same path
        return filePath;
    }
    
    /**
     * Extract content type and slug from a file path
     */
    private extractContentFileInfo(filePath: string): { contentType: string, slug: string } | null {
        try {
            const relativePath = path.relative(this.workspacePath, filePath);
            const pathParts = relativePath.split(path.sep);
            
            // Verify this is a content file
            if (pathParts.length >= 4 && 
                pathParts[0] === 'content') {
                
                const contentType = pathParts[1];
                const slug = pathParts[2];
                const filename = pathParts[pathParts.length - 1];
                
                // Check if it's an index file
                if (filename === 'index.mdx' || filename === 'index.json') {
                    return { contentType, slug };
                }
                
                // If it's a media file in a content folder
                if (pathParts.length === 4 && 
                    !filename.endsWith('.mdx') && 
                    !filename.endsWith('.json')) {
                    return { contentType, slug };
                }
            }
            
            return null;
        } catch (error) {
            Logger.error(`Error extracting content file info: ${error}`);
            return null;
        }
    }

    /**
     * Handle content media deletion when content is deleted
     * With the new architecture, this method just ensures any media files 
     * in the content folder are properly deleted along with the content
     */
    private async handleContentMediaDeletion(fileInfo: { contentType: string, slug: string }): Promise<void> {
        try {
            const { contentType, slug } = fileInfo;
            const contentFolderPath = path.join(this.workspacePath, 'content', contentType, slug);
            
            // Log the deletion
            Logger.info(`Ensuring all content deleted from folder: ${contentFolderPath}`);
            
            // Check if the folder still exists (it might have been deleted already)
            if (await fs.pathExists(contentFolderPath)) {
                // Remove the entire content folder
                await fs.remove(contentFolderPath);
                Logger.info(`Removed content folder: ${contentFolderPath}`);
            }
        } catch (error) {
            Logger.error(`Error handling content media deletion:`, error);
        }
    }

    /**
     * Handle rename of content slug folder
     */
    private async handleContentFolderRename(oldPath: string, newPath: string): Promise<void> {
        try {
            const oldRelPath = path.relative(this.workspacePath, oldPath);
            const newRelPath = path.relative(this.workspacePath, newPath);
            
            const oldPathParts = oldRelPath.split(path.sep);
            const newPathParts = newRelPath.split(path.sep);
            
            // Check if this is a content slug folder rename
            if (oldPathParts.length >= 3 && 
                newPathParts.length >= 3 && 
                oldPathParts[0] === 'content' && 
                newPathParts[0] === 'content') {
                
                const oldContentType = oldPathParts[1];
                const newContentType = newPathParts[1];
                const oldSlug = oldPathParts[2];
                const newSlug = newPathParts[2];
                
                Logger.info(`Content folder renamed: ${oldContentType}/${oldSlug} -> ${newContentType}/${newSlug}`);
                
                // Update index for the MDX and JSON files
                const oldMdxPath = path.join(oldPath, 'index.mdx');
                const newMdxPath = path.join(newPath, 'index.mdx');
                const oldJsonPath = path.join(oldPath, 'index.json');
                const newJsonPath = path.join(newPath, 'index.json');
                
                // Update index entries
                if (await fs.pathExists(newMdxPath)) {
                    try {
                        await this.indexService.updateAfterRename(oldMdxPath, newMdxPath);
                    } catch (error) {
                        Logger.warn(`Could not update index for ${oldMdxPath}, might not be indexed yet`);
                    }
                }
                
                if (await fs.pathExists(newJsonPath)) {
                    try {
                        await this.indexService.updateAfterRename(oldJsonPath, newJsonPath);
                    } catch (error) {
                        Logger.warn(`Could not update index for ${oldJsonPath}, might not be indexed yet`);
                    }
                }
                
                // If content type changed, we need to handle that differently
                if (oldContentType !== newContentType) {
                    // Need to update references in other files
                    await ContentReferenceUtils.updateContentTypeReferencesInFolder(
                        this.workspacePath,
                        newPath,
                        oldContentType,
                        newContentType
                    );
                }
                
                // If slug changed, update the JSON file to reflect this
                if (oldSlug !== newSlug && await fs.pathExists(newJsonPath)) {
                    try {
                        const jsonContent = await fs.readFile(newJsonPath, 'utf8');
                        const metadata = JSON.parse(jsonContent);
                        
                        // Update any references in MDX that might still have old slug
                        if (await fs.pathExists(newMdxPath)) {
                            await ContentReferenceUtils.updateSlugReferencesInMdx(
                                newMdxPath,
                                oldSlug,
                                newSlug
                            );
                        }
                    } catch (error) {
                        Logger.error(`Error updating references after folder rename: ${error}`);
                    }
                }
            }
        } catch (error) {
            Logger.error(`Error handling content folder rename: ${error}`);
        }
    }

    /**
     * Checks if a path is a content folder (contains index.mdx or index.json)
     */
    private async isContentFolder(folderPath: string): Promise<boolean> {
        try {
            if (!(await fs.pathExists(folderPath))) {
                return false;
            }
            
            const stats = await fs.stat(folderPath);
            if (!stats.isDirectory()) {
                return false;
            }
            
            // Check if folder contains index.mdx or index.json
            return await fs.pathExists(path.join(folderPath, 'index.mdx')) || 
                   await fs.pathExists(path.join(folderPath, 'index.json'));
        } catch {
            return false;
        }
    }

    /**
     * Handle media file rename within a content folder
     */
    private async handleMediaFileRename(oldPath: string, newPath: string): Promise<void> {
        try {
            const oldFileName = path.basename(oldPath);
            const newFileName = path.basename(newPath);
            
            if (oldFileName === newFileName) {
                // Only path changed, not the filename
                return;
            }
            
            Logger.info(`Handling media file rename: ${oldFileName} -> ${newFileName}`);
            
            // Extract content info for the containing folder
            const contentInfo = this.extractContentFileInfo(oldPath);
            if (!contentInfo) {
                Logger.warn(`Could not determine content info for media file: ${oldPath}`);
                return;
            }
            
            // Check if this might be a rename back to an original path
            const newRelPath = path.relative(this.workspacePath, newPath);
            const oldRelPath = path.relative(this.workspacePath, oldPath);
            
            // Look for the file in the index with improved check
            const targetExists = await this.isFileInIndex(newRelPath);
            
            // Update index
            try {
                // If renaming back to an original that exists in index but intermediate doesn't, 
                // we don't need to update the index as it's already properly tracked
                if (targetExists) {
                    Logger.info(`Target ${newRelPath} exists in index, handling as rename back to original`);
                } else {
                    await this.indexService.updateAfterRename(oldPath, newPath);
                }
            } catch (error) {
                // If the file isn't in the index, add it as a new file
                if (await fs.pathExists(newPath)) {
                    try {
                        const { contentType, slug } = contentInfo;
                        // Generate a temporary media ID based on path
                        const mediaId = `local:${contentType}/${slug}/${newFileName}`;
                        await this.indexService.addMediaEntry(mediaId, '', newPath);
                        Logger.info(`Added new media file to index: ${newPath}`);
                    } catch (addError) {
                        Logger.error(`Failed to add new media file to index: ${addError}`);
                    }
                } else {
                    Logger.warn(`Could not update index for ${oldRelPath}, might not be indexed yet`);
                }
            }
            
            // Always update references, regardless of index status
            Logger.info(`Updating references to renamed media file: ${oldFileName} -> ${newFileName}`);
            const updatedFiles = await ContentReferenceUtils.updateMediaFileReferencesAcrossProject(
                this.workspacePath,
                oldFileName,
                newFileName
            );
            
            if (updatedFiles > 0) {
                Logger.info(`Successfully updated references in ${updatedFiles} files`);
            } else {
                Logger.info(`No references to update for ${oldFileName}`);
            }
        } catch (error) {
            Logger.error(`Error handling media file rename: ${error}`);
        }
    }

    /**
     * Check if a file exists in the index
     */
    private async isFileInIndex(relativePath: string): Promise<boolean> {
        try {
            // Make sure we're loading the latest index state
            const index = await this.indexService.loadIndex();
            
            // Check if the entry exists directly
            if (index.entries[relativePath]) {
                return true;
            }
            
            // If not found directly, check if any entry points to this file in its originalPath
            // This handles files that were renamed and might be getting renamed back
            for (const entry of Object.values(index.entries)) {
                if (entry.originalPath === relativePath || 
                    (entry.originalState && entry.originalState.localPath === relativePath)) {
                    return true;
                }
            }
            
            return false;
        } catch (error) {
            Logger.error(`Error checking if file exists in index: ${error}`);
            return false;
        }
    }

    /**
     * Dispose the file watchers when no longer needed
     */
    public dispose(): void {
        if (this.contentWatcher) {
            this.contentWatcher.dispose();
            this.contentWatcher = undefined;
        }
    }
}