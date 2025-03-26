import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { Validator, ValidationResult, ValidationProblem, ValidationSeverity } from './validator';

/**
 * Validator for content structure and required fields
 */
export class ContentValidator implements Validator {
    public readonly id = 'content';
    public readonly displayName = 'Content Structure Validator';
    
    private workspacePath: string | undefined;
    
    constructor(workspacePath: string | undefined) {
        this.workspacePath = workspacePath;
    }
    
    /**
     * Validate a single file for content structure
     */
    public async validateFile(filePath: string): Promise<ValidationResult> {
        const problems: ValidationProblem[] = [];
        
        if (!this.workspacePath) {
            return { problems };
        }
        
        try {
            // We're only interested in validating JSON metadata files
            if (filePath.endsWith('.json') && path.basename(filePath) === 'index.json') {
                const content = await fs.readFile(filePath, 'utf8');
                let metadata: any;
                
                try {
                    metadata = JSON.parse(content);
                    
                    // Validate required fields
                    this.validateRequiredFields(metadata, filePath, problems);
                    
                    // Validate field formats
                    this.validateFieldFormats(metadata, filePath, problems);
                    
                    // Additional content-specific validations
                    this.validateContentType(metadata, filePath, problems);
                } catch (jsonError: any) {
                    // If JSON parsing fails, report as a problem
                    problems.push({
                        filePath,
                        message: `Invalid JSON format: ${jsonError.message}`,
                        range: this.findErrorPosition(content, jsonError),
                        severity: ValidationSeverity.Error,
                        source: 'Content Validator'
                    });
                }
            } else if (filePath.endsWith('.mdx')) {
                // Validate MDX content
                const content = await fs.readFile(filePath, 'utf8');
                
                // Check for minimum content length
                if (content.trim().length < 10) {
                    problems.push({
                        filePath,
                        message: 'Content appears to be empty or too short',
                        range: new vscode.Range(0, 0, 0, 0),
                        severity: ValidationSeverity.Warning,
                        source: 'Content Validator'
                    });
                }
                
                // Check for proper markdown structure (at least one heading)
                if (!content.match(/^#+ /m)) {
                    problems.push({
                        filePath,
                        message: 'Content should include at least one heading (# Title)',
                        range: new vscode.Range(0, 0, 0, 0),
                        severity: ValidationSeverity.Warning,
                        source: 'Content Validator'
                    });
                }
            }
        } catch (error) {
            Logger.error(`Error validating content in file ${filePath}:`, error);
        }
        
        return { problems };
    }
    
    /**
     * Validate all content files in the workspace
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
            
            // Find all JSON and MDX files
            const jsonFiles = await this.findFilesWithExtension(contentPath, '.json');
            const mdxFiles = await this.findFilesWithExtension(contentPath, '.mdx');
            
            Logger.info(`Found ${jsonFiles.length} JSON files and ${mdxFiles.length} MDX files for content validation`);
            
            // Validate each JSON file
            for (const file of jsonFiles) {
                if (path.basename(file) === 'index.json') {
                    const fileResult = await this.validateFile(file);
                    problems.push(...fileResult.problems);
                }
            }
            
            // Validate each MDX file
            for (const file of mdxFiles) {
                if (path.basename(file) === 'index.mdx') {
                    const fileResult = await this.validateFile(file);
                    problems.push(...fileResult.problems);
                }
            }
        } catch (error) {
            Logger.error('Error validating content files:', error);
        }
        
        return { problems };
    }
    
    /**
     * Validate that required fields are present
     */
    private validateRequiredFields(metadata: any, filePath: string, problems: ValidationProblem[]): void {
        const requiredFields = ['title', 'type'];
        
        for (const field of requiredFields) {
            if (!metadata[field]) {
                problems.push({
                    filePath,
                    message: `Missing required field: ${field}`,
                    range: this.findPropertyPosition(field, metadata, filePath),
                    severity: ValidationSeverity.Error,
                    source: 'Content Validator'
                });
            }
        }
    }
    
    /**
     * Validate field formats (types and patterns)
     */
    private validateFieldFormats(metadata: any, filePath: string, problems: ValidationProblem[]): void {
        // Validate title is a string and not too short
        if (metadata.title && typeof metadata.title === 'string') {
            if (metadata.title.trim().length < 3) {
                problems.push({
                    filePath,
                    message: 'Title is too short (minimum 3 characters)',
                    range: this.findPropertyPosition('title', metadata, filePath),
                    severity: ValidationSeverity.Warning,
                    source: 'Content Validator'
                });
            }
        }
        
        // Validate tags is an array if present
        if (metadata.tags !== undefined && !Array.isArray(metadata.tags)) {
            problems.push({
                filePath,
                message: 'Tags should be an array',
                range: this.findPropertyPosition('tags', metadata, filePath),
                severity: ValidationSeverity.Error,
                source: 'Content Validator'
            });
        }
        
        // Validate publishedAt is a valid date if present
        if (metadata.publishedAt) {
            const date = new Date(metadata.publishedAt);
            if (isNaN(date.getTime())) {
                problems.push({
                    filePath,
                    message: 'Invalid date format for publishedAt',
                    range: this.findPropertyPosition('publishedAt', metadata, filePath),
                    severity: ValidationSeverity.Error,
                    source: 'Content Validator'
                });
            }
        }
    }
    
    /**
     * Validate content type specific rules
     */
    private validateContentType(metadata: any, filePath: string, problems: ValidationProblem[]): void {
        if (!metadata.type) {
            return; // Type is already reported as missing in required fields check
        }
        
        // Each content type can have specific validation rules
        switch (metadata.type) {
            case 'blog':
            case 'post':
                // Blog posts should have a description
                if (!metadata.description || metadata.description.trim().length < 10) {
                    problems.push({
                        filePath,
                        message: 'Blog posts should have a meaningful description (min 10 chars)',
                        range: this.findPropertyPosition('description', metadata, filePath),
                        severity: ValidationSeverity.Warning,
                        source: 'Content Validator'
                    });
                }
                break;
                
            case 'page':
                // No specific rules for pages yet
                break;
                
            // Add more content types as needed
        }
    }
    
    /**
     * Find the position of a property in the JSON content
     */
    private findPropertyPosition(property: string, metadata: any, filePath: string): vscode.Range {
        try {
            // For simplicity, we'll just return position 0,0 for now
            // In a real implementation, you would parse the JSON and find the actual position
            return new vscode.Range(0, 0, 0, 0);
        } catch (error) {
            return new vscode.Range(0, 0, 0, 0);
        }
    }
    
    /**
     * Find the position of a JSON parsing error
     */
    private findErrorPosition(content: string, error: Error): vscode.Range {
        try {
            // Extract line and column information from the error message
            const match = error.message.match(/at position (\d+)/);
            if (match && match[1]) {
                const position = parseInt(match[1], 10);
                
                // Convert position to line and character
                const contentBefore = content.substring(0, position);
                const lines = contentBefore.split('\n');
                const line = lines.length - 1;
                const character = lines[lines.length - 1].length;
                
                return new vscode.Range(line, character, line, character + 1);
            }
            
            return new vscode.Range(0, 0, 0, 0);
        } catch (error) {
            return new vscode.Range(0, 0, 0, 0);
        }
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
