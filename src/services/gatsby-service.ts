import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as net from 'net';
import { ConfigService } from './config-service';
import { Logger } from '../utils/logger';

export class GatsbyService {
    private terminal: vscode.Terminal | undefined;
    private serverUrl: string = 'http://localhost:8000'; // Default value
    private isServerRunning: boolean = false;
    private port: number = 8000; // Default port

    // Settings keys
    private readonly GATSBY_PATH_SETTING = 'onlinesalesCms.gatsbyPath';
    private readonly GATSBY_PORT_SETTING = 'onlinesalesCms.gatsbyPort';

    constructor(private configService: ConfigService) {
        this.initializePort();
    }
    
    /**
     * Initialize the Gatsby port from configuration
     */
    private async initializePort(): Promise<void> {
        try {
            const configuredPort = await this.configService.getGatsbyPort();
            if (configuredPort) {
                this.port = configuredPort;
                this.serverUrl = `http://localhost:${this.port}`;
                Logger.info(`Using configured Gatsby port: ${this.port}`);
            } else {
                this.port = 8000; // Default
                this.serverUrl = `http://localhost:${this.port}`;
                Logger.info(`Using default Gatsby port: ${this.port}`);
            }
        } catch (error) {
            Logger.error('Error initializing Gatsby port:', error);
            // Fallback to default
            this.port = 8000;
            this.serverUrl = `http://localhost:${this.port}`;
        }
    }
    
    /**
     * Configure Gatsby port after initialization
     * @param port The port to use
     */
    public async configurePort(port: number): Promise<void> {
        try {
            // Check if the new port is already in use
            const currentPort = this.port;
            this.port = port; // Temporarily set the new port to check
            
            const portInUse = await this.checkServerAlreadyRunning();
            if (portInUse) {
                vscode.window.showInformationMessage(
                    `Port ${port} is already in use, possibly by another Gatsby instance. ` +
                    `The server will use this existing instance.`
                );
            }

            await this.configService.saveGatsbyPort(port);
            this.port = port;
            this.serverUrl = `http://localhost:${port}`;
            Logger.info(`Gatsby port configured to: ${port}`);
            
            // Reset server status since URL changed
            if (this.isServerRunning && !portInUse) {
                Logger.info('Server URL changed, resetting server status');
                this.isServerRunning = false;
            }
        } catch (error) {
            Logger.error('Failed to configure Gatsby port:', error);
            throw error;
        }
    }
    
    /**
     * Prompt the user for a custom port
     */
    public async promptForPort(): Promise<number | undefined> {
        const defaultPort = this.port.toString();
        const portInput = await vscode.window.showInputBox({
            title: 'Gatsby Server Port',
            prompt: 'Enter the port for the Gatsby development server',
            placeHolder: 'Default: 8000',
            value: defaultPort,
            validateInput: (value) => {
                const port = parseInt(value, 10);
                if (isNaN(port)) {
                    return 'Please enter a valid number';
                }
                if (port < 1024 || port > 65535) {
                    return 'Port must be between 1024 and 65535';
                }
                return null;
            }
        });
        
        if (!portInput) {
            return undefined;
        }
        
        const port = parseInt(portInput, 10);
        return isNaN(port) ? undefined : port;
    }

