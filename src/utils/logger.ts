import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Logger class for OnlineSales VS plugin
 */
export class Logger {
    private static outputChannel: vscode.OutputChannel | undefined;
    private static workspacePath: string | undefined;
    
    /**
     * Initialize the logger with a VS Code output channel
     */
    public static init(): void {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel('OnlineSales CMS');
        }
        
        // Try to determine workspace path if not explicitly set
        if (!this.workspacePath && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this.workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        }
    }
    
    /**
     * Set the workspace path for log file storage
     */
    public static setWorkspacePath(path: string): void {
        this.workspacePath = path;
    }
    
    /**
     * Log an info message
     */
    public static info(message: string): void {
        this.ensureInitialized();
        const timestamp = new Date().toISOString();
        this.outputChannel!.appendLine(`[${timestamp}] [INFO] ${message}`);
        console.log(message);
    }
    
    /**
     * Log an API request
     */
    public static apiRequest(method: string, url: string, data?: any): void {
        this.ensureInitialized();
        const timestamp = new Date().toISOString();
        let message = `[${timestamp}] [API] ${method} ${url}`;
        
        if (data) {
            // Truncate data if it's too large
            const dataStr = typeof data === 'string' 
                ? data 
                : JSON.stringify(data);
                
            const truncated = dataStr.length > 500 
                ? dataStr.substring(0, 500) + '... [truncated]' 
                : dataStr;
                
            message += `\n  Request Data: ${truncated}`;
        }
        
        this.outputChannel!.appendLine(message);
        console.log(`API Request: ${method} ${url}`);
    }
    
    /**
     * Log an API response
     */
    public static apiResponse(url: string, status: number, data?: any): void {
        this.ensureInitialized();
        const timestamp = new Date().toISOString();
        let message = `[${timestamp}] [API] Response ${status} from ${url}`;
        
        if (data) {
            let summary: string;
            
            if (Array.isArray(data)) {
                summary = `Array with ${data.length} items`;
                if (data.length > 0) {
                    const firstItem = typeof data[0] === 'object' ? JSON.stringify(data[0]).substring(0, 100) : data[0];
                    summary += `, first item: ${firstItem}${firstItem.length >= 100 ? '...' : ''}`;
                }
            } else if (typeof data === 'object' && data !== null) {
                const keys = Object.keys(data);
                summary = `Object with keys: ${keys.join(', ')}`;
            } else {
                summary = String(data);
                if (summary.length > 100) {
                    summary = summary.substring(0, 100) + '... [truncated]';
                }
            }
            
            message += `\n  Response Data: ${summary}`;
        }
        
        this.outputChannel!.appendLine(message);
        console.log(`API Response: ${status} from ${url}`);
    }
    
    /**
     * Log an error message
     */
    public static error(message: string, error?: any): void {
        this.ensureInitialized();
        const timestamp = new Date().toISOString();
        let logMessage = `[${timestamp}] [ERROR] ${message}`;
        
        if (error) {
            if (error instanceof Error) {
                logMessage += `\n  ${error.name}: ${error.message}`;
                if (error.stack) {
                    logMessage += `\n  Stack: ${error.stack}`;
                }
            } else {
                logMessage += `\n  ${String(error)}`;
            }
        }
        
        this.outputChannel!.appendLine(logMessage);
        console.error(message, error || '');
    }
    
    /**
     * Log a warning message
     */
    public static warn(message: string, details?: any): void {
        this.ensureInitialized();
        const timestamp = new Date().toISOString();
        let logMessage = `[${timestamp}] [WARN] ${message}`;
        
        if (details) {
            if (details instanceof Error) {
                logMessage += `\n  ${details.name}: ${details.message}`;
                if (details.stack) {
                    logMessage += `\n  Stack: ${details.stack}`;
                }
            } else if (typeof details === 'object') {
                logMessage += `\n  ${JSON.stringify(details)}`;
            } else {
                logMessage += `\n  ${String(details)}`;
            }
        }
        
        this.outputChannel!.appendLine(logMessage);
        console.warn(message, details || '');
    }
    
    /**
     * Show the log output panel
     */
    public static show(): void {
        this.ensureInitialized();
        this.outputChannel!.show();
    }
    
    /**
     * Log complete content payload for debugging validation issues
     * Writes to a separate log file to avoid cluttering the main logs
     */
    public static logContentPayload(action: string, content: any): void {
        const timestamp = new Date().toISOString();
        const contentLog = `\n\n=== ${timestamp} - ${action} ===\n${JSON.stringify(content, null, 2)}\n`;
        
        // Get the logs directory path
        const logFile = getLogFilePath('content-payloads.log');
        
        try {
            if (!fs.existsSync(path.dirname(logFile))) {
                fs.mkdirSync(path.dirname(logFile), { recursive: true });
            }
            
            // Append to log file
            fs.appendFileSync(logFile, contentLog);
            
            // Also log to console a message saying where to find the detailed log
            console.log(`Content payload logged to: ${logFile}`);
        } catch (error) {
            console.error('Failed to write content payload to log file:', error);
        }
    }
    
    private static ensureInitialized(): void {
        if (!this.outputChannel) {
            this.init();
        }
    }
    
    /**
     * Get the path to the workspace logs directory
     * Returns the path or undefined if no workspace is open
     */
    public static getLogsDirectory(): string | undefined {
        if (!this.workspacePath) {
            // Try to get workspace path one more time
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                this.workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            } else {
                return undefined;
            }
        }
        
        return path.join(this.workspacePath, '.onlinesales', 'logs');
    }
}

function getLogFilePath(fileName: string): string {
    const logsDir = Logger.getLogsDirectory();
    
    if (logsDir) {
        return path.join(logsDir, fileName);
    }
    
    // Fallback to extension directory if no workspace is available
    return path.join(__dirname, '..', '..', 'logs', fileName);
}
