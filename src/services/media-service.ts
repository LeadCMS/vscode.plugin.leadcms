import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import axios from 'axios';
import { ApiService } from './api-service';
import { ConfigService } from './config-service';
import { Logger } from '../utils/logger';

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
     * Uploads a media file, preserving folder structure
     */
    public async uploadMediaFile(filePath: string): Promise<string> {
        this.ensureWorkspaceExists();
        
        try {
            // Read the file
            const fileContent = await fs.readFile(filePath);
            const fileName = path.basename(filePath);
            
            // Upload to API
            const url = await this.apiService.uploadMedia(fileContent, fileName);
            
            // Determine folder structure - get relative path if within workspace
            const mediaDir = path.join(this.workspacePath!, 'media');
            let relativePath = '';
            
            // Check if the file is within the workspace
            if (filePath.startsWith(this.workspacePath!)) {
                // Extract relative path within workspace
                relativePath = path.relative(this.workspacePath!, path.dirname(filePath));
                // Skip 'media' if it's already part of the path
                if (relativePath.startsWith('media')) {
                    relativePath = relativePath.substring(6); // 'media/'.length
                }
            }
            
            // Create the target directory structure
            const targetDir = relativePath 
                ? path.join(mediaDir, relativePath) 
                : mediaDir;
                
            await fs.ensureDir(targetDir);
            const destinationPath = path.join(targetDir, fileName);
            
            // Only copy if it's not already in the right location
            if (filePath !== destinationPath) {
                await fs.copy(filePath, destinationPath);
            }
            
            return url;
        } catch (error) {
            console.error('Failed to upload media file:', error);
            throw error;
        }
    }
    
    public async getAllMedia(): Promise<string[]> {
        this.ensureWorkspaceExists();
        
        const mediaDir = path.join(this.workspacePath!, 'media');
        
        try {
            await fs.ensureDir(mediaDir);
            const files = await fs.readdir(mediaDir);
            return files;
        } catch (error) {
            console.error('Failed to get media files:', error);
            throw error;
        }
    }

    /**
     * Downloads media from a URL and saves it to the media folder
     */
    public async downloadMediaFromUrl(mediaUrl: string): Promise<string> {
        this.ensureWorkspaceExists();
        
        try {
            // Clean up the URL to remove any surrounding characters that might make it invalid
            // Don't log the sanitization process to reduce noise
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
                    // Use the configured domain instead of placeholder.com
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
            
            // Handle /api/media/[folder]/[filename] structure
            let folderPath = '';
            let fileName = '';
            
            if (pathParts.length >= 3 && pathParts[0] === 'api' && pathParts[1] === 'media') {
                // Extract folder path (everything between 'media' and the filename)
                folderPath = pathParts.slice(2, pathParts.length - 1).join('/');
                fileName = pathParts[pathParts.length - 1];
            } else {
                // Fallback for URLs that don't match the expected pattern
                fileName = pathParts[pathParts.length - 1];
            }
            
            // Create the full media directory path including subdirectories
            const mediaDir = path.join(this.workspacePath!, 'media');
            const fullMediaDir = folderPath ? path.join(mediaDir, folderPath) : mediaDir;
            await fs.ensureDir(fullMediaDir);
            
            // Determine the file path with subdirectories preserved
            const filePath = path.join(fullMediaDir, fileName);
            
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
    public async downloadMediaFromMdx(content: string): Promise<Map<string, string>> {
        const mediaUrls = this.extractMediaUrls(content);
        const mediaMap = new Map<string, string>();
        
        Logger.info(`Found ${mediaUrls.length} media references in content`);
        
        for (const url of mediaUrls) {
            try {
                const localPath = await this.downloadMediaFromUrl(url);
                mediaMap.set(url, localPath);
            } catch (error) {
                Logger.error(`Failed to download media from ${url}:`, error);
                // Continue with other media files
            }
        }
        
        return mediaMap;
    }
}
