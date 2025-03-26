import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { Logger } from '../utils/logger';
import { ValidationResult, ValidationProblem, ValidationSeverity } from './validator';
import { MediaValidator } from './media-validator';
import { ContentValidator } from './content-validator';
import { MetadataValidator } from './metadata-validator';

/**
 * Service for validating content
 */
export class ValidationService {
    private workspacePath: string | undefined;
    private validators: any[] = [];
    private diagnosticCollection: vscode.DiagnosticCollection;
    
    constructor(workspacePath: string | undefined) {
        this.workspacePath = workspacePath;
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('onlinesales');
        
        // Register all validators
        this.validators.push(new MediaValidator(workspacePath));
        this.validators.push(new ContentValidator(workspacePath));
        this.validators.push(new MetadataValidator(workspacePath));
    }
    
    /**
     * Validate all content in the workspace
     */
    public async validateAll(): Promise<number> {
        Logger.info('Performing full content validation...');
        
        // Clear previous diagnostics
        this.diagnosticCollection.clear();
        
        let totalProblems = 0;
        const allProblems: ValidationProblem[] = [];
        
        // Run all validators
        for (const validator of this.validators) {
            try {
                const result = await validator.validateAll();
                if (result.problems && result.problems.length > 0) {
                    allProblems.push(...result.problems);
                    Logger.info(`Validator ${validator.displayName} found ${result.problems.length} problems`);
                }
            } catch (error) {
                Logger.error(`Error running validator ${validator.displayName}:`, error);
            }
        }
        
        // Process and display all problems
        this.processProblems(allProblems);
        totalProblems = allProblems.length;
        
        Logger.info(`Validation complete. Found ${totalProblems} total problems.`);
        return totalProblems;
    }
    
    /**
     * Validate a single file
     */
    public async validateFile(filePath: string): Promise<ValidationResult> {
        Logger.info(`Validating file: ${filePath}`);
        
        // Clear previous diagnostics for this file
        const fileUri = vscode.Uri.file(filePath);
        this.diagnosticCollection.delete(fileUri);
        
        const allProblems: ValidationProblem[] = [];
        
        // Run all validators on this file
        for (const validator of this.validators) {
            try {
                const result = await validator.validateFile(filePath);
                if (result.problems && result.problems.length > 0) {
                    allProblems.push(...result.problems);
                }
            } catch (error) {
                Logger.error(`Error running validator ${validator.displayName} on file ${filePath}:`, error);
            }
        }
        
        // Process and display problems for this file
        this.processProblems(allProblems);
        
        return { problems: allProblems };
    }
    
    /**
     * Validate content before pushing to CMS
     * @returns true if validation passed, false otherwise
     */
    public async validateBeforeSync(): Promise<boolean> {
        const problems = await this.validateAll();
        
        if (problems > 0) {
            const result = await vscode.window.showWarningMessage(
                `Found ${problems} validation issues. Continue with push anyway?`,
                'Continue',
                'Cancel'
            );
            
            return result === 'Continue';
        }
        
        return true;
    }
    
    /**
     * Process validation problems and display them in the Problems panel
     */
    private processProblems(problems: ValidationProblem[]): void {
        const fileDiagnosticsMap = new Map<string, vscode.Diagnostic[]>();
        
        // Filter out problems for files that no longer exist
        const existingProblems = problems.filter(problem => {
            try {
                return fs.existsSync(problem.filePath);
            } catch (error) {
                Logger.error(`Error checking if file exists: ${problem.filePath}`, error);
                return false; // Skip this problem if we can't verify the file exists
            }
        });
        
        for (const problem of existingProblems) {
            try {
                // Create a vscode diagnostic from the problem
                const range = problem.range || new vscode.Range(0, 0, 0, 0);
                
                const diagnostic = new vscode.Diagnostic(
                    range,
                    problem.message,
                    this.mapSeverity(problem.severity)
                );
                
                diagnostic.source = problem.source || 'OnlineSales';
                
                // Group diagnostics by file
                if (!fileDiagnosticsMap.has(problem.filePath)) {
                    fileDiagnosticsMap.set(problem.filePath, []);
                }
                fileDiagnosticsMap.get(problem.filePath)!.push(diagnostic);
            } catch (error) {
                Logger.error(`Error creating diagnostic for problem: ${problem.message}`, error);
            }
        }
        
        // We must clear the entire collection again to ensure deleted/renamed files don't keep their diagnostics
        this.diagnosticCollection.clear();
        
        // Update the diagnostic collection only for files that exist
        for (const [filePath, diagnostics] of fileDiagnosticsMap.entries()) {
            try {
                const fileUri = vscode.Uri.file(filePath);
                this.diagnosticCollection.set(fileUri, diagnostics);
            } catch (error) {
                Logger.error(`Error setting diagnostics for file ${filePath}:`, error);
            }
        }
    }
    
    /**
     * Map validation severity to vscode severity
     */
    private mapSeverity(severity: ValidationSeverity): vscode.DiagnosticSeverity {
        switch (severity) {
            case ValidationSeverity.Error:
                return vscode.DiagnosticSeverity.Error;
            case ValidationSeverity.Warning:
                return vscode.DiagnosticSeverity.Warning;
            case ValidationSeverity.Information:
                return vscode.DiagnosticSeverity.Information;
            case ValidationSeverity.Hint:
                return vscode.DiagnosticSeverity.Hint;
            default:
                return vscode.DiagnosticSeverity.Warning;
        }
    }
}
