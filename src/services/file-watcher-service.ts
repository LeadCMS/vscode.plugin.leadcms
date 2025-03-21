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
    private mediaWatcher: vscode.FileSystemWatcher | undefined;
    private fileOperationsInProgress: Set<string> = new Set();
    
    constructor(private indexService: IndexService, private workspacePath: string) {
        this.initialize();
    }
    
    /**
     * Initialize file system watchers
     */
    private initialize(): void {
        try {
            // Create watchers for content and media directories
            const contentGlob = new vscode.RelativePattern(this.workspacePath, '**/content/**');
            const mediaGlob = new vscode.RelativePattern(this.workspacePath, '**/media/**');
            
            // Set up content file watcher
            this.contentWatcher = vscode.workspace.createFileSystemWatcher(contentGlob);
            this.setupContentWatcher(this.contentWatcher);
            
            // Set up media file watcher
            this.mediaWatcher = vscode.workspace.createFileSystemWatcher(mediaGlob);
            this.setupMediaWatcher(this.mediaWatcher);
            
            Logger.info('File watcher service initialized');
        } catch (error) {
            Logger.error('Failed to initialize file watcher service:', error);
        }
    }
    
    /**
     * Set up the watcher for content files
     */
    private setupContentWatcher(watcher: vscode.FileSystemWatcher): void {
        // Watch for file renames - VS Code provides direct rename events
        vscode.workspace.onDidRenameFiles(async (event) => {
            for (const { oldUri, newUri } of event.files) {
                try {
                    const oldPath = oldUri.fsPath;
                    const newPath = newUri.fsPath;
                    
                    // Skip files that aren't in content directory
                    if (!this.isContentFile(oldPath)) {
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
                        await this.handleLinkedFileRename(oldPath, newPath);
                        
                        // Handle media folder renaming regardless of index status
                        await this.handleContentMediaFolderRename(oldPath, newPath);
                        
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
     * Set up the watcher for media files
     */
    private setupMediaWatcher(watcher: vscode.FileSystemWatcher): void {
        // Handle media folder renames
        vscode.workspace.onDidRenameFiles(async (event) => {
            for (const { oldUri, newUri } of event.files) {
                try {
                    const oldPath = oldUri.fsPath;
                    const newPath = newUri.fsPath;
                    
                    // Check if it's a media folder
                    if (this.isMediaFolder(oldPath) && this.isMediaFolder(newPath)) {
                        Logger.info(`Media folder renamed: ${oldPath} -> ${newPath}`);
                        
                        // Extract slugs from media paths
                        const oldSlug = this.extractSlugFromMediaPath(oldPath);
                        const newSlug = this.extractSlugFromMediaPath(newPath);
                        
                        if (oldSlug && newSlug) {
                            Logger.info(`Detected media folder slug change: ${oldSlug} -> ${newSlug}`);
                            
                            // Find and update corresponding content files
                            await this.findAndRenameContentFilesForMediaFolder(oldSlug, newSlug);
                        } else {
                            Logger.warn(`Could not extract slugs from media paths: ${oldPath} -> ${newPath}`);
                        }
                    }
                } catch (error) {
                    Logger.error(`Error handling media rename: ${oldUri.fsPath} -> ${newUri.fsPath}`, error);
                }
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
     * Handles renaming the media folder associated with a renamed content file
     */
    private async handleContentMediaFolderRename(oldContentPath: string, newContentPath: string): Promise<void> {
        try {
            // Extract content info from paths
            const oldInfo = this.extractContentFileInfo(oldContentPath);
            const newInfo = this.extractContentFileInfo(newContentPath);
            
            if (!oldInfo || !newInfo) {
                Logger.warn(`Could not extract content info for rename: ${oldContentPath} -> ${newContentPath}`);
                return;
            }
            
            // Check three possible media folder locations:
            // 1. media/contentType/slug
            // 2. media/slug
            const possibleOldMediaFolders = [
                path.join(this.workspacePath, 'media', oldInfo.contentType, oldInfo.slug),
                path.join(this.workspacePath, 'media', oldInfo.slug)
            ];
            
            // Find which media folder exists, if any
            let oldMediaFolder: string | null = null;
            let mediaFolderType: 'typed' | 'direct' = 'typed'; // Default to typed
            
            for (const [index, folderPath] of possibleOldMediaFolders.entries()) {
                if (await fs.pathExists(folderPath)) {
                    oldMediaFolder = folderPath;
                    mediaFolderType = index === 0 ? 'typed' : 'direct';
                    break;
                }
            }
            
            // If we found a media folder, rename it
            if (oldMediaFolder) {
                // Choose new media folder path based on the type of the old folder
                let newMediaFolder: string;
                
                if (mediaFolderType === 'typed') {
                    newMediaFolder = path.join(this.workspacePath, 'media', newInfo.contentType, newInfo.slug);
                } else {
                    newMediaFolder = path.join(this.workspacePath, 'media', newInfo.slug);
                }
                
                Logger.info(`Renaming media folder: ${oldMediaFolder} -> ${newMediaFolder}`);
                
                // Ensure parent directory exists
                await fs.ensureDir(path.dirname(newMediaFolder));
                
                try {
                    // Move the entire folder with contents
                    await fs.move(oldMediaFolder, newMediaFolder);
                } catch (moveError) {
                    Logger.warn(`Move operation failed, trying copy+remove: ${moveError}`);
                    await fs.copy(oldMediaFolder, newMediaFolder, { overwrite: false });
                    await fs.remove(oldMediaFolder);
                }
                
                // Update references in content files
                const mdxPath = newContentPath.endsWith('.mdx') 
                    ? newContentPath 
                    : this.getLinkedFilePath(newContentPath);
                    
                const jsonPath = newContentPath.endsWith('.json') 
                    ? newContentPath 
                    : this.getLinkedFilePath(newContentPath);
                    
                // Update MDX file if it exists
                if (await fs.pathExists(mdxPath)) {
                    await this.updateMediaReferencesForFolderRename(mdxPath, oldInfo.slug, newInfo.slug);
                }
                
                // Update JSON file if it exists
                if (await fs.pathExists(jsonPath)) {
                    await ContentReferenceUtils.updateSlugReferencesInJson(jsonPath, oldInfo.slug, newInfo.slug);
                }
            } else {
                // If no media folder exists yet, we should still check if we need to create one
                const newDirectMediaFolder = path.join(this.workspacePath, 'media', newInfo.slug);
                await fs.ensureDir(newDirectMediaFolder);
                Logger.info(`Created empty media folder: ${newDirectMediaFolder}`);
                
                // Still update JSON references even if no media folder exists
                const jsonPath = newContentPath.endsWith('.json') 
                    ? newContentPath 
                    : this.getLinkedFilePath(newContentPath);
                    
                if (await fs.pathExists(jsonPath)) {
                    await ContentReferenceUtils.updateSlugReferencesInJson(jsonPath, oldInfo.slug, newInfo.slug);
                }
            }
        } catch (error) {
            Logger.error(`Error handling media folder rename for content file: ${error}`);
        }
    }
    
    /**
     * Extract slug from media folder path
     * Handles both media/slug and media/contentType/slug patterns
     */
    private extractSlugFromMediaPath(mediaPath: string): string | null {
        try {
            const relativePath = path.relative(this.workspacePath, mediaPath);
            const pathParts = relativePath.split(path.sep);
            
            // Skip empty parts and "media" part
            if (pathParts.length < 2 || pathParts[0] !== 'media') {
                return null;
            }
            
            // If direct under media/ folder, the slug is the next component
            if (pathParts.length === 2) {
                return pathParts[1];
            }
            
            // If it follows media/contentType/slug pattern, return the slug
            if (pathParts.length >= 3) {
                return pathParts[pathParts.length - 1];
            }
            
            return null;
        } catch (error) {
            Logger.error(`Error extracting slug from media path: ${mediaPath}`, error);
            return null;
        }
    }
    
    /**
     * Find and rename content files that match a media folder slug
     */
    private async findAndRenameContentFilesForMediaFolder(oldSlug: string, newSlug: string): Promise<void> {
        try {
            // Search for content files with matching slug
            const contentTypes = await this.getContentTypes();
            let matchFound = false;
            
            for (const contentType of contentTypes) {
                const contentTypePath = path.join(this.workspacePath, 'content', contentType);
                
                // Skip if content type folder doesn't exist
                if (!(await fs.pathExists(contentTypePath))) {
                    continue;
                }
                
                // Check for MDX file
                const mdxPath = path.join(contentTypePath, `${oldSlug}.mdx`);
                const jsonPath = path.join(contentTypePath, `${oldSlug}.json`);
                
                // If either file exists, handle the rename
                if (await fs.pathExists(mdxPath) || await fs.pathExists(jsonPath)) {
                    matchFound = true;
                    Logger.info(`Found matching content files for media slug "${oldSlug}" in ${contentType}`);
                    
                    // Create new paths
                    const newMdxPath = path.join(contentTypePath, `${newSlug}.mdx`);
                    const newJsonPath = path.join(contentTypePath, `${newSlug}.json`);
                    
                    // Rename MDX file if it exists
                    if (await fs.pathExists(mdxPath)) {
                        Logger.info(`Renaming MDX file: ${mdxPath} -> ${newMdxPath}`);
                        
                        // First update references in the file
                        await this.updateMediaReferencesForFolderRename(mdxPath, oldSlug, newSlug);
                        
                        // Then move the file
                        await fs.move(mdxPath, newMdxPath, { overwrite: false });
                        
                        // Update index
                        try {
                            await this.indexService.updateAfterRename(mdxPath, newMdxPath);
                        } catch (error) {
                            Logger.warn(`Could not update index for ${mdxPath}, might not be indexed yet`);
                        }
                    }
                    
                    // Rename JSON file if it exists
                    if (await fs.pathExists(jsonPath)) {
                        Logger.info(`Renaming JSON file: ${jsonPath} -> ${newJsonPath}`);
                        await fs.move(jsonPath, newJsonPath, { overwrite: false });
                        
                        // Update index
                        try {
                            await this.indexService.updateAfterRename(jsonPath, newJsonPath);
                        } catch (error) {
                            Logger.warn(`Could not update index for ${jsonPath}, might not be indexed yet`);
                        }
                    }
                }
            }
            
            if (!matchFound) {
                Logger.info(`No matching content files found for media slug "${oldSlug}"`);
            }
        } catch (error) {
            Logger.error(`Error finding and renaming content files: ${error}`);
        }
    }
    
    /**
     * Get list of content types (folders under content/)
     */
    private async getContentTypes(): Promise<string[]> {
        try {
            const contentPath = path.join(this.workspacePath, 'content');
            
            if (!(await fs.pathExists(contentPath))) {
                return [];
            }
            
            const entries = await fs.readdir(contentPath, { withFileTypes: true });
            return entries
                .filter(entry => entry.isDirectory())
                .map(dir => dir.name);
        } catch (error) {
            Logger.error(`Error getting content types: ${error}`);
            return [];
        }
    }
    
    /**
     * Update media references when a media folder is renamed
     */
    private async updateMediaReferencesForFolderRename(
        mdxPath: string,
        oldMediaSlug: string,
        newMediaSlug: string
    ): Promise<void> {
        try {
            if (!(await fs.pathExists(mdxPath))) {
                return;
            }
            
            // Use the consolidated utility method
            const updated = await ContentReferenceUtils.updateReferencesInMdx(
                mdxPath, 
                oldMediaSlug, 
                newMediaSlug, 
                true // This is a slug rename
            );
            
            if (updated) {
                Logger.info(`Successfully updated references in ${mdxPath} from ${oldMediaSlug} to ${newMediaSlug}`);
            }
        } catch (error) {
            Logger.error(`Error updating media references in ${mdxPath}: ${error}`);
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
            
            const oldMediaPath = path.join(this.workspacePath, 'media', oldContentType);
            const newMediaPath = path.join(this.workspacePath, 'media', newContentType);
            
            // Check if old media folder exists
            if (await fs.pathExists(oldMediaPath)) {
                Logger.info(`Updating media folder for content type: ${oldContentType} -> ${newContentType}`);
                
                // Create the new media folder if it doesn't exist
                await fs.ensureDir(newMediaPath);
                
                // Copy files from old media folder to new media folder
                await fs.copy(oldMediaPath, newMediaPath);
                
                // Update references in all MDX files for the renamed content type
                await ContentReferenceUtils.updateAllContentTypeReferences(
                    this.workspacePath,
                    oldContentType,
                    newContentType
                );
                
                // Remove the old media folder
                await fs.remove(oldMediaPath);
            }
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
     * Checks if a path is a media folder
     */
    private isMediaFolder(folderPath: string): boolean {
        const relativePath = path.relative(this.workspacePath, folderPath);
        return relativePath.startsWith('media' + path.sep);
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
            if (pathParts.length >= 3 && 
                pathParts[0] === 'content') {
                
                const contentType = pathParts[1];
                const filename = pathParts[pathParts.length - 1];
                
                // Get slug by removing extension
                let slug = filename;
                if (slug.endsWith('.mdx')) {
                    slug = slug.substring(0, slug.length - 4);
                } else if (slug.endsWith('.json')) {
                    slug = slug.substring(0, slug.length - 5);
                }
                
                return { contentType, slug };
            }
        } catch (error) {
            Logger.error(`Error extracting content file info: ${filePath}`, error);
        }
        return null;
    }
    
    /**
     * Handle media deletion when content is deleted
     */
    private async handleContentMediaDeletion(fileInfo: { contentType: string, slug: string }): Promise<void> {
        try {
            const { contentType, slug } = fileInfo;
            
            // Check for direct media folder (media/slug) first
            const directMediaFolder = path.join(this.workspacePath, 'media', slug);
            
            // Then check for typed media folder (media/contentType/slug)
            const typedMediaFolder = path.join(this.workspacePath, 'media', contentType, slug);
            
            // Remove whichever media folder exists
            if (await fs.pathExists(directMediaFolder)) {
                Logger.info(`Deleting direct media folder for deleted content: ${directMediaFolder}`);
                await fs.remove(directMediaFolder);
            }
            
            if (await fs.pathExists(typedMediaFolder)) {
                Logger.info(`Deleting typed media folder for deleted content: ${typedMediaFolder}`);
                await fs.remove(typedMediaFolder);
            }
        } catch (error) {
            Logger.error(`Error handling content media deletion:`, error);
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
        if (this.mediaWatcher) {
            this.mediaWatcher.dispose();
            this.mediaWatcher = undefined;
        }
    }
}