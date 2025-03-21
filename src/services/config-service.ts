import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import { OnlineSalesConfig, TokenConfig } from '../models/config';
import { Logger } from '../utils/logger';

export class ConfigService {
    private workspaceRoot: string | undefined;
    private configPath: string | undefined;
    private tokenPath: string | undefined;
    private fileWatchers: vscode.Disposable[] = [];
    
    constructor() {
        this.initialize();
    }

    private initialize(): void {
        // Check if there's an open workspace without throwing an error
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            this.workspaceRoot = workspaceFolders[0].uri.fsPath;
            this.configPath = path.join(this.workspaceRoot, '.onlinesales', 'config.json');
            this.tokenPath = path.join(this.workspaceRoot, '.onlinesales', 'token.json');
            
            // Set up file watchers to log when config files change
            this.setupFileWatchers();
        }
        // If no workspace is open, paths will remain undefined
    }
    
    /**
     * Set up file watchers to log when configuration files change
     */
    private setupFileWatchers(): void {
        // Dispose any existing watchers
        this.disposeWatchers();
        
        if (this.workspaceRoot) {
            try {
                // Watch for changes to the config file
                const configWatcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(this.workspaceRoot, '.onlinesales/config.json')
                );
                
                configWatcher.onDidChange(() => {
                    Logger.info('Configuration file changed, reloading settings');
                });
                
                configWatcher.onDidCreate(() => {
                    Logger.info('Configuration file created, loading settings');
                });
                
                configWatcher.onDidDelete(() => {
                    Logger.warn('Configuration file deleted');
                });
                
                // Add watchers to the list for later disposal
                this.fileWatchers.push(configWatcher);
                
                // Watch for changes to the token file
                const tokenWatcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(this.workspaceRoot, '.onlinesales/token.json')
                );
                
                tokenWatcher.onDidChange(() => {
                    Logger.info('Token file changed, authentication will use updated token');
                });
                
                this.fileWatchers.push(tokenWatcher);
            } catch (error) {
                Logger.warn('Failed to set up configuration file watchers:', error);
            }
        }
    }
    
    /**
     * Dispose all file watchers
     */
    private disposeWatchers(): void {
        for (const watcher of this.fileWatchers) {
            watcher.dispose();
        }
        this.fileWatchers = [];
    }
    
    public hasWorkspace(): boolean {
        return !!this.workspaceRoot;
    }

    public ensureWorkspaceExists(): void {
        if (!this.workspaceRoot) {
            throw new Error('This command requires an open workspace. Please open a folder first.');
        }
    }
    
    public async ensureDirectoriesExist(): Promise<void> {
        this.ensureWorkspaceExists();
        
        await fs.ensureDir(path.join(this.workspaceRoot!, '.onlinesales'));
        await fs.ensureDir(path.join(this.workspaceRoot!, 'content'));
    }

    /**
     * Get the current configuration from file
     * Always reads from the file system to ensure fresh values
     */
    public async getConfig(): Promise<OnlineSalesConfig | undefined> {
        if (!this.configPath) {
            return undefined;
        }
        
        try {
            if (await fs.pathExists(this.configPath)) {
                const configData = await fs.readFile(this.configPath, 'utf8');
                return JSON.parse(configData) as OnlineSalesConfig;
            }
        } catch (error) {
            Logger.error('Failed to read config file:', error);
        }
        
        return undefined;
    }

    public async saveConfig(config: OnlineSalesConfig): Promise<void> {
        this.ensureWorkspaceExists();
        
        await this.ensureDirectoriesExist();
        await fs.writeFile(this.configPath!, JSON.stringify(config, null, 2), 'utf8');
        Logger.info('Configuration saved successfully');
    }

    /**
     * Get the current token from file
     * Always reads from the file system to ensure fresh values
     */
    public async getToken(): Promise<TokenConfig | undefined> {
        if (!this.tokenPath) {
            return undefined;
        }
        
        try {
            if (await fs.pathExists(this.tokenPath)) {
                const tokenData = await fs.readFile(this.tokenPath, 'utf8');
                return JSON.parse(tokenData) as TokenConfig;
            }
        } catch (error) {
            Logger.error('Failed to read token file:', error);
        }
        
        return undefined;
    }

    public async saveToken(token: TokenConfig): Promise<void> {
        this.ensureWorkspaceExists();
        
        await this.ensureDirectoriesExist();
        await fs.writeFile(this.tokenPath!, JSON.stringify(token, null, 2), 'utf8');
        Logger.info('Authentication token saved successfully');
    }
    
    /**
     * Clean up resources on deactivation
     */
    public dispose(): void {
        this.disposeWatchers();
    }

    /**
     * Get the current workspace path
     */
    public getWorkspacePath(): string {
        if (!this.workspaceRoot) {
            throw new Error('No workspace folder found. Please open a folder first.');
        }
        return this.workspaceRoot;
    }
}