    /**
     * Ensure the Gatsby development server is running
     * @returns true if started or already running, false otherwise
     */
    public async ensureGatsbyServerRunning(): Promise<boolean> {
        try {
            // Check if we're already tracking a running server
            if (this.isServerRunning) {
                Logger.info('Using already started Gatsby server instance');
                return true;
            }
            
            // Check if a server is already running on the configured port (maybe started via F5)
            const alreadyRunning = await this.checkServerAlreadyRunning();
            if (alreadyRunning) {
                Logger.info(`Found existing Gatsby server running on port ${this.port}`);
                this.isServerRunning = true;
                vscode.window.showInformationMessage(`Using existing Gatsby server at ${this.serverUrl}`);
                return true;
            }

            // Get Gatsby path
            const gatsbyPath = await this.configService.getGatsbyPath();
            if (!gatsbyPath) {
                Logger.info("Gatsby path not found, prompting user for input");
                // Show a more informative message to the user
                vscode.window.showInformationMessage(
                    "To preview MDX content, you need to configure your Gatsby site path. Please enter it in the prompt below."
                );
                
                // Request Gatsby path if not set
                const newPath = await this.promptForGatsbyPath();
                if (!newPath) {
                    Logger.warn("User cancelled Gatsby path configuration");
                    vscode.window.showWarningMessage(
                        "Gatsby preview requires a valid Gatsby site path. Preview cancelled."
                    );
                    return false;
                }
                
                try {
                    await this.configService.saveGatsbyPath(newPath);
                    Logger.info(`Gatsby path configured: ${newPath}`);
                } catch (error) {
                    Logger.error("Failed to save Gatsby path configuration", error);
                    vscode.window.showErrorMessage(
                        "Failed to save Gatsby path configuration. Please try again or configure it manually in .vscode/settings.json"
                    );
                    return false;
                }
                
                // Verify the path was saved correctly
                const verifyPath = await this.configService.getGatsbyPath();
                if (!verifyPath) {
                    Logger.error("Gatsby path not found after saving");
                    vscode.window.showErrorMessage(
                        "Configuration issue: Gatsby path was not saved correctly."
                    );
                    return false;
                }
            }

            // Start the server since it's not running
            return await this.startGatsbyServer();
        } catch (error) {
            Logger.error('Error checking or ensuring Gatsby server:', error);
            return false;
        }
    }

    /**
     * Prompt the user for the Gatsby site path
     */
    public async promptForGatsbyPath(): Promise<string | undefined> {
        const result = await vscode.window.showInputBox({
            prompt: 'Enter the path to your local Gatsby site source code',
            placeHolder: '/Users/username/projects/my-gatsby-site',
            validateInput: input => {
                if (!input || input.trim().length === 0) {
                    return 'Path is required';
                }

                if (!fs.existsSync(input)) {
                    return 'Directory does not exist';
                }

                // Check if it's likely a Gatsby site by looking for gatsby in package.json
                try {
                    const packageJsonPath = path.join(input, 'package.json');
                    if (fs.existsSync(packageJsonPath)) {
                        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                        if (packageJson.dependencies && packageJson.dependencies.gatsby) {
                            return null; // Valid Gatsby site
                        }
                        return 'Directory does not appear to be a Gatsby site (gatsby dependency not found in package.json)';
                    }
                    return 'Directory does not appear to be a Gatsby site (package.json not found)';
                } catch (error) {
                    return 'Error validating Gatsby site: ' + error;
                }
            }
        });

        return result ? result.trim() : undefined;
    }

