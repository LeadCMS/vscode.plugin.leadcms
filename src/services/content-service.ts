import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { ContentCreateDto, ContentDetailsDto, ContentUpdateDto } from '../models/content';
import { ApiService } from './api-service';
import { ConfigService } from './config-service';
import { MediaService } from './media-service';
import { replaceMediaReferences } from '../utils/mdx-utils';
import { Logger } from '../utils/logger';
import { AuthenticationError } from '../utils/errors';
import { IndexService } from './index-service';
import { showErrorWithDetails, handleAuthenticationError } from '../utils/ui-helpers';
import { ChangeReport, FileStatus, FileType } from '../models';
import { ApiErrorHandler } from './api-error-handler';
import { ValidationService } from '../validation/validation-service';

export class ContentService {
    private workspacePath: string | undefined;
    private apiService: ApiService;
    private configService: ConfigService;
    private mediaService: MediaService;
    private indexService: IndexService;
    private validationService: ValidationService;
    
    constructor(apiService: ApiService, mediaService: MediaService, indexService: IndexService) {
        this.apiService = apiService;
        this.configService = apiService.getConfigService();
        this.mediaService = mediaService;
        this.indexService = indexService;
        this.initialize();
        this.validationService = new ValidationService(this.workspacePath);
    }

    private initialize(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            this.workspacePath = workspaceFolders[0].uri.fsPath;
        }
        // If no workspace is open, workspacePath will remain undefined
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

    public async pullContent(): Promise<void> {
        this.ensureWorkspaceExists();
        
        try {
            // Authentication errors from apiService.exportContent will be propagated directly
            const contents = await this.apiService.exportContent();
            
            if (!contents || contents.length === 0) {
                vscode.window.showInformationMessage('No content found to pull.');
                return;
            }
            
            let successCount = 0;
            let errorCount = 0;
            let mediaCount = 0;
            
            // Get IDs of all remote content for later comparison
            const remoteIds = contents.map(content => content.id);
            
            // Get config once for all content
            const config = await this.configService.getConfig();
            
            for (const content of contents) {
                try {
                    if (!this.isValidContent(content)) {
                        console.warn('Skipping invalid content:', content);
                        errorCount++;
                        continue;
                    }
                    
                    // Create a working copy of the content that we'll modify
                    const workingContent = { ...content };
                    
                    // Download and process any media files first
                    let mediaMap = new Map<string, string>();
                    
                    if (workingContent.body) {
                        try {
                            // Pass content type and slug for proper media storage location
                            const mdxMediaMap = await this.mediaService.downloadMediaFromMdx(
                                workingContent.body,
                                workingContent.type,
                                workingContent.slug
                            );
                            
                            // Merge media maps
                            mdxMediaMap.forEach((value, key) => {
                                mediaMap.set(key, value);
                            });
                            
                            // Also check for media in metadata (coverImageUrl, etc.)
                            const [metadataMediaMap, updatedMetadata] = await this.mediaService.downloadMediaFromMetadata(
                                workingContent,
                                workingContent.type,
                                workingContent.slug
                            );
                            
                            // Merge with existing map
                            metadataMediaMap.forEach((value, key) => {
                                mediaMap.set(key, value);
                            });
                            
                            mediaCount += mediaMap.size;
                            
                            // Track media files in the index
                            for (const [remoteUrl, localPath] of mediaMap.entries()) {
                                // Extract media ID from URL if possible
                                const urlParts = remoteUrl.split('/');
                                const mediaId = urlParts[urlParts.length - 1] || remoteUrl;
                                
                                await this.indexService.addMediaEntry(mediaId, remoteUrl, localPath);
                            }
                            
                            // Update the working content with the processed metadata values
                            if (updatedMetadata) {
                                // Copy all properties except 'body' which we'll handle separately
                                Object.keys(updatedMetadata).forEach(key => {
                                    if (key !== 'body') {
                                        // Use type assertion to fix the TypeScript error
                                        (workingContent as any)[key] = (updatedMetadata as any)[key];
                                    }
                                });
                            }
                            
                            // Always replace remote media references with local ones if we have media
                            if (mediaMap.size > 0) {
                                // Update the MDX content body with local references
                                workingContent.body = replaceMediaReferences(
                                    workingContent.body, 
                                    mediaMap,
                                    workingContent.type,
                                    workingContent.slug
                                );
                                
                                Logger.info(`Replaced media references in content body for ${workingContent.slug}`);
                            }
                        } catch (mediaError) {
                            console.error(`Failed to process media for content ${workingContent.id}:`, mediaError);
                            // Continue with other content - don't count this as an error
                        }
                    }
                    
                    // Then save the content to files (with now modified body and metadata)
                    const { mdxPath, metadataPath } = await this.saveContentToFiles(workingContent);
                    
                    // Add to index
                    await this.indexService.addOrUpdateContentEntry(workingContent, mdxPath, metadataPath);
                    
                    successCount++;
                } catch (error) {
                    console.error(`Failed to save content ${content?.id || 'unknown'}:`, error);
                    errorCount++;
                }
            }
            
            // Mark entries that are in the index but not in the remote content as deleted
            await this.indexService.markDeletedEntries(remoteIds);
            
            // Update index after full sync
            await this.indexService.updateAfterFullSync();
            
            let message = successCount > 0 
                ? `Successfully pulled ${successCount} content items with ${mediaCount} media files.` 
                : 'No content was pulled successfully.';
                
            if (errorCount > 0) {
                message += ` ${errorCount} items had errors (see console for details).`;
            }
            
            vscode.window.showInformationMessage(message);
        } catch (error) {
            // Don't wrap authentication errors, just pass them through
            if (error instanceof AuthenticationError) {
                throw error;
            }
            
            Logger.error('Failed to pull content:', error);
            throw error;
        }
    }

