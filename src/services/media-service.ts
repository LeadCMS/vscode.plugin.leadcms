import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import axios from 'axios';
import { ApiService } from './api-service';
import { ConfigService } from './config-service';
import { Logger } from '../utils/logger';
import { replaceMediaReferencesInMetadata } from '../utils/mdx-utils';

export class MediaService {
    private workspacePath: string | undefined;
    private apiService: ApiService;
    private configService: ConfigService;
    
    constructor(apiService: ApiService) {
        this.apiService = apiService;
        this.configService = apiService.getConfigService();
        this.initialize();
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

    /**
     * Uploads a media file from a content folder to API
     */
    public async uploadMediaFile(filePath: string): Promise<string> {
        this.ensureWorkspaceExists();
        
        try {
            // Read the file
            const fileContent = await fs.readFile(filePath);
            const fileName = path.basename(filePath);
            
            // Extract content type and slug from path
            const contentInfo = this.extractContentInfoFromPath(filePath);
            if (!contentInfo || !contentInfo.contentType || !contentInfo.slug) {
                throw new Error(`Unable to determine content type and slug for media file: ${filePath}`);
            }
            
            // Create scope in format "type/slug"
            const scopeUid = `${contentInfo.contentType}/${contentInfo.slug}`;
            
            // Upload to API with proper scope
            const response = await this.apiService.uploadMedia(fileContent, fileName, scopeUid);
            
            // Handle response which could be a string URL or an object with location property
            let url: string;
            if (typeof response === 'string') {
                url = response;
            } else if (response && typeof response === 'object' && typeof response.location === 'string') {
                url = response.location;
            } else {
                throw new Error(`Invalid response from media upload. Expected string URL or object with location property, got: ${typeof response}, value: ${JSON.stringify(response)}`);
            }
            
            Logger.info(`Uploaded media file ${fileName} for content ${scopeUid}, URL: ${url}`);
            
            return url;
        } catch (error) {
            Logger.error('Failed to upload media file:', error);
            throw error;
        }
    }
    
    /**
     * Get list of all media files across all content folders
     */
    public async getAllMedia(): Promise<string[]> {
        this.ensureWorkspaceExists();
        
        const contentDir = path.join(this.workspacePath!, 'content');
        const mediaFiles: string[] = [];
        
        try {
            // Ensure content directory exists
            await fs.ensureDir(contentDir);
            
            // Get all content types (subdirectories of content/)
            const contentTypes = await fs.readdir(contentDir);
            
            // For each content type directory
            for (const contentType of contentTypes) {
                const contentTypePath = path.join(contentDir, contentType);
                
                // Skip if not a directory
                const contentTypeStat = await fs.stat(contentTypePath);
                if (!contentTypeStat.isDirectory()) {
                    continue;
                }
                
                // Get all slugs (subdirectories of the content type)
                const slugs = await fs.readdir(contentTypePath);
                
                // For each slug directory
                for (const slug of slugs) {
                    const slugPath = path.join(contentTypePath, slug);
                    
                    // Skip if not a directory
                    const slugStat = await fs.stat(slugPath);
                    if (!slugStat.isDirectory()) {
                        continue;
                    }
                    
                    // Get all files in the slug directory
                    const files = await fs.readdir(slugPath);
                    
                    // Find media files (not index.mdx or index.json)
                    for (const file of files) {
                        if (file !== 'index.mdx' && file !== 'index.json') {
                            const filePath = path.join(slugPath, file);
                            const fileStat = await fs.stat(filePath);
                            
                            // If it's a file and has a media extension
                            if (fileStat.isFile() && this.isMediaFile(filePath)) {
                                mediaFiles.push(filePath);
                            }
                        }
                    }
                }
            }
            
            return mediaFiles;
        } catch (error) {
            Logger.error('Failed to get media files:', error);
            throw error;
        }
    }

    /**
     * Downloads media from a URL and saves it to the appropriate content folder
     */
    public async downloadMediaFromUrl(mediaUrl: string, contentType?: string, contentSlug?: string): Promise<string> {
        this.ensureWorkspaceExists();
        
        try {
            // Clean up the URL to remove any surrounding characters that might make it invalid
            mediaUrl = this.sanitizeUrl(mediaUrl, false);
            
            // Get domain from config for URL parsing
            const config = await this.configService.getConfig();
            if (!config || !config.domain) {
                throw new Error('Domain configuration not found');
            }
            
            // Extract the path components from the URL
            let parsedUrl: URL;
            try {
                if (mediaUrl.startsWith('http')) {
                    parsedUrl = new URL(mediaUrl);
                } else {
                    // Use the configured domain
                    parsedUrl = new URL(`${config.domain}${mediaUrl}`);
                }
            } catch (urlError) {
                Logger.warn(`Failed to parse URL "${mediaUrl}", attempting to sanitize further`, urlError);
                
                // Try to repair the URL by removing potentially problematic characters
                mediaUrl = mediaUrl.replace(/[()\[\]{}]/g, '');
                
                if (mediaUrl.startsWith('http')) {
                    parsedUrl = new URL(mediaUrl);
                } else {
                    parsedUrl = new URL(`${config.domain}${mediaUrl}`);
                }
            }
            
            // Parse the path segments
            const pathParts = parsedUrl.pathname.split('/').filter(part => part.trim() !== '');
            
            // Extract filename
            let fileName = '';
            
            if (pathParts.length >= 3 && pathParts[0] === 'api' && pathParts[1] === 'media') {
                fileName = pathParts[pathParts.length - 1];
            } else {
                // Fallback for URLs that don't match the expected pattern
                fileName = pathParts[pathParts.length - 1];
            }
            
            // Determine target directory based on provided content info
            let targetDir: string;
            
            if (contentType && contentSlug) {
                // If we know the content type and slug, store directly in content folder
                targetDir = path.join(this.workspacePath!, 'content', contentType, contentSlug);
            } else {
                // For backward compatibility or when content info is not available,
                // try to extract content info from URL
                let extractedType = '';
                let extractedSlug = '';
                
                // Try to parse content type and slug from URL if it follows API patterns
                if (pathParts.length >= 4 && pathParts[0] === 'api' && pathParts[1] === 'media') {
                    // Assume format is /api/media/[contentType]/[slug]/[filename]
                    // or /api/media/[slug]/[filename]
                    if (pathParts.length >= 5) {
                        extractedType = pathParts[2];
                        extractedSlug = pathParts[3];
                    } else {
                        // No content type in URL, just slug
                        extractedSlug = pathParts[2];
                    }
                }
                
                if (extractedType && extractedSlug) {
                    // If we could extract both, use them
                    targetDir = path.join(this.workspacePath!, 'content', extractedType, extractedSlug);
                } else if (extractedSlug) {
                    // If only slug, try to find matching content folder
                    const contentTypes = await this.getContentTypes();
                    let foundDir = '';
                    
                    for (const type of contentTypes) {
                        const possibleDir = path.join(this.workspacePath!, 'content', type, extractedSlug);
                        if (await fs.pathExists(possibleDir)) {
                            foundDir = possibleDir;
                            break;
                        }
                    }
                    
                    if (foundDir) {
                        targetDir = foundDir;
                    } else {
                        // Create a temporary directory in the first content type found
                        if (contentTypes.length > 0) {
                            // Use "media" slug in the first content type
                            targetDir = path.join(this.workspacePath!, 'content', contentTypes[0], 'media');
                            Logger.warn(`Couldn't determine content folder for media: ${mediaUrl}, using ${targetDir}`);
                        } else {
                            // No content types found, create "misc" content type with "media" slug
                            targetDir = path.join(this.workspacePath!, 'content', 'misc', 'media');
                            Logger.warn(`No content types found, creating folder for media: ${targetDir}`);
                        }
                    }
                } else {
                    // Unable to determine location, create a misc/media folder
                    targetDir = path.join(this.workspacePath!, 'content', 'misc', 'media');
                    Logger.warn(`Couldn't determine content folder for media: ${mediaUrl}, using ${targetDir}`);
                }
            }
            
            // Create the directory if it doesn't exist
            await fs.ensureDir(targetDir);
            
            // Determine the file path
            const filePath = path.join(targetDir, fileName);
            
            // Check if the file already exists
            if (await fs.pathExists(filePath)) {
                Logger.info(`Media file ${filePath} already exists, skipping download`);
                return filePath;
            }
            
            // Determine the full URL
            let fullUrl = mediaUrl;
            if (mediaUrl.startsWith('/api/')) {
                fullUrl = `${config.domain}${mediaUrl}`;
            }
            
            Logger.info(`Downloading media from ${fullUrl} to ${filePath}`);
            
            // Download the file
            const response = await axios.get(fullUrl, {
                responseType: 'arraybuffer',
                headers: {
                    'Accept': 'application/octet-stream'
                }
            });
            
            // Save the file
            await fs.writeFile(filePath, response.data);
            Logger.info(`Media file saved to ${filePath}`);
            
            return filePath;
        } catch (error) {
            Logger.error(`Failed to download media from ${mediaUrl}:`, error);
            throw error;
        }
    }

    /**
     * Sanitizes a URL to remove any surrounding characters that might make it invalid
     * @param url The URL to sanitize
     * @param verbose Whether to log details of the sanitization process
     * @returns The sanitized URL
     */
    private sanitizeUrl(url: string, verbose: boolean = false): string {
        if (verbose) {
            Logger.info(`Sanitizing URL: ${url}`);
        }
        
        // Remove leading/trailing whitespace
        url = url.trim();
        
        // Remove surrounding parentheses, braces, or brackets if they exist
        url = url.replace(/^\((.+)\)$/, '$1'); // Remove outer parentheses
        url = url.replace(/^\[(.+)\]$/, '$1'); // Remove outer brackets
        url = url.replace(/^\{(.+)\}$/, '$1'); // Remove outer braces
        
        // Remove formatting characters that might be part of markdown but not the actual URL
        url = url.replace(/[<>"']/g, '');
        
        // Ensure the URL starts correctly if it's a local URL
        if (url.includes('/api/media/') && !url.startsWith('/api/')) {
            const apiIndex = url.indexOf('/api/');
            if (apiIndex >= 0) {
                url = url.substring(apiIndex);
                if (verbose) {
                    Logger.info(`Fixed URL to start with /api/: ${url}`);
                }
            }
        } else if (url.includes('api/media/') && !url.startsWith('/api/') && !url.startsWith('http')) {
            // If URL has 'api/media' but not starting with '/api/', add the leading slash
            url = '/' + url;
            if (verbose) {
                Logger.info(`Added leading slash: ${url}`);
            }
        }
        
        if (verbose) {
            Logger.info(`Sanitized URL: ${url}`);
        }
        
        return url;
    }

    /**
     * Extracts media URLs from MDX content
     */
    public extractMediaUrls(content: string): string[] {
        if (!content) {
            Logger.info('Empty content provided to extractMediaUrls');
            return [];
        }

        Logger.info(`Analyzing content for media URLs (${content.length} characters)`);
        const mediaUrls: string[] = [];
        const foundUrls = new Set<string>(); // Track URLs to avoid duplicate logging
        
        // Regular expressions to match different types of media references - more relaxed patterns
        const patterns = [
            // Match markdown image syntax ![alt](url)
            /!\[.*?\]\((.*?api\/media\/[^)]*)\)/g,
            
            // Match HTML img tags <img src="url" ... />
            /<img[^>]*src=["'](.*?api\/media\/[^"']*?)["'][^>]*>/g,
            
            // Plain URL reference to media - more general pattern
            /(\/api\/media\/[^\s"')<>]*)/g,
            
            // Full URL pattern
            /(https?:\/\/.*?\/api\/media\/[^\s"')<>]*)/g
        ];
        
        let totalMatches = 0;
        
        for (const pattern of patterns) {
            let match;
            let patternMatches = 0;
            
            while ((match = pattern.exec(content)) !== null) {
                const url = match[1];
                patternMatches++;
                
                if (url && (url.includes('/api/media/') || url.includes('api/media/'))) {
                    // Only sanitize URLs silently (no logs) to reduce noise
                    const sanitizedUrl = this.sanitizeUrl(url, false);
                    
                    // Only log each unique URL once
                    if (!foundUrls.has(sanitizedUrl)) {
                        foundUrls.add(sanitizedUrl);
                        Logger.info(`Found media URL: ${sanitizedUrl}`);
                        mediaUrls.push(sanitizedUrl);
                    } else {
                        // Still push the URL to the result array but don't log it again
                        mediaUrls.push(sanitizedUrl);
                    }
                }
            }
            
            totalMatches += patternMatches;
        }
        
        // Log pattern summary instead of individual matches
        if (totalMatches > 0) {
            Logger.info(`Found ${totalMatches} total pattern matches`);
        }
        
        // Sample some of the content to help with debugging only if no URLs were found
        if (mediaUrls.length === 0 && content.length > 0) {
            const sample = content.substring(0, Math.min(200, content.length));
            Logger.info(`No media URLs found. Content sample: ${sample}...`);
            
            // Check if api/media exists in any form in the content
            if (content.includes('api/media')) {
                const index = content.indexOf('api/media');
                const context = content.substring(
                    Math.max(0, index - 30), 
                    Math.min(content.length, index + 50)
                );
                Logger.info(`Found 'api/media' mention at position ${index}. Context: ${context}`);
            }
        }
        
        const uniqueUrls = [...new Set(mediaUrls)]; // Remove duplicates
        Logger.info(`Found ${uniqueUrls.length} unique media URLs`);
        return uniqueUrls;
    }

    /**
     * Downloads all media files referenced in MDX content
     */
    public async downloadMediaFromMdx(content: string, contentType?: string, contentSlug?: string): Promise<Map<string, string>> {
        const mediaUrls = this.extractMediaUrls(content);
        const mediaMap = new Map<string, string>();
        
        Logger.info(`Found ${mediaUrls.length} media references in content`);
        
        for (const url of mediaUrls) {
            try {
                const localPath = await this.downloadMediaFromUrl(url, contentType, contentSlug);
                mediaMap.set(url, localPath);
            } catch (error) {
                Logger.error(`Failed to download media from ${url}:`, error);
                // Continue with other media files
            }
        }
        
        return mediaMap;
    }

    /**
     * Convert local media references back to API URLs for pushing to CMS
     */
    public async convertLocalMediaToApiRefs(content: string, contentType: string, slug: string): Promise<string> {
        if (!content) {
            return content;
        }
        
        let updatedContent = content;
        const contentDir = path.join(this.workspacePath!, 'content', contentType, slug);
        
        // Regular expression to find local media references
        const patterns = [
            // Image in markdown: ![alt](filename.jpg)
            /!\[.*?\]\(([^)]+)\)/g,
            
            // HTML img tag: <img src="filename.jpg" ... />
            /<img[^>]*src=["']([^"']+)["'][^>]*>/g
        ];
        
        for (const pattern of patterns) {
            updatedContent = updatedContent.replace(pattern, (match, filePath) => {
                // Skip URLs that already point to the API
                if (filePath.includes('/api/media/')) {
                    return match;
                }
                
                // Skip external URLs
                if (filePath.startsWith('http')) {
                    return match;
                }
                
                // Get just the filename if it's a full path
                const fileName = path.basename(filePath);
                
                // Create API URL - include contentType
                const apiUrl = `/api/media/${contentType}/${slug}/${fileName}`;
                
                // Replace the file path with API URL
                if (match.startsWith('![')) {
                    // Markdown image
                    return `![${match.substring(2, match.indexOf(']'))}](${apiUrl})`;
                } else {
                    // HTML img tag
                    return match.replace(filePath, apiUrl);
                }
            });
        }
        
        return updatedContent;
    }

    /**
     * Convert local media references in metadata back to API URLs
     * @param metadata The metadata object
     * @param contentType The content type for URL construction
     * @param slug The content slug for URL construction
     * @returns Updated metadata with API URLs
     */
    public convertMetadataMediaToApiRefs(
        metadata: any,
        contentType: string,
        slug: string
    ): any {
        if (!metadata || typeof metadata !== 'object') {
            return metadata;
        }
        
        // Create a copy to avoid mutating the original
        const result = {...metadata};
        
        // Only process coverImageUrl
        if (result.coverImageUrl && typeof result.coverImageUrl === 'string') {
            // Skip if it's already an API URL
            if (!result.coverImageUrl.includes('/api/media/')) {
                // It's a local filename, convert it to API URL
                const filename = path.basename(result.coverImageUrl);
                result.coverImageUrl = `/api/media/${contentType}/${slug}/${filename}`;
            }
        }
        
        return result;
    }

    /**
     * Get list of content types (folders under content/)
     */
    private async getContentTypes(): Promise<string[]> {
        try {
            const contentPath = path.join(this.workspacePath!, 'content');
            
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
     * Extracts media URLs from JSON metadata
     * @param metadata The JSON metadata object
     */
    public extractMediaUrlsFromMetadata(metadata: any): string[] {
        if (!metadata) {
            return [];
        }

        Logger.info('Analyzing metadata for media URLs');
        const mediaUrls: string[] = [];
        const foundUrls = new Set<string>(); // Track URLs to avoid duplicates
        
        // Helper function to recursively search for media URLs in objects
        const findMediaUrls = (obj: any) => {
            if (!obj || typeof obj !== 'object') {
                return;
            }
            
            // Handle arrays
            if (Array.isArray(obj)) {
                obj.forEach(item => findMediaUrls(item));
                return;
            }
            
            // Handle objects
            Object.entries(obj).forEach(([key, value]) => {
                // Check if property might contain a media URL
                if (typeof value === 'string' && 
                    (key === 'coverImageUrl' || key.includes('Url') || key.includes('Image')) && 
                    value.includes('/api/media/')) {
                    
                    const sanitizedUrl = this.sanitizeUrl(value, false);
                    
                    if (!foundUrls.has(sanitizedUrl)) {
                        foundUrls.add(sanitizedUrl);
                        mediaUrls.push(sanitizedUrl);
                        Logger.info(`Found media URL in metadata: ${sanitizedUrl}`);
                    }
                } 
                // Recursively search nested objects
                else if (value && typeof value === 'object') {
                    findMediaUrls(value);
                }
            });
        };
        
        findMediaUrls(metadata);
        Logger.info(`Found ${mediaUrls.length} media URLs in metadata`);
        return mediaUrls;
    }
    
    /**
     * Downloads all media files referenced in metadata
     * @param metadata The JSON metadata object
     * @param contentType The content type
     * @param contentSlug The content slug
     * @returns A tuple containing the map of remote URLs to local paths and the updated metadata
     */
    public async downloadMediaFromMetadata(
        metadata: any, 
        contentType?: string, 
        contentSlug?: string
    ): Promise<[Map<string, string>, any]> {
        if (!metadata) {
            return [new Map<string, string>(), metadata];
        }
        
        const mediaUrls = this.extractMediaUrlsFromMetadata(metadata);
        
        if (mediaUrls.length === 0) {
            return [new Map<string, string>(), metadata];
        }
        
        const mediaMap = await this.downloadMediaFiles(mediaUrls, contentType, contentSlug);
        
        // Transform the metadata to use the local file references
        const updatedMetadata = replaceMediaReferencesInMetadata(
            metadata,
            mediaMap,
            contentType,
            contentSlug
        );
        
        return [mediaMap, updatedMetadata];
    }
    
    /**
     * Download multiple media files from URLs
     * @param urls Array of media URLs to download
     * @param contentType The content type
     * @param contentSlug The content slug
     * @returns A map of remote URLs to local file paths
     */
    private async downloadMediaFiles(
        urls: string[],
        contentType?: string,
        contentSlug?: string
    ): Promise<Map<string, string>> {
        const mediaMap = new Map<string, string>();
        
        for (const url of urls) {
            try {
                const localPath = await this.downloadMediaFromUrl(url, contentType, contentSlug);
                mediaMap.set(url, localPath);
            } catch (error) {
                Logger.error(`Failed to download media from ${url}:`, error);
                // Continue with other media files
            }
        }
        
        return mediaMap;
    }
    
    /**
     * Check if a file is a media file by its extension
     */
    private isMediaFile(filePath: string): boolean {
        const mediaExtensions = [
            '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', 
            '.mp4', '.webm', '.mov', '.mp3', '.wav', '.pdf',
            '.ico', '.bmp', '.tiff', '.avif'
        ];
        
        const ext = path.extname(filePath).toLowerCase();
        return mediaExtensions.includes(ext);
    }
    
    /**
     * Extract content type and slug from a file path
     */
    public extractContentInfoFromPath(filePath: string): { contentType?: string, slug?: string } | null {
        try {
            const relativePath = path.relative(this.workspacePath!, filePath);
            const pathParts = relativePath.split(path.sep);
            
            // Check if this is a content file or media inside a content folder
            if (pathParts.length >= 3 && pathParts[0] === 'content') {
                return {
                    contentType: pathParts[1],
                    slug: pathParts[2]
                };
            }
            
            return null;
        } catch (error) {
            Logger.error(`Error extracting content info from path: ${error}`);
            return null;
        }
    }
}