    /**
     * Start the Gatsby development server
     * @returns true if started successfully
     */
    private async startGatsbyServer(): Promise<boolean> {
        try {
            const gatsbyPath = await this.configService.getGatsbyPath();
            if (!gatsbyPath) {
                Logger.error("Trying to start Gatsby server but path is not configured");
                vscode.window.showErrorMessage(
                    "Gatsby site path is not configured. Please run the preview command again to configure it."
                );
                return false;
            }

            // Check if the path exists
            if (!fs.existsSync(gatsbyPath)) {
                Logger.error(`Gatsby site path does not exist: ${gatsbyPath}`);
                vscode.window.showErrorMessage(
                    `The configured Gatsby site path does not exist: ${gatsbyPath}. Please reconfigure it.`,
                    "Configure Now"
                ).then(selection => {
                    if (selection === "Configure Now") {
                        this.reconfigureGatsbyPath();
                    }
                });
                return false;
            }

            // Check if it's a valid Gatsby site
            const packageJsonPath = path.join(gatsbyPath, 'package.json');
            if (!fs.existsSync(packageJsonPath)) {
                Logger.error(`No package.json found in Gatsby site path: ${gatsbyPath}`);
                vscode.window.showErrorMessage(
                    `The configured path doesn't appear to be a valid Gatsby site (no package.json found). Please reconfigure it.`,
                    "Configure Now"
                ).then(selection => {
                    if (selection === "Configure Now") {
                        this.reconfigureGatsbyPath();
                    }
                });
                return false;
            }

            // Before starting, double-check if the server is already running
            const alreadyRunning = await this.checkServerAlreadyRunning();
            if (alreadyRunning) {
                Logger.info(`Server is already running on port ${this.port}`);
                this.isServerRunning = true;
                return true;
            }

            // Create or reuse terminal
            if (!this.terminal) {
                this.terminal = vscode.window.createTerminal('Gatsby Development Server');
            }
            
            this.terminal.show();

            // Set the content folder environment variable
            const workspacePath = this.configService.getWorkspacePath();
            
            // Run npm install first, then start the development server with port
            this.terminal.sendText(`cd "${gatsbyPath}"`);
            this.terminal.sendText(`git pull`);
            this.terminal.sendText(`nvm use`);
            this.terminal.sendText(`yarn`);
            this.terminal.sendText(`GATSBY_CONTENT_PATH="${workspacePath}" PORT=${this.port} yarn start`);
            
            // Wait for server to start (you may want to implement a more sophisticated check)
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            this.isServerRunning = true;
            Logger.info(`Gatsby development server started at ${this.serverUrl}`);
            
            return true;
        } catch (error) {
            Logger.error('Failed to start Gatsby server:', error);
            vscode.window.showErrorMessage(
                `Failed to start Gatsby development server: ${error}. Please check your Gatsby configuration.`,
                "Configure Path"
            ).then(selection => {
                if (selection === "Configure Path") {
                    this.reconfigureGatsbyPath();
                }
            });
            return false;
        }
    }

    /**
     * Allow user to reconfigure the Gatsby path
     */
    public async reconfigureGatsbyPath(): Promise<boolean> {
        Logger.info("Reconfiguring Gatsby path");
        const newPath = await this.promptForGatsbyPath();
        if (!newPath) {
            return false;
        }
        
        try {
            await this.configService.saveGatsbyPath(newPath);
            vscode.window.showInformationMessage(`Gatsby path updated to: ${newPath}`);
            return true;
        } catch (error) {
            Logger.error("Failed to update Gatsby path", error);
            vscode.window.showErrorMessage(`Failed to update Gatsby path: ${error}`);
            return false;
        }
    }

    /**
     * Generate a preview URL for MDX content
     * @param contentFile The path to the MDX file
     * @returns The preview URL or undefined if not available
     */
    public async generatePreviewUrl(contentFile: string): Promise<string | undefined> {
        try {
            // Extract content type and slug from file path
            // Assuming content files are organized as content/{type}/{slug}/index.mdx
            // or content/{type}/{slug}.mdx
            const relativePath = path.relative(this.configService.getWorkspacePath(), contentFile);
            const pathParts = relativePath.split(path.sep);
            
            if (pathParts.length < 3 || pathParts[0] !== 'content') {
                vscode.window.showWarningMessage('Cannot determine content type and slug from file path');
                return undefined;
            }
            
            const contentType = pathParts[1];
            
            // Get slug - could be directory name or filename without extension
            let slug: string;
            if (pathParts[pathParts.length - 1] === 'index.mdx') {
                slug = pathParts[pathParts.length - 2];
            } else {
                slug = path.basename(pathParts[pathParts.length - 1], '.mdx');
            }
            
            // Get config for preview URLs
            const config = await this.configService.getConfig();
            if (!config || !config.previewUrls || !config.previewUrls[contentType]) {
                // Create example config to add to config.json
                const exampleConfig = {
                    [contentType]: {
                        urlPattern: contentType === 'blog' || contentType === 'post' 
                            ? '/blog/{slug}' 
                            : `/${contentType}/{slug}`
                    }
                };
                
                const exampleJson = JSON.stringify(exampleConfig, null, 2).replace(/^{\n/, '').replace(/}$/, '');
                
                vscode.window.showWarningMessage(
                    `No preview URL configuration found for content type '${contentType}'. ` +
                    `Add the following to your config.json under "previewUrls":`,
                    'Edit Config'
                ).then(selection => {
                    if (selection === 'Edit Config') {
                        this.showConfigUpdateDialog(contentType, exampleJson);
                    }
                });
                
                return undefined;
            }
            
            // Replace placeholders in URL pattern
            let url = config.previewUrls[contentType].urlPattern;
            url = url.replace('{slug}', slug);
            url = url.replace('{type}', contentType);
            
            return `${this.serverUrl}${url}`;
        } catch (error) {
            Logger.error('Error generating preview URL:', error);
            vscode.window.showErrorMessage(`Failed to generate preview URL: ${error}`);
            return undefined;
        }
    }
    
