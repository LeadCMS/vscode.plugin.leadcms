import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import { LeadCMSConfig, TokenConfig } from '../models/config';
import { UserSettings } from '../models/user-settings';
import { Logger } from '../utils/logger';

export class ConfigService {
    private workspaceRoot: string | undefined;
    private configPath: string | undefined;
    private tokenPath: string | undefined;
    private fileWatchers: vscode.Disposable[] = [];
    
    // Settings key for Gatsby path in VS Code settings
    private readonly GATSBY_PATH_SETTING = 'leadcmsCms.gatsbyPath';
    
    // Add setting key for Gatsby port
    private readonly GATSBY_PORT_SETTING = 'leadcmsCms.gatsbyPort';
    
    constructor() {
        this.initialize();
    }

    private initialize(): void {
        // Check if there's an open workspace without throwing an error
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            this.workspaceRoot = workspaceFolders[0].uri.fsPath;
            this.configPath = path.join(this.workspaceRoot, '.leadcms', 'config.json');
            this.tokenPath = path.join(this.workspaceRoot, '.leadcms', 'token.json');
            
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
                    new vscode.RelativePattern(this.workspaceRoot, '.leadcms/config.json')
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
                    new vscode.RelativePattern(this.workspaceRoot, '.leadcms/token.json')
                );
                
                tokenWatcher.onDidChange(() => {
                    Logger.info('Token file changed, authentication will use updated token');
                });
                
                this.fileWatchers.push(tokenWatcher);

