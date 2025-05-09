import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { Validator, ValidationResult, ValidationProblem, ValidationSeverity } from './validator';

/**
 * Validator for content metadata based on ContentCreateDto requirements
 */
export class MetadataValidator implements Validator {
    public readonly id = 'metadata';
    public readonly displayName = 'Metadata Fields Validator';
    
    // Required fields from ContentCreateDto
    private static readonly REQUIRED_FIELDS = [
        'title',
        'description',
        'author',
        'language'
    ];
    
    private workspacePath: string | undefined;
    
    constructor(workspacePath: string | undefined) {
        this.workspacePath = workspacePath;
    }
    
    /**
     * Validate a single file's metadata
     */
    public async validateFile(filePath: string): Promise<ValidationResult> {
        const problems: ValidationProblem[] = [];
        
        if (!this.workspacePath) {
            return { problems };
        }
        
        // Only validate JSON files
        if (!filePath.endsWith('.json')) {
            return { problems };
        }
        
        try {
            // Read metadata file
            const content = await fs.readFile(filePath, 'utf8');
            let metadata: any;
            
            try {
                metadata = JSON.parse(content);
            } catch (jsonError) {
                // Add a problem for invalid JSON
                problems.push({
                    filePath,
                    message: `Invalid JSON: ${(jsonError as Error).message}`,
                    range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
                    severity: ValidationSeverity.Error,
                    source: 'LeadCMS'
                });
                return { problems };
            }
            
            // Validate required fields
            for (const field of MetadataValidator.REQUIRED_FIELDS) {
                // Special handling for 'body' field
                if (field === 'body') {
                    // Body is typically in companion MDX file, not in metadata JSON
                    const mdxPath = filePath.replace(/\.json$/, '.mdx');
                    if (!await fs.pathExists(mdxPath)) {
                        problems.push({
                            filePath,
                            message: `Missing required file: ${path.basename(mdxPath)}`,
                            range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
                            severity: ValidationSeverity.Error,
                            source: 'LeadCMS'
                        });
                    } else {
                        const mdxContent = await fs.readFile(mdxPath, 'utf8');
                        if (!mdxContent || mdxContent.trim().length === 0) {
                            problems.push({
                                filePath: mdxPath,
                                message: 'Body content is empty',
                                range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
                                severity: ValidationSeverity.Error,
                                source: 'LeadCMS'
                            });
                        }
                    }
                    continue;
                }
                
                // Check if field exists and is not empty
                if (!metadata[field] || 
                    (typeof metadata[field] === 'string' && metadata[field].trim() === '')) {
                    
                    // Find position of the field in the JSON
                    const fieldRange = this.findFieldRange(content, field, true);
                    
                    problems.push({
                        filePath,
                        message: `Missing required field: ${field}`,
                        range: fieldRange,
                        severity: ValidationSeverity.Error,
                        source: 'LeadCMS'
                    });
                }
            }
            
        } catch (error) {
            Logger.error(`Error validating metadata in ${filePath}:`, error);
        }
        
        return { problems };
    }
    
    /**
     * Validate all content metadata in the workspace
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
            
            // Find all JSON metadata files
            const jsonFiles = await this.findFilesWithExtension(contentPath, '.json');
            
            Logger.info(`Found ${jsonFiles.length} JSON files for metadata validation`);
            
            // Validate each JSON file
            for (const file of jsonFiles) {
                const fileResult = await this.validateFile(file);
                problems.push(...fileResult.problems);
            }
        } catch (error) {
            Logger.error('Error validating metadata:', error);
        }
        
        return { problems };
    }
    
    /**
     * Find the position of a field in JSON content
     */
    private findFieldRange(content: string, fieldName: string, forMissing: boolean = false): vscode.Range {
        // For existing fields
        const fieldPattern = new RegExp(`"${fieldName}"\\s*:\\s*"?([^,"{}]*)"?`);
        const match = fieldPattern.exec(content);
        
        if (match) {
            const startPos = match.index;
            const endPos = match.index + match[0].length;
            const startLine = content.substring(0, startPos).split('\n').length - 1;
            const endLine = content.substring(0, endPos).split('\n').length - 1;
            const startChar = startPos - content.lastIndexOf('\n', startPos) - 1;
            const endChar = endPos - content.lastIndexOf('\n', endPos) - 1;
            
            return new vscode.Range(
                new vscode.Position(startLine, startChar),
                new vscode.Position(endLine, endChar)
            );
        }
        
        // For missing fields, find a good position to suggest insertion
        if (forMissing) {
            // Look for the closing brace of the object
            const closingBrace = content.lastIndexOf('}');
            if (closingBrace >= 0) {
                const line = content.substring(0, closingBrace).split('\n').length - 1;
                const char = closingBrace - content.lastIndexOf('\n', closingBrace) - 1;
                return new vscode.Range(
                    new vscode.Position(line, char),
                    new vscode.Position(line, char + 1)
                );
            }
        }
        
        // Fallback to the first line
        return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
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
