import * as vscode from 'vscode';
import { Logger } from './logger';
import { AuthenticationError } from './errors';

/**
 * Shows a simple error message to the user
 */
export function showError(message: string): Thenable<string | undefined> {
    return vscode.window.showErrorMessage(message);
}

/**
 * Shows an error message based on an error object with standard formatting
 */
export function showErrorWithDetails(baseMessage: string, error: any): Thenable<string | undefined> {
    const errorMessage = `${baseMessage}: ${error instanceof Error ? error.message : String(error)}`;
    Logger.error(baseMessage, error); // Also log the error
    return vscode.window.showErrorMessage(errorMessage);
}

/**
 * Shows an error message with an option to view logs
 */
export function showErrorWithLogsOption(baseMessage: string, error: any): Thenable<string | undefined> {
    const errorMessage = `${baseMessage}: ${error instanceof Error ? error.message : String(error)}`;
    
    // Log the full error details
    Logger.error(baseMessage, error);
    
    return vscode.window.showErrorMessage(errorMessage, 'View Logs')
        .then(selection => {
            if (selection === 'View Logs') {
                Logger.show();
            }
            return selection;
        });
}

/**
 * Shows an error with a specific action
 */
export async function showErrorWithAction(baseMessage: string, error: any, actionLabel: string): Promise<boolean> {
    const errorMessage = `${baseMessage}: ${error instanceof Error ? error.message : String(error)}`;
    Logger.error(baseMessage, error);
    
    const selection = await vscode.window.showErrorMessage(errorMessage, actionLabel);
    return selection === actionLabel;
}

/**
 * Handles authentication errors with special options
 */
export async function handleAuthenticationError(error: Error): Promise<void> {
    if (!(error instanceof AuthenticationError)) {
        showErrorWithDetails('An error occurred', error);
        return;
    }
    
    const action = await vscode.window.showErrorMessage(
        'Authentication failed: Your token is invalid or expired.',
        'Re-authenticate',
        'View Logs'
    );
    
    if (action === 'Re-authenticate') {
        vscode.commands.executeCommand('leadcms-vs-plugin.authenticate');
    } else if (action === 'View Logs') {
        Logger.show();
    }
}

/**
 * Shows an error with multiple action options
 */
export function showErrorWithActions(
    message: string, 
    actions: string[]
): Thenable<string | undefined> {
    return vscode.window.showErrorMessage(message, ...actions);
}

/**
 * Shows a validation error for inputs
 */
export function showValidationError(message: string): Thenable<string | undefined> {
    return vscode.window.showErrorMessage(`Validation error: ${message}`);
}

/**
 * Shows a workspace requirement error
 */
export function showWorkspaceRequiredError(): Thenable<string | undefined> {
    return vscode.window.showErrorMessage('LeadCMS: This command requires an open workspace. Please open a folder first.');
}

/**
 * Shows an error during extension activation
 */
export function showActivationError(error: any): Thenable<string | undefined> {
    Logger.error('Error during extension activation', error);
    return vscode.window.showErrorMessage('Failed to activate LeadCMS CMS extension. See logs for details.');
}

/**
 * Shows a workspace not initialized error with option to initialize
 * @returns boolean indicating if initialization was requested
 */
export async function handleWorkspaceNotInitializedError(): Promise<boolean> {
    const action = await showErrorWithActions(
        'Workspace not initialized. Please initialize your workspace first.',
        ['Initialize Workspace', 'Cancel']
    );
    
    if (action === 'Initialize Workspace') {
        // Execute the initialize workspace command
        await vscode.commands.executeCommand('leadcms-vs-plugin.initializeWorkspace');
        return true;
    }
    return false;
}
