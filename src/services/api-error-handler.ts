import { Logger } from '../utils/logger';
import * as vscode from 'vscode';

/**
 * Standard RFC error response structure
 */
export interface ApiErrorResponse {
    type: string;
    title: string;
    status: number;
    errors?: Record<string, string[]>;
    traceId?: string;
}

/**
 * Handles API error responses and provides methods to extract and display errors to users
 */
export class ApiErrorHandler {
    /**
     * Parse an error response into a structured ApiErrorResponse
     */
    public static parseErrorResponse(error: any): ApiErrorResponse | null {
        try {
            if (error?.response?.data && typeof error.response.data === 'object') {
                const data = error.response.data;
                
                // Check if it follows RFC error format
                if (data.type && data.title && data.status) {
                    return data as ApiErrorResponse;
                }
            }
            return null;
        } catch (e) {
            Logger.error("Failed to parse API error response", e);
            return null;
        }
    }
    
    /**
     * Display API error information to the user
     */
    public static async displayErrorToUser(error: any): Promise<void> {
        const apiError = this.parseErrorResponse(error);
        
        if (apiError && apiError.errors) {
            // Format the validation errors
            const errorMessages = Object.entries(apiError.errors)
                .map(([field, messages]) => {
                    return `${field}: ${messages.join(', ')}`;
                })
                .join('\n');
            
            const message = `${apiError.title}\n\n${errorMessages}`;
            
            await vscode.window.showErrorMessage(
                message,
                { modal: true, detail: `Status: ${apiError.status} (Trace ID: ${apiError.traceId || 'N/A'})` }
            );
        } else {
            // Fallback for non-standard errors
            const errorMessage = error.message || "An unknown error occurred";
            await vscode.window.showErrorMessage(errorMessage);
        }
    }
    
    /**
     * Get user-friendly validation instructions from an API error
     */
    public static getValidationInstructions(error: any): string {
        const apiError = this.parseErrorResponse(error);
        
        if (!apiError || !apiError.errors) {
            return "Please check your input and try again.";
        }
        
        // Build specific instructions based on the error fields
        let instructions = "Please fix the following validation errors:\n\n";
        
        for (const [field, messages] of Object.entries(apiError.errors)) {
            instructions += `• ${field}: ${messages.join(', ')}\n`;
        }
        
        return instructions;
    }
}