                // Add watcher for VS Code settings.json
                const vsCodeSettingsWatcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(this.workspaceRoot, '.vscode/settings.json')
                );
                
                this.fileWatchers.push(vsCodeSettingsWatcher);
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
        
        await fs.ensureDir(path.join(this.workspaceRoot!, '.leadcms'));
        await fs.ensureDir(path.join(this.workspaceRoot!, 'content'));
    }

    /**
     * Get the current configuration from file
     * Always reads from the file system to ensure fresh values
     */
    public async getConfig(): Promise<LeadCMSConfig | undefined> {
        if (!this.configPath) {
            return undefined;
        }
        
        try {
            if (await fs.pathExists(this.configPath)) {
                const configData = await fs.readFile(this.configPath, 'utf8');
                return JSON.parse(configData) as LeadCMSConfig;
            }
        } catch (error) {
            Logger.error('Failed to read config file:', error);
        }
        
        return undefined;
    }

    public async saveConfig(config: LeadCMSConfig): Promise<void> {
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
     * Get the path to the Gatsby site from VS Code settings
     */
    public async getGatsbyPath(): Promise<string | undefined> {
        if (!this.hasWorkspace()) {
            return undefined;
        }
        
        try {
            // First try to read directly from settings.json file
            const settingsPath = path.join(this.workspaceRoot!, '.vscode', 'settings.json');
            if (await fs.pathExists(settingsPath)) {
                const content = await fs.readFile(settingsPath, 'utf-8');
                if (content.trim()) {
                    const settings = JSON.parse(content);
                    if (settings[this.GATSBY_PATH_SETTING]) {
                        return settings[this.GATSBY_PATH_SETTING];
                    }
                }
            }
            
            // Fallback: try VS Code API (in case it works)
            try {
                const config = vscode.workspace.getConfiguration();
                return config.get<string>(this.GATSBY_PATH_SETTING);
            } catch (error) {
                // Ignore errors from the VS Code API
                Logger.error('Could not get Gatsby path from VS Code API, using file-based approach');
            }
            
            return undefined;
        } catch (error) {
            Logger.error('Failed to get Gatsby path:', error);
            return undefined;
        }
    }
    
    /**
     * Save the path to the Gatsby site in VS Code settings
     * @param gatsbyPath Path to the Gatsby site
     */
    public async saveGatsbyPath(gatsbyPath: string): Promise<void> {
        try {
            if (!this.hasWorkspace()) {
                throw new Error('No workspace folder found');
            }
            
            // Ensure .vscode directory exists
            const vscodeDir = path.join(this.workspaceRoot!, '.vscode');
            await fs.ensureDir(vscodeDir);
            
            // Load or create settings.json file
            const settingsPath = path.join(vscodeDir, 'settings.json');
            let settings = {};
            
            if (await fs.pathExists(settingsPath)) {
                try {
                    const content = await fs.readFile(settingsPath, 'utf-8');
                    if (content.trim()) {
                        settings = JSON.parse(content);
                    }
                } catch (error) {
                    Logger.warn('Could not parse existing settings.json, creating new one', error);
                }
            }
            
            // Update settings object directly
            settings = {
                ...settings,
                [this.GATSBY_PATH_SETTING]: gatsbyPath
            };
            
            // Write updated settings back to file
            await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
            Logger.info(`Gatsby path saved to workspace settings: ${gatsbyPath}`);
            
            // Try to update VS Code's in-memory settings too, but don't rely on it
            try {
                const config = vscode.workspace.getConfiguration();
                await config.update(this.GATSBY_PATH_SETTING, gatsbyPath, vscode.ConfigurationTarget.Workspace);
            } catch (error) {
                // This is expected to fail if the setting is not registered
                Logger.error('Could not update VS Code configuration in memory, this is expected');
            }
        } catch (error) {
            Logger.error('Failed to save Gatsby path to workspace settings:', error);
            throw error;
        }
    }

    /**
     * Get the Gatsby server port from VS Code settings
     * @returns The configured port or undefined if not set
     */
    public async getGatsbyPort(): Promise<number | undefined> {
        if (!this.hasWorkspace()) {
            return undefined;
        }
        
        try {
            // First try to read directly from settings.json file
            const settingsPath = path.join(this.workspaceRoot!, '.vscode', 'settings.json');
            if (await fs.pathExists(settingsPath)) {
                const content = await fs.readFile(settingsPath, 'utf-8');
                if (content.trim()) {
                    const settings = JSON.parse(content);
                    if (settings[this.GATSBY_PORT_SETTING]) {
                        const port = parseInt(settings[this.GATSBY_PORT_SETTING], 10);
                        return isNaN(port) ? undefined : port;
                    }
                }
            }
            
            // Fallback: try VS Code API
            try {
                const config = vscode.workspace.getConfiguration();
                const port = config.get<number>(this.GATSBY_PORT_SETTING);
                return port;
            } catch (error) {
                // Ignore errors from the VS Code API
                Logger.error('Could not get Gatsby port from VS Code API');
            }
            
            return undefined;
        } catch (error) {
            Logger.error('Failed to get Gatsby port:', error);
            return undefined;
        }
    }
    
    /**
     * Save the Gatsby server port in VS Code settings
     * @param port The Gatsby server port
     */
    public async saveGatsbyPort(port: number): Promise<void> {
        try {
            if (!this.hasWorkspace()) {
                throw new Error('No workspace folder found');
            }
            
            // Ensure .vscode directory exists
            const vscodeDir = path.join(this.workspaceRoot!, '.vscode');
            await fs.ensureDir(vscodeDir);
            
            // Load or create settings.json file
            const settingsPath = path.join(vscodeDir, 'settings.json');
            let settings = {};
            
            if (await fs.pathExists(settingsPath)) {
                try {
                    const content = await fs.readFile(settingsPath, 'utf-8');
                    if (content.trim()) {
                        settings = JSON.parse(content);
                    }
                } catch (error) {
                    Logger.warn('Could not parse existing settings.json, creating new one', error);
                }
            }
            
            // Update settings object directly
            settings = {
                ...settings,
                [this.GATSBY_PORT_SETTING]: port
            };
            
            // Write updated settings back to file
            await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
            Logger.info(`Gatsby port saved to workspace settings: ${port}`);
            
            // Try to update VS Code's in-memory settings too, but don't rely on it
            try {
                const config = vscode.workspace.getConfiguration();
                await config.update(this.GATSBY_PORT_SETTING, port, vscode.ConfigurationTarget.Workspace);
            } catch (error) {
                // This is expected to fail if the setting is not registered
                Logger.error('Could not update VS Code configuration for Gatsby port in memory, this is expected');
            }
        } catch (error) {
            Logger.error('Failed to save Gatsby port to workspace settings:', error);
            throw error;
        }
    }
    
    /**
     * Ensure the specified path is in .gitignore
     */
    public async ensureGitIgnoreContains(pathToIgnore: string): Promise<void> {
        try {
            if (!this.workspaceRoot) {
                throw new Error('Workspace not initialized');
            }
            
            const gitignorePath = path.join(this.workspaceRoot, '.gitignore');
            let content = '';
            
            // Read existing .gitignore or create new one
            if (fs.existsSync(gitignorePath)) {
                content = await fs.readFile(gitignorePath, 'utf-8');
            }
            
            // Add the path to .gitignore if not already there
            if (!content.includes(pathToIgnore)) {
                content += `\n# User-specific settings\n${pathToIgnore}\n`;
                await fs.writeFile(gitignorePath, content, 'utf-8');
                Logger.info(`Updated .gitignore to exclude ${pathToIgnore}`);
            }
        } catch (error) {
            Logger.warn('Failed to update .gitignore:', error);
        }
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

    /**
     * Checks if the workspace has been initialized with .leadcms/config.json
     */
    public isWorkspaceInitialized(): boolean {
        if (!this.hasWorkspace()) {
            return false;
        }
        
        const configPath = path.join(this.getWorkspacePath(), '.leadcms', 'config.json');
        return fs.existsSync(configPath);
    }
}
