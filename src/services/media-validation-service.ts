import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import { MediaService } from './media-service';
import { Logger } from '../utils/logger';

/**
 * Service to validate media references in content files
 */
export class MediaValidationService {
    private diagnosticCollection: vscode.DiagnosticCollection;

    constructor(
        private workspacePath: string | undefined,
        private mediaService: MediaService
    ) {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('media-validation');
    }

    /**
     * Validates all media references in the workspace
     */
    public async validateAllMediaReferences(): Promise<number> {
        if (!this.workspacePath) {
            Logger.error('No workspace path available for media validation');
            return 0;
        }

        // Clear previous diagnostics
        this.diagnosticCollection.clear();
        
        try {
            const contentPath = path.join(this.workspacePath, 'content');
            if (!await fs.pathExists(contentPath)) {
                Logger.info('Content directory does not exist, skipping media validation');
                return 0;
            }

            // Find all MDX and JSON files
            const mdxFiles = await this.findFilesWithExtension(contentPath, '.mdx');
            const jsonFiles = await this.findFilesWithExtension(contentPath, '.json');
            
            Logger.info(`Found ${mdxFiles.length} MDX files and ${jsonFiles.length} JSON files to validate`);
            
            // Count of problems found
            let problemCount = 0;
            
            // Validate MDX files
            for (const file of mdxFiles) {
                const fileProblems = await this.validateMdxFile(file);
                problemCount += fileProblems;
            }
            
            // Validate JSON files
            for (const file of jsonFiles) {
                const fileProblems = await this.validateJsonFile(file);
                problemCount += fileProblems;
            }
            
            Logger.info(`Media validation complete. Found ${problemCount} missing media references.`);
            return problemCount;
        } catch (error) {
            Logger.error('Error validating media references:', error);
            return 0;
        }
    }

    /**
     * Validates media references in a single MDX file
     */
    private async validateMdxFile(filePath: string): Promise<number> {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const mediaUrls = this.mediaService.extractMediaUrls(content);
            
            if (mediaUrls.length === 0) {
                return 0; // No media references found
            }
            
            // Get content info from the file path
            const pathInfo = this.extractContentInfoFromPath(filePath);
            if (!pathInfo || !pathInfo.contentType || !pathInfo.slug) {
                return 0; // Can't determine content type/slug
            }
            
            return await this.validateMediaReferences(filePath, content, mediaUrls, pathInfo.contentType, pathInfo.slug);
        } catch (error) {
            Logger.error(`Error validating MDX file ${filePath}:`, error);
            return 0;
        }
    }

    /**
     * Validates media references in a single JSON file
     */
    private async validateJsonFile(filePath: string): Promise<number> {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            let metadata: any;
            
            try {
                metadata = JSON.parse(content);
            } catch (jsonError) {
                // Skip files that aren't valid JSON
                return 0;
            }
            
            const mediaUrls = this.mediaService.extractMediaUrlsFromMetadata(metadata);
            
            if (mediaUrls.length === 0) {
                return 0; // No media references found
            }
            
            // Get content info from the file path
            const pathInfo = this.extractContentInfoFromPath(filePath);
            if (!pathInfo || !pathInfo.contentType || !pathInfo.slug) {
                return 0; // Can't determine content type/slug
            }
            
            return await this.validateMediaReferences(filePath, content, mediaUrls, pathInfo.contentType, pathInfo.slug);
        } catch (error) {
            Logger.error(`Error validating JSON file ${filePath}:`, error);
            return 0;
        }
    }

    /**
     * Validates media references and reports problems
     */
    private async validateMediaReferences(
        filePath: string, 
        content: string, 
        mediaUrls: string[], 
        contentType: string, 
        slug: string
    ): Promise<number> {
        let problemCount = 0;
        const diagnostics: vscode.Diagnostic[] = [];
        
        for (const url of mediaUrls) {
            // Check if it's a full URL or just a filename
            if (url.startsWith('http')) {
                // Skip external URLs - we can't validate these
                continue;
            }
            
            // Determine the local file path
            let localFilePath: string;
            
            if (url.includes('/api/media/')) {
                // It's an API URL, extract the filename
                const fileName = path.basename(url);
                localFilePath = path.join(this.workspacePath!, 'content', contentType, slug, fileName);
            } else {
                // It's already a local path or filename
                if (path.isAbsolute(url)) {
                    localFilePath = url;
                } else {
                    localFilePath = path.join(this.workspacePath!, 'content', contentType, slug, url);
                }
            }
            
            // Check if the file exists
            if (!await fs.pathExists(localFilePath)) {
                problemCount++;
                
                // Find the position of the reference in the content
                const range = this.findReferenceRange(content, url);
                
                // Create a diagnostic
                const diagnostic = new vscode.Diagnostic(
                    range,
                    `Media file not found: ${path.basename(localFilePath)}`,
                    vscode.DiagnosticSeverity.Warning
                );
                
                diagnostics.push(diagnostic);
            }
        }
        
        // Add diagnostics to the collection
        if (diagnostics.length > 0) {
            this.diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics);
        }
        
        return problemCount;
    }

    /**
     * Finds the range of a reference in the content
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
     * Recursively finds all files with a specific extension
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

    /**
     * Extract content type and slug from a file path
     */
    private extractContentInfoFromPath(filePath: string): { contentType?: string, slug?: string } | null {
        // Expected path: <workspace>/content/<type>/<slug>/index.mdx (or index.json)
        // Or for media: <workspace>/content/<type>/<slug>/<filename>
        
        const relativePath = path.relative(this.workspacePath || '', filePath);
        const pathParts = relativePath.split(path.sep);
        
        // Check if this is in the content directory
        if (pathParts.length >= 3 && pathParts[0] === 'content') {
            const contentType = pathParts[1];
            const slug = pathParts[2];
            return { contentType, slug };
        }
        
        return null;
    }

    /**
     * Validates media references in a single file
     */
    public async validateSingleFile(filePath: string): Promise<number> {
        if (!filePath.endsWith('.mdx') && !filePath.endsWith('.json')) {
            return 0;
        }
        
        if (filePath.endsWith('.mdx')) {
            return await this.validateMdxFile(filePath);
        } else {
            return await this.validateJsonFile(filePath);
        }
    }
}
