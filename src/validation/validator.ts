import * as vscode from 'vscode';

export enum ValidationSeverity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3
}

export interface ValidationResult {
    problems: ValidationProblem[];
}

export interface ValidationProblem {
    filePath: string;
    message: string;
    range: vscode.Range;
    severity: ValidationSeverity;
    source?: string;
    code?: string;
}

export interface Validator {
    /**
     * Unique identifier for the validator
     */
    readonly id: string;
    
    /**
     * Human-readable name of the validator
     */
    readonly displayName: string;
    
    /**
     * Validate a specific file
     */
    validateFile(filePath: string): Promise<ValidationResult>;
    
    /**
     * Validate all relevant files in the workspace
     */
    validateAll(): Promise<ValidationResult>;
}