    /**
     * Show dialog to update config.json with missing preview URL pattern
     */
    private async showConfigUpdateDialog(contentType: string, exampleJson: string): Promise<void> {
        try {
            const config = await this.configService.getConfig();
            if (!config) {
                throw new Error('Config file not found');
            }
            
            // Create updated config with new preview URL
            const updatedConfig = { ...config };
            if (!updatedConfig.previewUrls) {
                updatedConfig.previewUrls = {};
            }
            
            // Set default URL pattern based on content type
            updatedConfig.previewUrls[contentType] = {
                urlPattern: contentType === 'blog' || contentType === 'post' 
                    ? '/blog/{slug}' 
                    : `/${contentType}/{slug}`
            };
            
            // Save the updated config
            await this.configService.saveConfig(updatedConfig);
            
            vscode.window.showInformationMessage(
                `Added preview URL for content type '${contentType}'. Try previewing again.`
            );
        } catch (error) {
            Logger.error('Failed to update config with preview URL pattern', error);
            vscode.window.showErrorMessage(
                'Failed to update config. Please add the preview URL pattern manually to your config.json file.'
            );
        }
    }

    /**
     * Generate launch.json for F5 experience
     */
    public async generateLaunchConfig(): Promise<void> {
        try {
            const workspaceRoot = this.configService.getWorkspacePath();
            if (!workspaceRoot) {
                vscode.window.showErrorMessage('No workspace found. Please open a workspace first.');
                return;
            }

            const gatsbyPath = await this.configService.getGatsbyPath();
            if (!gatsbyPath) {
                Logger.info("Gatsby path not configured, prompting for configuration before generating launch config");
                vscode.window.showInformationMessage(
                    "To set up F5 debugging, you need to configure your Gatsby site path first."
                );
                
                const path = await this.promptForGatsbyPath();
                if (!path) {
                    Logger.warn("User cancelled Gatsby path configuration during launch config setup");
                    vscode.window.showWarningMessage("F5 debugging setup was cancelled.");
                    return;
                }
                
                // Save the path to VS Code settings
                try {
                    await this.configService.saveGatsbyPath(path);
                    Logger.info(`Gatsby path configured: ${path}`);
                } catch (error) {
                    Logger.error("Failed to save Gatsby path during launch config setup", error);
                    vscode.window.showErrorMessage(
                        "Failed to save Gatsby path configuration. F5 debugging setup cancelled."
                    );
                    return;
                }
            }

            // Create .vscode directory if it doesn't exist
            const vscodeDir = path.join(workspaceRoot, '.vscode');
            if (!fs.existsSync(vscodeDir)) {
                fs.mkdirSync(vscodeDir, { recursive: true });
            }

            // Create or update launch.json

            // Use the configured port in the launch configuration
            const launchPath = path.join(vscodeDir, 'launch.json');
            
            // Define the launch configuration
            const launchConfig = {
                version: '0.2.0',
                configurations: [
                    {
                        type: 'chrome',
                        request: 'launch',
                        name: 'Launch Gatsby Preview',
                        url: `http://localhost:{config:onlinesalesCms.gatsbyPort}`,
                        webRoot: '${workspaceFolder}',
                        preLaunchTask: 'start-gatsby-server'
                    }
                ]
            };

            // Write launch.json
            fs.writeFileSync(launchPath, JSON.stringify(launchConfig, null, 2));

            // Create or update tasks.json with the port
            const tasksPath = path.join(vscodeDir, 'tasks.json');
            
            // Define the tasks configuration using dynamic variables and the port
            const tasksConfig = {
                version: '2.0.0',
                tasks: [
                    {
                        label: 'start-gatsby-server',
                        type: 'shell',
                        command: `cd "\${config:onlinesalesCms.gatsbyPath}" && git pull && nvm use && npm install && GATSBY_CONTENT_PATH="\${workspaceFolder}" PORT=\${config:onlinesalesCms.gatsbyPort} npm run start`,
                        isBackground: true,
                        problemMatcher: {
                            pattern: {
                                regexp: '.'
                            },
                            background: {
                                activeOnStart: true,
                                beginsPattern: 'starting development server',
                                endsPattern: 'You can now view .* in the browser'
                            }
                        },
                        options: {
                            env: {
                                GATSBY_CONTENT_PATH: '${workspaceFolder}',
                                PORT: `{config:onlinesalesCms.gatsbyPort}`
                            }
                        }
                    }
                ]
            };

            // Write tasks.json
            fs.writeFileSync(tasksPath, JSON.stringify(tasksConfig, null, 2));

            // Add .vscode/settings.json to .gitignore to prevent committing user-specific paths
            await this.configService.ensureGitIgnoreContains('.vscode/settings.json');

            vscode.window.showInformationMessage('F5 experience configured. Press F5 to preview your Gatsby site.');
        } catch (error) {
            Logger.error('Failed to generate launch configuration:', error);
            vscode.window.showErrorMessage(`Failed to generate launch configuration: ${error}`);
        }
    }

