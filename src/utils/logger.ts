import * as vscode from 'vscode';

/**
 * Logger class for OnlineSales VS plugin
 */
export class Logger {
    private static outputChannel: vscode.OutputChannel | undefined;
    
    /**
     * Initialize the logger with a VS Code output channel
     */
    public static init(): void {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel('OnlineSales CMS');
        }
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
    
    private static ensureInitialized(): void {
        if (!this.outputChannel) {
            this.init();
        }
    }
}