    private isValidContent(content: any): content is ContentDetailsDto {
        return content && 
               typeof content === 'object' &&
               typeof content.id === 'number' &&
               typeof content.title === 'string' &&
               typeof content.slug === 'string' &&
               typeof content.type === 'string';
    }

    private async saveContentToFiles(content: ContentDetailsDto): Promise<{ mdxPath: string, metadataPath: string }> {
        this.ensureWorkspaceExists();

        try {
            // Ensure required properties exist
            if (!content.type) {
                throw new Error(`Content ${content.id} is missing required 'type' property`);
            }
            
            // Create folder structure: content/contentType/slug/
            const contentFolder = path.join(this.workspacePath!, 'content', content.type, content.slug);
            await fs.ensureDir(contentFolder);
            
            // Save body content to index.mdx file
            const mdxPath = path.join(contentFolder, 'index.mdx');
            await fs.writeFile(mdxPath, content.body || '', 'utf8');
            
            // Save metadata to index.json file, excluding unnecessary fields
            const metadataPath = path.join(contentFolder, 'index.json');
            
            // Create a new object without unnecessary properties
            const { body, slug, type, createdAt, comments, updatedAt, ...cleanMetadata } = content;
            
            await fs.writeFile(metadataPath, JSON.stringify(cleanMetadata, null, 2), 'utf8');
            
            return { mdxPath, metadataPath };
        } catch (error) {
            console.error(`Failed to save content ${content.id}:`, error);
            throw error;
        }
    }

    public async createNewContent(type: string, title: string, slug: string): Promise<void> {
        this.ensureWorkspaceExists();
        
        try {
            // Create folder structure: content/contentType/slug/
            const contentFolder = path.join(this.workspacePath!, 'content', type, slug);
            await fs.ensureDir(contentFolder);
            
            // Create empty MDX file
            const mdxPath = path.join(contentFolder, 'index.mdx');
            const defaultBody = `# ${title}\n\nEnter your content here...`;
            await fs.writeFile(mdxPath, defaultBody, 'utf8');
            
            // Create metadata JSON file with minimal details (no slug as it's part of the folder structure)
            const metadataPath = path.join(contentFolder, 'index.json');
            const metadata: Omit<Partial<ContentDetailsDto>, 'slug'> = {
                title,
                type,
                description: '',
                author: '',
                language: 'en',
                tags: [],
                category: '',
                allowComments: true
            };
            
            await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
            
            vscode.window.showInformationMessage(`Created new ${type} content: ${title}`);
            
            // Open the new file in the editor
            const document = await vscode.workspace.openTextDocument(mdxPath);
            await vscode.window.showTextDocument(document);
        } catch (error) {
            console.error('Failed to create new content:', error);
            throw error;
        }
    }

