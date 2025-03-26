import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { MediaService } from '../services/media-service';
import { ApiService } from '../services/api-service';
import { ConfigService } from '../services/config-service';
import { Validator, ValidationResult, ValidationProblem, ValidationSeverity } from './validator';

/**
 * Validator for media references in content files
 */
export class MediaValidator implements Validator {
    public readonly id = 'media';
    public readonly displayName = 'Media References Validator';
    
    private workspacePath: string | undefined;
    private mediaService: MediaService;
    private apiService: ApiService;
    
    constructor(workspacePath: string | undefined) {
        this.workspacePath = workspacePath;
        const configService = new ConfigService();
        this.apiService = new ApiService(configService);
        this.mediaService = new MediaService(this.apiService);
    }
    
    /**
     * Validate a single file for media references
     */
    public async validateFile(filePath: string): Promise<ValidationResult> {
        const problems: ValidationProblem[] = [];
        
        if (!this.workspacePath) {
            return { problems };
        }
        
        try {
            if (filePath.endsWith('.mdx')) {
                const content = await fs.readFile(filePath, 'utf8');
                const mediaUrls = this.mediaService.extractMediaUrls(content);
                
                if (mediaUrls.length > 0) {
                    const pathInfo = this.extractContentInfoFromPath(filePath);
                    if (pathInfo?.contentType && pathInfo?.slug) {
                        await this.validateMediaReferences(
                            filePath, 
                            content, 
                            mediaUrls, 
                            pathInfo.contentType, 
                            pathInfo.slug,
                            problems
                        );
                    }
                }
            } else if (filePath.endsWith('.json')) {
                const content = await fs.readFile(filePath, 'utf8');
                try {
                    const metadata = JSON.parse(content);
                    const mediaUrls = this.mediaService.extractMediaUrlsFromMetadata(metadata);
                    
                    if (mediaUrls.length > 0) {
                        const pathInfo = this.extractContentInfoFromPath(filePath);
                        if (pathInfo?.contentType && pathInfo?.slug) {
                            await this.validateMediaReferences(
                                filePath, 
                                content, 
                                mediaUrls, 
                                pathInfo.contentType, 
                                pathInfo.slug,
                                problems
                            );
                        }
                    }
                } catch (jsonError) {
                    // Skip invalid JSON files
                }
            }
        } catch (error) {
            Logger.error(`Error validating media in file ${filePath}:`, error);
        }
        
        return { problems };
    }
    
    /**
     * Validate all content files in the workspace for media references
     */
    public async validateAll(): Promise<ValidationResult> {
        const problems: ValidationProblem[] = [];
        
        if (!this.workspacePath) {
            return { problems };
        }
        
        try {
            const contentPath = path.join(this.workspacePath, 'content');
            if (!await fs.pathExists(contentPath)) {
                return { problems };
            }
            
            // Find all MDX and JSON files
            const mdxFiles = await this.findFilesWithExtension(contentPath, '.mdx');
            const jsonFiles = await this.findFilesWithExtension(contentPath, '.json');
            
            Logger.info(`Found ${mdxFiles.length} MDX files and ${jsonFiles.length} JSON files for media validation`);
            
            // Validate each MDX file
            for (const file of mdxFiles) {
                const fileResult = await this.validateFile(file);
                problems.push(...fileResult.problems);
            }
            
            // Validate each JSON file
            for (const file of jsonFiles) {
                const fileResult = await this.validateFile(file);
                problems.push(...fileResult.problems);
            }
        } catch (error) {
            Logger.error('Error validating media references:', error);
        }
        
        return { problems };
    }
    
    /**
     * Validate media references in content
     */
    private async validateMediaReferences(
        filePath: string, 
        content: string, 
        mediaUrls: string[], 
        contentType: string, 
        slug: string,
        problems: ValidationProblem[]
    ): Promise<void> {
        for (const url of mediaUrls) {
            // Skip external URLs
            if (url.startsWith('http')) {
                continue;
            }
            
            // Determine local file path
            let localFilePath: string;
            
            if (url.includes('/api/media/')) {
                const fileName = path.basename(url);
                localFilePath = path.join(this.workspacePath!, 'content', contentType, slug, fileName);
            } else {
                if (path.isAbsolute(url)) {
                    localFilePath = url;
                } else {
                    localFilePath = path.join(this.workspacePath!, 'content', contentType, slug, url);
                }
            }
            
            // Check if file exists
            if (!await fs.pathExists(localFilePath)) {
                const range = this.findReferenceRange(content, url);
                
                problems.push({
                    filePath,
                    message: `Media file not found: ${path.basename(localFilePath)}`,
                    range,
                    severity: ValidationSeverity.Warning,
                    source: 'OnlineSales'
                });
            }
        }
    }
    
    /**
     * Find the range of a reference in content
     */
    private findReferenceRange(content: string, reference: string): vscode.Range {
        const fileName = path.basename(reference);
        const index = content.indexOf(fileName);
        
        if (index >= 0) {
            const line = content.substring(0, index).split('\n').length - 1;
            const character = index - content.lastIndexOf('\n', index) - 1;
            
            return new vscode.Range(
                new vscode.Position(line, Math.max(0, character)),
                new vscode.Position(line, character + fileName.length)
            );
        }
        
        // If not found, use the first line
        return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    }
    
    /**
     * Extract content type and slug from file path
     */
    private extractContentInfoFromPath(filePath: string): { contentType?: string, slug?: string } | null {
        const relativePath = path.relative(this.workspacePath || '', filePath);
        const pathParts = relativePath.split(path.sep);
        
        if (pathParts.length >= 3 && pathParts[0] === 'content') {
            const contentType = pathParts[1];
            const slug = pathParts[2];
            return { contentType, slug };
        }
        
        return null;
    }
    
    /**
     * Find files with specific extension recursively
     */
    private async findFilesWithExtension(dirPath: string, extension: string): Promise<string[]> {
        const result: string[] = [];
        
        const items = await fs.readdir(dirPath);
        
        for (const item of items) {
            const itemPath = path.join(dirPath, item);
            const stats = await fs.stat(itemPath);
            
            if (stats.isDirectory()) {
                const subDirFiles = await this.findFilesWithExtension(itemPath, extension);
                result.push(...subDirFiles);
            } else if (stats.isFile() && itemPath.endsWith(extension)) {
                result.push(itemPath);
            }
        }
        
        return result;
    }
}