    /**
     * Checks if the Gatsby server is already running on the configured port
     * @returns Promise resolving to true if server is running, false otherwise
     */
    private async checkServerAlreadyRunning(): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            
            // Set a short timeout to avoid hanging for too long
            socket.setTimeout(1000);
            
            // Try to connect to the server
            socket.connect(this.port, '127.0.0.1', () => {
                Logger.info(`Found existing server on port ${this.port}`);
                socket.destroy();
                resolve(true);
            });
            
            // Handle errors (connection refused means port is not in use)
            socket.on('error', () => {
                socket.destroy();
                resolve(false);
            });
            
            // Handle timeouts
            socket.on('timeout', () => {
                Logger.info(`Connection to port ${this.port} timed out`);
                socket.destroy();
                resolve(false);
            });
        });
    }

    /**
     * Reuse or create a browser tab for the preview
     * @param url The URL to preview
     */
    public async openInBrowser(url: string): Promise<void> {
        try {
            await vscode.env.openExternal(vscode.Uri.parse(url));
        } catch (error) {
            Logger.error('Failed to open browser:', error);
            vscode.window.showErrorMessage(`Failed to open browser: ${error}`);
        }
    }

    /**
     * Restart the Gatsby server if it's already running
     */
    public async restartServer(): Promise<boolean> {
        try {
            // Stop the server if it's running
            if (this.isServerRunning && this.terminal) {
                this.terminal.dispose();
                this.terminal = undefined;
                this.isServerRunning = false;
                
                // Allow time for the server to shut down
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            // Start a new server instance
            return await this.startGatsbyServer();
        } catch (error) {
            Logger.error('Failed to restart server:', error);
            return false;
        }
    }
}