    /**
     * Pushes content changes to the CMS based on local changes
     */
    public async pushContent(): Promise<void> {
        this.ensureWorkspaceExists();
        
        try {
            // Validate content before pushing
            const isValid = await this.validationService.validateBeforeSync();
            if (!isValid) {
                Logger.info('Content push cancelled due to validation errors');
                return;
            }
            
            // First refresh local changes
            await this.indexService.checkLocalChanges();
            
            // Get all pending changes
            const changes = await this.indexService.getPendingChanges();
            
            // Log all changes for debugging purposes
            Logger.info(`Changes detected: ${changes.new.length} new, ${changes.modified.length} modified, ` +
                        `${changes.deleted.length} deleted, ${changes.renamed.length} renamed`);
            if (changes.renamed.length > 0) {
                changes.renamed.forEach(rename => {
                    Logger.info(`Renamed: ${rename.from} -> ${rename.to}`);
                });
            }
            
            let updatedCount = 0;
            let createdCount = 0;
            let deletedCount = 0;
            let mediaUploadCount = 0;
            let errorCount = 0;
            let renamedCount = 0;
            
            // Process deleted files first to avoid conflicts
            Logger.info(`Processing ${changes.deleted.length} deleted items...`);
            for (const deletedPath of changes.deleted) {
                try {
                    const entry = this.indexService.getEntryByPath(deletedPath);
                    
                    // Skip items that are part of a rename operation
                    const isPartOfRename = changes.renamed.some(rename => rename.from === deletedPath);
                    if (isPartOfRename) {
                        Logger.info(`Skipping deletion of ${deletedPath} as it's part of a rename operation`);
                        continue;
                    }
                    
                    if (entry && entry.id) {
                        if (entry.fileType === FileType.CONTENT) {
                            // Delete the content in the API
                            await this.apiService.deleteContent(entry.id);
                            
                            // Remove both content and its metadata from index
                            await this.indexService.removeEntry(deletedPath);
                            
                            // Also look for and remove metadata entry
                            if (entry.relatedEntryIds && entry.relatedEntryIds.length > 0) {
                                for (const relatedPath of entry.relatedEntryIds) {
                                    await this.indexService.removeEntry(relatedPath);
                                }
                            }
                            
                            deletedCount++;
                        }
                        // Handle deletion of media files
                        else if (entry.fileType === FileType.MEDIA) {
                            try {
                                // Extract media path from local path
                                const contentInfo = this.mediaService.extractContentInfoFromPath(this.indexService.toAbsolutePath(deletedPath));
                                if (contentInfo && contentInfo.contentType && contentInfo.slug) {
                                    const fileName = path.basename(deletedPath);
                                    const mediaPath = `${contentInfo.contentType}/${contentInfo.slug}/${fileName}`;
                                    
                                    // Delete the media file from the API
                                    await this.apiService.deleteMedia(mediaPath);
                                    
                                    // Remove from index
                                    await this.indexService.removeEntry(deletedPath);
                                    
                                    Logger.info(`Deleted media file: ${mediaPath}`);
                                    deletedCount++;
                                } else {
                                    Logger.warn(`Could not extract content info from media path: ${deletedPath}`);
                                }
                            } catch (mediaError) {
                                if (mediaError instanceof AuthenticationError) {
                                    await handleAuthenticationError(mediaError);
                                    return;
                                }
                                Logger.error(`Failed to delete media file ${deletedPath}:`, mediaError);
                                errorCount++;
                            }
                        }
                    }
                } catch (error) {
                    // Stop processing if this is an authentication error
                    if (error instanceof AuthenticationError) {
                        await handleAuthenticationError(error);
                        return;
                    }
                    Logger.error(`Failed to delete content at ${deletedPath}:`, error);
                    errorCount++;
                }
            }
            
            // Process renamed files next
            Logger.info(`Processing ${changes.renamed.length} renamed items...`);
            // Create a map to track processed renames to avoid duplicate processing
            const processedRenames = new Map<string, boolean>();
            
            for (const rename of changes.renamed) {
                // Skip if already processed
                if (processedRenames.has(rename.from)) {
                    continue;
                }
                
                try {
                    // Instead of looking up by the old path which no longer exists in the index,
                    // look up by the new path, which contains information about the original state
                    const newEntry = this.indexService.getEntryByPath(rename.to);
                    if (!newEntry) {
                        Logger.warn(`Cannot find renamed entry at new location: ${rename.to}`);
                        continue;
                    }
                    
                    // Make sure it's actually a renamed file
                    if (newEntry.status !== FileStatus.RENAMED) {
                        Logger.warn(`Entry at ${rename.to} is not marked as renamed, status: ${newEntry.status}`);
                        continue;
                    }

                    // Handle renamed media files
                    if (newEntry.fileType === FileType.MEDIA) {
                        // Get the file at the new location
                        const toRelPath = rename.to;
                        const fullPath = path.join(this.workspacePath!, toRelPath);
                        
                        // If file doesn't exist at the new location, skip
                        if (!await fs.pathExists(fullPath)) {
                            Logger.warn(`File doesn't exist at the new location: ${fullPath}`);
                            continue;
                        }

                        // Upload the media file with the new name
                        const url = await this.mediaService.uploadMediaFile(fullPath);
                        
                        // Extract necessary details for adding to index
                        const contentInfo = this.mediaService.extractContentInfoFromPath(fullPath);
                        if (contentInfo) {
                            // Extract media ID from URL if possible
                            const urlParts = url.split('/');
                            const mediaId = urlParts[urlParts.length - 1] || url;
                            
                            // Add new file to index
                            await this.indexService.addMediaEntry(
                                mediaId, 
                                url, 
                                fullPath
                            );
                            
                            // Now that API supports media deletion, delete the old file
                            try {
                                // Get the content info for the old file
                                const oldContentInfo = this.mediaService.extractContentInfoFromPath(
                                    path.join(this.workspacePath!, rename.from)
                                );
                                
                                if (oldContentInfo && oldContentInfo.contentType && oldContentInfo.slug) {
                                    const oldFileName = path.basename(rename.from);
                                    const oldMediaPath = `${oldContentInfo.contentType}/${oldContentInfo.slug}/${oldFileName}`;
                                    
                                    // Delete the old media file from the API
                                    await this.apiService.deleteMedia(oldMediaPath);
                                    Logger.info(`Deleted old media file: ${oldMediaPath}`);
                                } else {
                                    Logger.warn(`Could not extract content info from old media path: ${rename.from}`);
                                }
                            } catch (deleteError) {
                                Logger.error(`Failed to delete old media file ${rename.from}:`, deleteError);
                                // Continue processing - this is not a critical error
                            }
                            
                            mediaUploadCount++;
                            renamedCount++;
                            Logger.info(`Processed renamed media file: ${rename.from} -> ${rename.to}`);
                        }
                        
                        // Mark this rename as processed
                        processedRenames.set(rename.from, true);
                    }
                    // Handle renamed content folder (slug change)
                    else if (newEntry.fileType === FileType.CONTENT || newEntry.fileType === FileType.METADATA) {
                        // Only process content file - metadata will be handled together with content
                        if (newEntry.fileType === FileType.CONTENT) {
                            // Check if we need to process a folder rename (slug change)
                            const fromPathParts = rename.from.split(path.sep);
                            const toPathParts = rename.to.split(path.sep);
                            
                            // Check if this is a content folder rename - both must be index.mdx and in different folders
                            if (fromPathParts.length >= 4 && toPathParts.length >= 4 && 
                                fromPathParts[0] === 'content' && toPathParts[0] === 'content' &&
                                fromPathParts[fromPathParts.length - 1] === 'index.mdx' && 
                                toPathParts[toPathParts.length - 1] === 'index.mdx') {
                                
                                const fromContentType = fromPathParts[1];
                                const fromSlug = fromPathParts[2];
                                const toContentType = toPathParts[1];
                                const toSlug = toPathParts[2];
                                
                                // If content type or slug changed, handle as a slug/folder rename
                                if (fromContentType !== toContentType || fromSlug !== toSlug) {
                                    // If this is a content file (index.mdx), we need to update the content with the new slug
                                    // Check if we have the content ID
                                    if (newEntry.id) {
                                        try {
                                            // Get the new content from the new location
                                            const newPath = path.join(this.workspacePath!, rename.to);
                                            const newFolder = path.dirname(newPath);
                                            const jsonPath = path.join(newFolder, 'index.json');
                                            
                                            // Skip if JSON file doesn't exist at new location
                                            if (!await fs.pathExists(jsonPath)) {
                                                Logger.warn(`JSON file doesn't exist at new location: ${jsonPath}`);
                                                continue;
                                            }
                                            
                                            // Read content and metadata
                                            const mdxContent = await fs.readFile(newPath, 'utf8');
                                            const metadataContent = await fs.readFile(jsonPath, 'utf8');
                                            let metadata = JSON.parse(metadataContent);
                                            
                                            // Add the slug and type from the folder structure
                                            metadata.slug = toSlug;
                                            metadata.type = toContentType;
                                            
                                            // Process MDX content to convert local media references back to API URLs
                                            const bodyContent = await this.mediaService.convertLocalMediaToApiRefs(mdxContent, toContentType, toSlug);
                                            
                                            // Also convert metadata media references to API URLs
                                            metadata = this.mediaService.convertMetadataMediaToApiRefs(metadata, toContentType, toSlug);
                                            
                                            // Update existing content
                                            const updateDto: ContentUpdateDto = {
                                                title: metadata.title,
                                                description: metadata.description,
                                                body: bodyContent,
                                                slug: toSlug,
                                                type: toContentType,
                                                author: metadata.author || '',
                                                language: metadata.language || 'en',
                                                tags: metadata.tags || [],
                                                category: metadata.category || '',
                                                coverImageUrl: metadata.coverImageUrl || '',
                                                coverImageAlt: metadata.coverImageAlt || '',
                                                allowComments: metadata.allowComments === undefined ? true : metadata.allowComments,
                                                source: metadata.source || '',
                                                publishedAt: metadata.publishedAt || new Date().toISOString()
                                            };
                                            
                                            Logger.info(`Updating existing content with ID ${newEntry.id} for renamed content: ${rename.from} -> ${rename.to}`);
                                            const updatedContent = await this.apiService.updateContent(newEntry.id, updateDto);
                                            
                                            // Update the local metadata
                                            metadata.id = updatedContent.id;
                                            metadata.updatedAt = updatedContent.updatedAt;
                                            
                                            // Remove unnecessary properties that shouldn't be stored locally
                                            delete metadata.slug;
                                            delete metadata.type;
                                            delete metadata.createdAt;
                                            delete metadata.updatedAt;
                                            delete metadata.comments;

                                            await fs.writeFile(jsonPath, JSON.stringify(metadata, null, 2), 'utf8');
                                            
                                            // Update the index with the updated content
                                            await this.indexService.updateAfterPush(
                                                updatedContent.id,
                                                newPath,
                                                jsonPath,
                                                updatedContent.updatedAt
                                            );
                                            
                                            updatedCount++;
                                            renamedCount++;
                                            Logger.info(`Updated content after folder rename: ${rename.from} -> ${rename.to}`);
                                        } catch (error) {
                                            if (error instanceof AuthenticationError) {
                                                await handleAuthenticationError(error);
                                                return;
                                            }
                                            Logger.error(`Failed to process renamed content: ${rename.from} -> ${rename.to}`, error);
                                            errorCount++;
                                        }
                                    } else {
                                        // If content doesn't have an ID yet, use the original delete and create approach
                                        try {
                                            // Delete the old content - we don't have ID so this will be skipped
                                            // and we'll just create new content
                                            
                                            // Get the new content from the new location
                                            const newPath = path.join(this.workspacePath!, rename.to);
                                            const newFolder = path.dirname(newPath);
                                            const jsonPath = path.join(newFolder, 'index.json');
                                            
                                            // Skip if JSON file doesn't exist at new location
                                            if (!await fs.pathExists(jsonPath)) {
                                                Logger.warn(`JSON file doesn't exist at new location: ${jsonPath}`);
                                                continue;
                                            }
                                            
                                            // Read content and metadata
                                            const mdxContent = await fs.readFile(newPath, 'utf8');
                                            const metadataContent = await fs.readFile(jsonPath, 'utf8');
                                            let metadata = JSON.parse(metadataContent);
                                            
                                            // Add the slug and type from the folder structure
                                            metadata.slug = toSlug;
                                            metadata.type = toContentType;
                                            
                                            // Process MDX content to convert local media references back to API URLs
                                            const bodyContent = await this.mediaService.convertLocalMediaToApiRefs(mdxContent, toContentType, toSlug);
                                            
                                            // Also convert metadata media references to API URLs
                                            metadata = this.mediaService.convertMetadataMediaToApiRefs(metadata, toContentType, toSlug);
                                            
                                            // Create new content
                                            const createDto: ContentCreateDto = {
                                                title: metadata.title || '',
                                                description: metadata.description || '',
                                                body: bodyContent,
                                                slug: toSlug,
                                                type: toContentType,
                                                author: metadata.author || '',
                                                language: metadata.language || 'en',
                                                tags: metadata.tags || [],
                                                category: metadata.category || '',
                                                coverImageUrl: metadata.coverImageUrl || '',
                                                coverImageAlt: metadata.coverImageAlt || '',
                                                allowComments: metadata.allowComments === undefined ? true : metadata.allowComments,
                                                source: metadata.source || '',
                                                publishedAt: metadata.publishedAt || new Date().toISOString()
                                            };
                                            
                                            // Create the content
                                            const newContent = await this.apiService.createContent(createDto);
                                            
                                            // Update the local metadata with the new ID
                                            metadata.id = newContent.id;
                                            
                                            // Don't save unnecessary server timestamps locally
                                            delete metadata.slug;
                                            delete metadata.type;
                                            delete metadata.createdAt;
                                            delete metadata.updatedAt;
                                            delete metadata.comments;

                                            await fs.writeFile(jsonPath, JSON.stringify(metadata, null, 2), 'utf8');
                                            
                                            // Update the index with the new content
                                            await this.indexService.updateAfterPush(
                                                newContent.id,
                                                newPath,
                                                jsonPath,
                                                newContent.updatedAt
                                            );
                                            
                                            createdCount++;
                                            renamedCount++;
                                            Logger.info(`Recreated content after folder rename: ${rename.from} -> ${rename.to}`);
                                        } catch (error) {
                                            if (error instanceof AuthenticationError) {
                                                await handleAuthenticationError(error);
                                                return;
                                            }
                                            Logger.error(`Failed to process renamed content: ${rename.from} -> ${rename.to}`, error);
                                            errorCount++;
                                        }
                                    }
                                } else {
                                    // Same content type and slug - might be a file rename not requiring API action
                                    Logger.info(`Skipping content rename with same type/slug: ${rename.from} -> ${rename.to}`);
                                }
                            }
                        }
                        
                        // Mark this rename as processed
                        processedRenames.set(rename.from, true);
                    }
                } catch (error) {
                    if (error instanceof AuthenticationError) {
                        await handleAuthenticationError(error);
                        return;
                    }
                    Logger.error(`Failed to process renamed file: ${rename.from} -> ${rename.to}`, error);
                    errorCount++;
                }
            }

            // Process modified content files
            const contentRootDir = path.join(this.workspacePath!, 'content');
            
            // First, upload any new or modified media files
            Logger.info('Processing media files...');
            const mediaFiles = await this.findMediaFiles(contentRootDir, changes);
            
            // Try to authenticate once if needed
            let authenticatedForMedia = false;
            
            for (const mediaPath of mediaFiles) {
                try {
                    // Check if media file is new or modified
                    const relativePath = this.indexService.toRelativePath(mediaPath);
                    const entry = this.indexService.getEntryByPath(relativePath);
                    
                    // Skip if already processed through rename operation
                    const isProcessedRename = Array.from(processedRenames.keys()).some(from => {
                        const to = changes.renamed.find(r => r.from === from)?.to;
                        return to && to === relativePath;
                    });
                    
                    if (isProcessedRename) {
                        Logger.info(`Skipping media file already processed through rename: ${relativePath}`);
                        continue;
                    }
                    
                    // If file is new or modified, upload it
                    if (!entry || 
                        entry.status === FileStatus.NEW || 
                        entry.status === FileStatus.MODIFIED ||
                        entry.status === FileStatus.RENAMED) { // Added RENAMED status check
                        
                        try {
                            // Upload media file
                            const url = await this.mediaService.uploadMediaFile(mediaPath);
                            
                            // Extract necessary details for adding to index
                            const contentInfo = this.mediaService.extractContentInfoFromPath(mediaPath);
                            if (contentInfo) {
                                // Check that url is a string
                                if (typeof url !== 'string') {
                                    throw new Error(`Invalid URL returned from media upload: ${typeof url}, value: ${JSON.stringify(url)}`);
                                }
                                
                                // Extract media ID from URL if possible
                                const urlParts = url.split('/');
                                const mediaId = urlParts[urlParts.length - 1] || url;
                                
                                // Add to index
                                await this.indexService.addMediaEntry(
                                    mediaId, 
                                    url, 
                                    mediaPath
                                );
                                
                                mediaUploadCount++;
                            }
                        } catch (uploadError) {
                            // Handle authentication errors specially
                            if (uploadError instanceof AuthenticationError) {
                                if (!authenticatedForMedia) {
                                    // Try to authenticate once
                                    await handleAuthenticationError(uploadError);
                                    authenticatedForMedia = true;
                                    // Skip this file for now - will be handled in next push
                                } else {
                                    // Already tried to authenticate, stop processing
                                    Logger.error('Authentication failed after retry, stopping media uploads');
                                    throw uploadError;
                                }
                            } else {
                                // Log non-auth errors and continue with other files
                                Logger.error(`Failed to upload media file ${mediaPath}:`, uploadError);
                                errorCount++;
                            }
                        }
                    }
                } catch (error) {
                    // This catches errors in entry lookup/processing but not media upload
                    if (error instanceof AuthenticationError) {
                        // If this is from a re-throw above, stop processing
                        await handleAuthenticationError(error);
                        return;
                    }
                    
                    Logger.error(`Failed to process media file ${mediaPath}:`, error);
                    errorCount++;
                }
            }
            
            // Process new and modified content
            Logger.info(`Processing content modifications...`);
            
            // Try to authenticate once if needed
            let authenticatedForContent = false;
            
            const contentTypes = await fs.readdir(contentRootDir);
            
            for (const type of contentTypes) {
                const typeDir = path.join(contentRootDir, type);
                const stats = await fs.stat(typeDir);
                
                if (!stats.isDirectory()) {
                    continue;
                }
                
                // Get all slug folders in this content type
                const slugFolders = await fs.readdir(typeDir);
                
                for (const slug of slugFolders) {
                    const slugDir = path.join(typeDir, slug);
                    
                    // Check if it's a directory
                    if (!(await fs.stat(slugDir)).isDirectory()) {
                        continue;
                    }
                    
                    const mdxPath = path.join(slugDir, 'index.mdx');
                    const jsonPath = path.join(slugDir, 'index.json');
                    
                    // Skip if either file doesn't exist
                    if (!await fs.pathExists(mdxPath) || !await fs.pathExists(jsonPath)) {
                        Logger.warn(`Skipping incomplete content in ${slugDir}, missing index.mdx or index.json`);
                        continue;
                    }
                    
                    try {
                        // Get relative paths for index lookups
                        const mdxRelPath = this.indexService.toRelativePath(mdxPath);
                        const jsonRelPath = this.indexService.toRelativePath(jsonPath);
                        
                        // Get entries from index
                        const mdxEntry = this.indexService.getEntryByPath(mdxRelPath);
                        const jsonEntry = this.indexService.getEntryByPath(jsonRelPath);
                        
                        // Skip if neither file is new or modified
                        if ((mdxEntry && mdxEntry.status !== FileStatus.NEW && 
                             mdxEntry.status !== FileStatus.MODIFIED) &&
                            (jsonEntry && jsonEntry.status !== FileStatus.NEW && 
                             jsonEntry.status !== FileStatus.MODIFIED)) {
                            continue;
                        }
                        
                        // Read content and metadata
                        const metadataContent = await fs.readFile(jsonPath, 'utf8');
                        let metadata = JSON.parse(metadataContent);
                        
                        // Add the slug from the folder name
                        metadata.slug = slug;
                        metadata.type = type;
                        
                        // Process MDX content to convert local media references back to API URLs
                        let bodyContent = await fs.readFile(mdxPath, 'utf8');
                        bodyContent = await this.mediaService.convertLocalMediaToApiRefs(bodyContent, type, slug);
                        
                        // Also convert metadata media references to API URLs
                        metadata = this.mediaService.convertMetadataMediaToApiRefs(metadata, type, slug);
                        
                        if (metadata.id) {
                            try {
                                // Update existing content
                                const updateDto: ContentUpdateDto = {
                                    title: metadata.title,
                                    description: metadata.description,
                                    body: bodyContent,
                                    slug: slug,
                                    type: type,
                                    author: metadata.author || '',
                                    language: metadata.language || 'en',
                                    tags: metadata.tags || [],
                                    category: metadata.category || '',
                                    coverImageUrl: metadata.coverImageUrl || '',
                                    coverImageAlt: metadata.coverImageAlt || '',
                                    allowComments: metadata.allowComments === undefined ? true : metadata.allowComments,
                                    source: metadata.source || '',
                                    publishedAt: metadata.publishedAt || new Date().toISOString()
                                };
                                
                                const updatedContent = await this.apiService.updateContent(metadata.id, updateDto);
                                
                                // Update the index with the new state
                                await this.indexService.updateAfterPush(
                                    updatedContent.id,
                                    mdxPath,
                                    jsonPath,
                                    updatedContent.updatedAt
                                );
                                
                                // Update the local metadata with the new state
                                metadata.id = updatedContent.id;
                                // Remove server timestamps that aren't needed locally
                                delete metadata.slug;
                                delete metadata.type;
                                delete metadata.createdAt;
                                delete metadata.updatedAt;
                                delete metadata.comments;

                                await fs.writeFile(jsonPath, JSON.stringify(metadata, null, 2), 'utf8');
                                
                                updatedCount++;
                            } catch (updateError) {
                                // Handle authentication errors specially
                                if (updateError instanceof AuthenticationError) {
                                    if (!authenticatedForContent) {
                                        // Try to authenticate once
                                        await handleAuthenticationError(updateError);
                                        authenticatedForContent = true;
                                        // Skip this content for now
                                    } else {
                                        // Already tried to authenticate, stop processing
                                        throw updateError;
                                    }
                                } else {
                                    // Re-throw other errors to be caught by the outer catch
                                    throw updateError;
                                }
                            }
                        } else {
                            try {
                                // Create new content
                                const createDto: ContentCreateDto = {
                                    title: metadata.title || '',
                                    description: metadata.description || '',
                                    body: bodyContent,
                                    slug: slug,
                                    type: type,
                                    author: metadata.author || '',
                                    language: metadata.language || 'en',
                                    tags: metadata.tags || [],
                                    category: metadata.category || '',
                                    coverImageUrl: metadata.coverImageUrl || '',
                                    coverImageAlt: metadata.coverImageAlt || '',
                                    allowComments: metadata.allowComments === undefined ? true : metadata.allowComments,
                                    source: metadata.source || '',
                                    publishedAt: metadata.publishedAt || new Date().toISOString()
                                };
                                
                                // Log the content payload before sending to API
                                Logger.info(`Creating content for ${slug} - Title: ${createDto.title}, ` +
                                    `Description: ${createDto.description?.substring(0, 100) + (createDto.description?.length ?? 0 > 100 ? '...' : '')}, ` +
                                    `Body length: ${createDto.body?.length || 0}, ` +
                                    `Body preview: ${createDto.body?.substring(0, 100) + (createDto.body?.length ?? 0 > 100 ? '...' : '')}, ` +
                                    `Slug: ${createDto.slug}, Type: ${createDto.type}, ` +
                                    `Cover image: ${createDto.coverImageUrl || 'none'}, ` +
                                    `Cover image alt: ${createDto.coverImageAlt || 'none'}`);
                                
                                const newContent = await this.apiService.createContent(createDto);
                                
                                // Update the local metadata with the new ID
                                metadata.id = newContent.id;
                                
                                // Don't save server timestamps locally
                                delete metadata.slug;
                                delete metadata.type;
                                delete metadata.createdAt;
                                delete metadata.updatedAt;
                                delete metadata.comments;

                                await fs.writeFile(jsonPath, JSON.stringify(metadata, null, 2), 'utf8');
                                
                                // Update the index with the new content
                                await this.indexService.updateAfterPush(
                                    newContent.id,
                                    mdxPath,
                                    jsonPath,
                                    newContent.updatedAt
                                );
                                
                                createdCount++;
                            } catch (createError) {
                                // Handle authentication errors specially
                                if (createError instanceof AuthenticationError) {
                                    if (!authenticatedForContent) {
                                        // Try to authenticate once
                                        await handleAuthenticationError(createError);
                                        authenticatedForContent = true;
                                        // Skip this content for now
                                    } else {
                                        // Already tried to authenticate, stop processing
                                        throw createError;
                                    }
                                } else {
                                    // Re-throw other errors to be caught by the outer catch
                                    throw createError;
                                }
                            }
                        }
                    } catch (error) {
                        // Handle errors in the processing logic or re-thrown errors from above
                        if (error instanceof AuthenticationError) {
                            // If this is from a re-throw above, stop processing
                            await handleAuthenticationError(error);
                            return;
                        }
                        
                        Logger.error(`Failed to process content at ${slugDir}:`, error);
                        errorCount++;
                    }
                }
            }
            
            // Create summary message
            let message = '';
            if (createdCount > 0) {
                message += `Created: ${createdCount}. `;
            }
            if (updatedCount > 0) {
                message += `Updated: ${updatedCount}. `;
            }
            if (deletedCount > 0) {
                message += `Deleted: ${deletedCount}. `;
            }
            if (renamedCount > 0) {
                message += `Renamed: ${renamedCount}. `;
            }
            if (mediaUploadCount > 0) {
                message += `Media uploaded: ${mediaUploadCount}. `;
            }
            if (errorCount > 0) {
                message += `Errors: ${errorCount}. `;
            }
            
            if (message === '') {
                message = 'No changes to push.';
            } else {
                message = 'Push complete. ' + message;
            }
            
            vscode.window.showInformationMessage(message);
        } catch (error) {
            // Use the API error handler
            if (error instanceof AuthenticationError) {
                await handleAuthenticationError(error);
                return;
            } else {
                // Check if it's a validation error from API
                const apiError = ApiErrorHandler.parseErrorResponse(error);
                if (apiError && apiError.errors) {
                    const instructions = ApiErrorHandler.getValidationInstructions(error);
                    Logger.error(`Content validation failed: ${apiError.title}`);
                    await vscode.window.showErrorMessage(
                        `Content validation failed: ${apiError.title}`,
                        { modal: true, detail: instructions }
                    );
                } else {
                    // Display additional info for content validation errors
                    if (error instanceof Error && error.message.includes('Content validation failed (HTTP 406)')) {
                        const logDir = Logger.getLogsDirectory() || path.join(os.homedir(), '.vscode', 'extensions', 'logs');
                        const logPath = path.join(logDir, 'content-payloads.log');
                        Logger.info(`Content validation error occurred. Check the log file for complete content payload: ${logPath}`);
                    }
                    
                    Logger.error('Failed to push content:', error);
                    showErrorWithDetails('Failed to push content', error);
                }
            }
        }
    }
    
    /**
     * Find all media files in the content directory
     * @param contentRoot Root directory of content
     * @param changes Optional change report to include renamed files
     */
    private async findMediaFiles(contentRoot: string, changes?: ChangeReport): Promise<string[]> {
        const mediaFiles: string[] = [];
        
        // Walk content directory for media files
        const walk = async (dir: string) => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                
                if (entry.isDirectory()) {
                    // Skip node_modules and other special folders
                    if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
                        await walk(fullPath);
                    }
                } else {
                    // Check if it's a media file (image, video, etc.) based on extension
                    const extension = path.extname(entry.name).toLowerCase();
                    if (['.jpg', '.jpeg', '.png', '.gif', '.svg', '.mp4', '.webp', '.pdf'].includes(extension)) {
                        // Ensure it's in a proper content folder structure (not in root)
                        if (fullPath.includes(path.join('content', path.sep))) {
                            mediaFiles.push(fullPath);
                        }
                    }
                }
            }
        };
        
        await walk(contentRoot);
        
        // If changes are provided, add renamed files to the list
        if (changes && changes.renamed.length > 0) {
            for (const rename of changes.renamed) {
                // Check if this is a media file
                const extension = path.extname(rename.to).toLowerCase();
                if (['.jpg', '.jpeg', '.png', '.gif', '.svg', '.mp4', '.webp', '.pdf'].includes(extension)) {
                    const fullPath = path.join(this.workspacePath!, rename.to);
                    
                    // Avoid duplicates
                    if (!mediaFiles.includes(fullPath)) {
                        mediaFiles.push(fullPath);
                    }
                }
            }
        }
        
        return mediaFiles;
    }

    // Add a new method to show changes
    public async showChanges(): Promise<void> {
        this.ensureWorkspaceExists();
        
        try {
            // Refresh local changes first
            await this.indexService.checkLocalChanges();
            
            // Get the list of changes
            const changes = await this.indexService.getPendingChanges();
            
            // Format changes for display
            let changeMessage = '';
            
            if (changes.new.length > 0) {
                changeMessage += `New files (${changes.new.length}):\n`;
                changes.new.forEach(file => {
                    changeMessage += `  - ${file}\n`;
                });
                changeMessage += '\n';
            }
            
            if (changes.modified.length > 0) {
                changeMessage += `Modified files (${changes.modified.length}):\n`;
                changes.modified.forEach(file => {
                    changeMessage += `  - ${file}\n`;
                });
                changeMessage += '\n';
            }
            
            if (changes.deleted.length > 0) {
                changeMessage += `Deleted files (${changes.deleted.length}):\n`;
                changes.deleted.forEach(file => {
                    changeMessage += `  - ${file}\n`;
                });
                changeMessage += '\n';
            }
            
            if (changes.renamed.length > 0) {
                changeMessage += `Renamed files (${changes.renamed.length}):\n`;
                changes.renamed.forEach(rename => {
                    changeMessage += `  - ${rename.from} → ${rename.to}\n`;
                });
                changeMessage += '\n';
            }
            
            if (changes.conflict.length > 0) {
                changeMessage += `Files with conflicts (${changes.conflict.length}):\n`;
                changes.conflict.forEach(file => {
                    changeMessage += `  - ${file}\n`;
                });
            }
            
            if (changeMessage === '') {
                changeMessage = 'No changes detected. Workspace is in sync with the CMS.';
            }
            
            // Show the changes in an output channel
            const outputChannel = vscode.window.createOutputChannel('OnlineSales Changes');
            outputChannel.clear();
            outputChannel.appendLine(changeMessage);
            outputChannel.show();
        } catch (error) {
            Logger.error('Failed to show changes:', error);
            showErrorWithDetails('Failed to show changes', error);
        }
    }
}
