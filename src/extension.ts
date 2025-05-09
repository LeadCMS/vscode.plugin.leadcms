import * as vscode from 'vscode';
import { ConfigService } from './services/config-service';
import { ApiService } from './services/api-service';
import { ContentService } from './services/content-service';
import { MediaService } from './services/media-service';
import { GitService } from './services/git-service';
import { LeadCMSConfig, TokenConfig } from './models/config';
import { Logger } from './utils/logger';
import { AuthenticationError } from './utils/errors';
import { IndexService } from './services/index-service';
import { FileWatcherService } from './services/file-watcher-service';
import { GatsbyService } from './services/gatsby-service';
import { PreviewService } from './services/preview-service';
import * as fs from 'fs-extra';
import * as path from 'path';
import { 
    showError, 
    showErrorWithDetails, 
    handleAuthenticationError, 
    showWorkspaceRequiredError,
    showActivationError
} from './utils/ui-helpers';
import { ValidationService } from './validation/validation-service';

// Keep track of service instances for proper disposal
let indexService: IndexService | undefined;

export function activate(context: vscode.ExtensionContext) {
    // Initialize the logger
    Logger.init();
    
    // Log activation with more details
    Logger.info('Activating LeadCMS CMS extension...');
    
    try {
        const configService = new ConfigService();
        // Add configService to context.subscriptions for proper disposal
        context.subscriptions.push({ dispose: () => configService.dispose() });
        
        // Check if we have a workspace and if it has a .leadcms folder
        let hasLeadCmsFolder = false;
        if (configService.hasWorkspace()) {
            const workspacePath = configService.getWorkspacePath();
            const leadCmsPath = path.join(workspacePath, '.leadcms');
            hasLeadCmsFolder = fs.existsSync(leadCmsPath);
            
            if (hasLeadCmsFolder) {
                Logger.info('Found .leadcms folder in workspace, initializing services');
            } else {
                Logger.info('No .leadcms folder found. Extension will be minimally activated.');
            }
        }
        
        // Initialize services if we have a .leadcms folder
        let apiService: ApiService | undefined;
        let mediaService: MediaService | undefined;
        let contentService: ContentService | undefined;
        let gitService: GitService | undefined;
        let gatsbyService: GatsbyService | undefined;
        let previewService: PreviewService | undefined;
        let fileWatcherService: FileWatcherService | undefined;
        let validationService: ValidationService | undefined;
        
        // Only initialize services if we have a .leadcms folder
        if (hasLeadCmsFolder) {
            indexService = new IndexService(configService);
            apiService = new ApiService(configService);
            mediaService = new MediaService(apiService);
            contentService = new ContentService(apiService, mediaService, indexService);
            gitService = new GitService(configService);
            
            // Initialize new Gatsby and Preview services
            gatsbyService = new GatsbyService(configService);
            previewService = new PreviewService(gatsbyService);

            // Initialize file watcher
            if (indexService) {
                fileWatcherService = new FileWatcherService(indexService, configService.getWorkspacePath());
                // Add to disposables
                context.subscriptions.push({ dispose: () => fileWatcherService?.dispose() });
                
                // Ensure .gitignore includes the VS Code settings file
                configService.ensureGitIgnoreContains('.vscode/settings.json').catch(error => {
                    Logger.warn('Failed to update .gitignore:', error);
                });
                
                // Set up F5 experience
                if (gatsbyService) {
                    gatsbyService.generateLaunchConfig().catch(error => {
                        Logger.warn('Failed to set up F5 experience:', error);
                    });
                }
            }

            // Create validation service
            validationService = new ValidationService(configService.getWorkspacePath());
        }

        Logger.info('Registering commands...');

        // Function to check workspace availability when the command is executed
        function checkWorkspace(): boolean {
            if (!configService.hasWorkspace()) {
                showWorkspaceRequiredError();
                return false;
            }
            return true;
        }

        // Command: Show Logs
        const showLogsCommand = vscode.commands.registerCommand('leadcms-vs-plugin.showLogs', () => {
            Logger.show();
        });

        // Command: Initialize Workspace
        const initializeWorkspaceCommand = vscode.commands.registerCommand('leadcms-vs-plugin.initializeWorkspace', async () => {
            try {
                Logger.info('Executing initialize workspace command...');
                
                if (!checkWorkspace()) {
                    return;
                }
                
                const domain = await vscode.window.showInputBox({
                    prompt: 'Enter LeadCMS instance domain (e.g., https://cms.leadcms.ai)',
                    placeHolder: 'https://cms.leadcms.ai',
                    validateInput: input => {
                        return input && input.trim().length > 0 ? null : 'Domain is required';
                    }
                });
                
                if (!domain) {
                    showError('Domain is required to initialize workspace.');
                    return;
                }
                
                const config: LeadCMSConfig = {
                    domain: domain.trim(),
                    // Add default preview URL patterns for common content types
                    previewUrls: {
                        page: {
                            urlPattern: '/{slug}'
                        },
                        post: {
                            urlPattern: '/blog/{slug}'
                        },
                        release: {
                            urlPattern: '/releases/{slug}'
                        }
                    }
                };
                
                // Initialize configService if not already done
                if (!gitService) {
                    gitService = new GitService(configService);
                }
                
                // Show progress during initialization
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Initializing LeadCMS workspace...',
                    cancellable: false
                }, async (progress) => {
                    // Step 1: Save config and create directory structure
                    progress.report({ message: 'Creating directory structure...', increment: 20 });
                    await configService.saveConfig(config);
                    await configService.ensureDirectoriesExist();
                    
                    // Step 2: Initialize Git repository
                    progress.report({ message: 'Initializing Git repository...', increment: 30 });
                    try {
                        const isGitInitialized = await gitService!.initializeRepository();
                        if (isGitInitialized) {
                            progress.report({ message: 'Git repository initialized', increment: 10 });
                        } else {
                            progress.report({ message: 'Skipped Git initialization', increment: 10 });
                        }
                    } catch (gitError) {
                        Logger.warn('Git initialization failed:', gitError);
                        vscode.window.showWarningMessage(`Git initialization failed: ${gitError instanceof Error ? gitError.message : 'Unknown error'}. Continuing without Git.`);
                        progress.report({ message: 'Continuing without Git...', increment: 10 });
                    }
                    
                    // Initialize services if they don't exist yet
                    if (!indexService) {
                        indexService = new IndexService(configService);
                    }
                    
                    if (!apiService) {
                        apiService = new ApiService(configService);
                    }
                    
                    if (!mediaService) {
                        mediaService = new MediaService(apiService);
                    }
                    
                    if (!contentService) {
                        contentService = new ContentService(apiService, mediaService, indexService);
                    }
                    
                    if (!gatsbyService) {
                        gatsbyService = new GatsbyService(configService);
                    }
                    
                    if (!previewService) {
                        previewService = new PreviewService(gatsbyService);
                    }
                    
                    // New Step 3: Configure Gatsby path and port
                    progress.report({ message: 'Configuring Gatsby preview...', increment: 10 });
                    
                    const configureGatsby = await vscode.window.showQuickPick(['Yes', 'No'], {
                        placeHolder: 'Do you want to configure Gatsby for content preview?',
                        canPickMany: false
                    });
                    
                    if (configureGatsby === 'Yes') {
                        vscode.window.showInformationMessage(
                            'Please select the path to your Gatsby site for content preview.'
                        );
                        
                        const gatsbyPath = await gatsbyService.promptForGatsbyPath();
                        if (gatsbyPath) {
                            try {
                                await configService.saveGatsbyPath(gatsbyPath);
                                progress.report({ message: 'Gatsby path configured', increment: 10 });
                                
                                // Add port configuration
                                const useCustomPort = await vscode.window.showQuickPick(['Yes', 'No'], {
                                    placeHolder: 'Do you want to use a custom port for Gatsby? (Default is 8000)',
                                    canPickMany: false
                                });
                                
                                if (useCustomPort === 'Yes') {
                                    const port = await gatsbyService.promptForPort();
                                    if (port) {
                                        await gatsbyService.configurePort(port);
                                        progress.report({ message: `Gatsby port set to ${port}`, increment: 5 });
                                    }
                                }
                                
                                // Configure F5 experience
                                progress.report({ message: 'Setting up F5 debugging...', increment: 5 });
                                await gatsbyService.generateLaunchConfig();
                                progress.report({ message: 'F5 debugging configured', increment: 10 });
                            } catch (error) {
                                Logger.warn('Failed to save Gatsby configuration:', error);
                                vscode.window.showWarningMessage('Failed to save Gatsby configuration. You can configure it later using the Preview command.');
                                progress.report({ message: 'Continuing without Gatsby configuration', increment: 30 });
                            }
                        } else {
                            Logger.info('User skipped Gatsby path configuration');
                            progress.report({ message: 'Skipped Gatsby configuration', increment: 30 });
                        }
                    } else {
                        Logger.info('User chose not to configure Gatsby');
                        progress.report({ message: 'Skipped Gatsby configuration', increment: 30 });
                    }
                });
                
                // Initialize file watcher for the newly set up workspace
                if (!fileWatcherService && indexService) {
                    fileWatcherService = new FileWatcherService(indexService, configService.getWorkspacePath());
                    // Add to disposables
                    context.subscriptions.push({ dispose: () => fileWatcherService?.dispose() });
                }
                
                // Create validation service if it doesn't exist
                if (!validationService) {
                    validationService = new ValidationService(configService.getWorkspacePath());
                }
                
                // Update the hasLeadCmsFolder flag since we just created it
                hasLeadCmsFolder = true;
                
                vscode.window.showInformationMessage('LeadCMS workspace initialized successfully.');
                
                // Inform user to restart or reload window for full extension activation
                const reload = await vscode.window.showInformationMessage(
                    'To complete activation, please reload the VS Code window.',
                    'Reload Window'
                );
                
                if (reload === 'Reload Window') {
                    await vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            } catch (error: any) {
                showErrorWithDetails('Failed to initialize workspace', error);
            }
        });
        
        // Command: Authenticate
        // Only register handler if we have a workspace with .leadcms
        const authenticateCommand = vscode.commands.registerCommand('leadcms-vs-plugin.authenticate', async () => {
            if (!hasLeadCmsFolder) {
                vscode.window.showErrorMessage('Please initialize your workspace with LeadCMS first.');
                return;
            }
            
            try {
                if (!checkWorkspace()) {
                    return;
                }
                
                // Get email
                const email = await vscode.window.showInputBox({
                    prompt: 'Enter your LeadCMS email',
                    placeHolder: 'email@example.com',
                    validateInput: input => {
                        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                        return input && emailRegex.test(input) ? null : 'Please enter a valid email address';
                    }
                });
                
                if (!email) {
                    showError('Email is required for authentication.');
                    return;
                }
                
                // Get password
                const password = await vscode.window.showInputBox({
                    prompt: 'Enter your LeadCMS password',
                    password: true, // Hide input
                    validateInput: input => {
                        return input && input.trim().length > 0 ? null : 'Password is required';
                    }
                });
                
                if (!password) {
                    showError('Password is required for authentication.');
                    return;
                }
                
                // Ask if user wants to save password for auto-refresh - default to Yes for better experience
                const savePassword = await vscode.window.showQuickPick(
                    ['Yes, store password and allow auto-refresh (recommended)', 'No, prompt me when token expires'], 
                    { 
                        placeHolder: 'Save password for automatic token refresh?',
                        canPickMany: false
                    }
                );
                
                const storePassword = savePassword !== 'No, prompt me when token expires'; // Default to yes if dialog is dismissed
                
                // Show progress during login
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Authenticating with LeadCMS...",
                    cancellable: false
                }, async (progress) => {
                    progress.report({ increment: 50 });
                    
                    // Perform login with proper password storage parameter
                    const isAuthenticated = await apiService!.login(email, password, storePassword);
                    
                    if (isAuthenticated) {
                        progress.report({ increment: 50 });
                        
                        let message = 'Authentication successful.';
                        if (storePassword) {
                            message += ' Password stored for automatic token refresh.';
                        } else {
                            message += ' You will be prompted when token expires.';
                        }
                        
                        vscode.window.showInformationMessage(message);
                    } else {
                        throw new Error('Failed to authenticate. Please check your credentials.');
                    }
                });
            } catch (error: any) {
                showErrorWithDetails('Authentication failed', error);
            }
        });
        
        // Only register the remaining commands if we have a workspace with .leadcms
        // Create an array of commands that depend on .leadcms being initialized
        const leadcmsCommands = [];
        
        // Command: Pull Content
        if (hasLeadCmsFolder && contentService) {
            const pullContentCommand = vscode.commands.registerCommand('leadcms-vs-plugin.pullContent', async () => {
                try {
                    if (!checkWorkspace()) {
                        return;
                    }

                    // Check if workspace is initialized properly
                    const config = await configService.getConfig();
                    if (!config) {
                        vscode.window.showErrorMessage(
                            'Workspace is not initialized. Please run "Initialize Workspace" command first.'
                        );
                        return;
                    }

                    // Check if token exists and prompt if not
                    const token = await configService.getToken();
                    if (!token || !token.accessToken) {
                        const response = await vscode.window.showErrorMessage(
                            'Authentication required. You need to set your access token.',
                            'Authenticate Now'
                        );
                        
                        if (response === 'Authenticate Now') {
                            // Call the authenticate command
                            await vscode.commands.executeCommand('leadcms-vs-plugin.authenticate');
                            return;
                        }
                        return;
                    }
                    
                    // Show progress indicator
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "Pulling content from LeadCMS CMS...",
                        cancellable: false
                    }, async (progress) => {
                        progress.report({ increment: 0 });
                        
                        try {
                            await contentService!.pullContent();
                            progress.report({ increment: 100 });
                        } catch (error) {
                            // Let the outer catch handle this
                            throw error;
                        }
                    });
                } catch (error: any) {
                    // Special handling for authentication errors
                    if (error instanceof AuthenticationError) {
                        await handleAuthenticationError(error);
                        return;
                    }
                    
                    // Regular error handling for other errors
                    const errorDetails = error.stack || error.message || String(error);
                    Logger.error('Pull content error details:', errorDetails);
                    
                    // Show a more user-friendly error message
                    let errorMessage = `Failed to pull content: ${error.message}`;
                    if (error.message?.includes('path')) {
                        errorMessage = 'Error processing content: The content structure returned by the API is not as expected. Check the API endpoint and format.';
                    }
                    
                    vscode.window.showErrorMessage(errorMessage, 'View Details')
                        .then(selection => {
                            if (selection === 'View Details') {
                                Logger.show();
                            }
                        });
                }
            });
            leadcmsCommands.push(pullContentCommand);
        }
        
        // Command: New Content
        if (hasLeadCmsFolder && contentService) {
            const newContentCommand = vscode.commands.registerCommand('leadcms-vs-plugin.newContent', async () => {
                try {
                    if (!checkWorkspace()) {
                        return;
                    }
                    
                    const type = await vscode.window.showQuickPick(['page', 'post', 'release'], {
                        placeHolder: 'Select content type'
                    });
                    
                    if (!type) {
                        return;
                    }

                    const title = await vscode.window.showInputBox({
                        prompt: 'Enter content title',
                        validateInput: input => {
                            return input && input.trim().length > 0 ? null : 'Title is required';
                        }
                    });
                    
                    if (!title) {
                        return;
                    }

                    let suggestedSlug = title
                        .trim()
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/^-|-$/g, '');
                    
                    const slug = await vscode.window.showInputBox({
                        prompt: 'Enter content slug',
                        value: suggestedSlug,
                        validateInput: input => {
                            return input && input.trim().length > 0 ? null : 'Slug is required';
                        }
                    });
                    
                    if (!slug) {
                        return;
                    }

                    await contentService!.createNewContent(type, title, slug);
                } catch (error: any) {
                    showErrorWithDetails('Failed to create new content', error);
                }
            });
            leadcmsCommands.push(newContentCommand);
        }
        
        // Command: Push Content
        if (hasLeadCmsFolder && contentService) {
            const pushContentCommand = vscode.commands.registerCommand('leadcms-vs-plugin.pushContent', async () => {
                try {
                    if (!checkWorkspace()) {
                        return;
                    }
                    
                    await contentService!.pushContent();
                } catch (error: any) {
                    // ContentService now handles AuthenticationError directly, but just in case:
                    if (error instanceof AuthenticationError) {
                        await handleAuthenticationError(error);
                        return;
                    }
                    
                    showErrorWithDetails('Failed to push content', error);
                }
            });
            leadcmsCommands.push(pushContentCommand);
        }
        
        // Command: Show Changes
        if (hasLeadCmsFolder && contentService) {
            const showChangesCommand = vscode.commands.registerCommand('leadcms-vs-plugin.showChanges', async () => {
                try {
                    if (!checkWorkspace()) {
                        return;
                    }
                    
                    await contentService!.showChanges();
                } catch (error: any) {
                    showErrorWithDetails('Failed to show changes', error);
                }   
            });
            leadcmsCommands.push(showChangesCommand);
        }

        // Register the unified content validation command
        if (hasLeadCmsFolder && validationService) {
            const validateContentCommand = vscode.commands.registerCommand('leadcms.validateContent', async () => {
                try {
                    if (!checkWorkspace()) {
                        return;
                    }
                    
                    // Show progress indicator while validating
                    const problemCount = await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: 'Validating content...',
                        cancellable: false
                    }, async (progress) => {
                        progress.report({ message: 'Checking content structure and media references...' });
                        return await validationService!.validateAll();
                    });
                    
                    if (problemCount === 0) {
                        vscode.window.showInformationMessage('Content validation passed. No issues found.');
                    } else {
                        vscode.window.showWarningMessage(
                            `Found ${problemCount} issues with your content. Check Problems panel for details.`
                        );
                    }
                } catch (error) {
                    showErrorWithDetails('Error validating content', error);
                }
            });
            leadcmsCommands.push(validateContentCommand);

            // Keep the old command for backward compatibility, but it won't appear in UI
            const validateMediaCommand = vscode.commands.registerCommand('leadcms.validateMedia', async () => {
                // Just redirect to the unified command
                vscode.commands.executeCommand('leadcms.validateContent');
            });
            leadcmsCommands.push(validateMediaCommand);
        }

        // Command: Preview MDX
        if (hasLeadCmsFolder && previewService) {
            const previewMdxCommand = vscode.commands.registerCommand('leadcms-vs-plugin.previewMDX', async () => {
                try {
                    if (!checkWorkspace()) {
                        return;
                    }
                    
                    await previewService!.previewMDX();
                } catch (error: any) {
                    showErrorWithDetails('Failed to preview MDX', error);
                }
            });
            leadcmsCommands.push(previewMdxCommand);
        }
        
        // Command: Preview in browser
        if (hasLeadCmsFolder && gatsbyService) {
            const previewInBrowserCommand = vscode.commands.registerCommand('leadcms-vs-plugin.previewInBrowser', async () => {
                try {
                    if (!checkWorkspace()) {
                        return;
                    }
                    
                    const editor = vscode.window.activeTextEditor;
                    if (!editor || !editor.document.fileName.toLowerCase().endsWith('.mdx')) {
                        vscode.window.showErrorMessage('Please open an MDX file first.');
                        return;
                    }
                    
                    // Ensure server is running
                    const isServerRunning = await gatsbyService!.ensureGatsbyServerRunning();
                    if (!isServerRunning) {
                        vscode.window.showErrorMessage('Failed to start Gatsby development server.');
                        return;
                    }
                    
                    // Generate preview URL
                    const previewUrl = await gatsbyService!.generatePreviewUrl(editor.document.uri.fsPath);
                    if (!previewUrl) {
                        vscode.window.showErrorMessage('Failed to generate preview URL.');
                        return;
                    }
                    
                    // Open in browser
                    await gatsbyService!.openInBrowser(previewUrl);
                } catch (error: any) {
                    showErrorWithDetails('Failed to preview in browser', error);
                }
            });
            leadcmsCommands.push(previewInBrowserCommand);
        }
        
        // Add file change listener for auto-validation
        if (hasLeadCmsFolder && validationService) {
            const fileWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(configService.getWorkspacePath(), '{content/**/*.mdx,content/**/*.json}')
            );
            
            fileWatcher.onDidChange(async (uri) => {
                await validationService!.validateFile(uri.fsPath);
            });

            fileWatcher.onDidCreate(async (uri) => {
                await validationService!.validateFile(uri.fsPath);
            });
            
            context.subscriptions.push(fileWatcher);
        }
        
        // Command: Configure Gatsby port
        if (hasLeadCmsFolder && gatsbyService) {
            const configureGatsbyPortCommand = vscode.commands.registerCommand('leadcms-vs-plugin.configureGatsbyPort', async () => {
                try {
                    if (!checkWorkspace()) {
                        return;
                    }
                    
                    const port = await gatsbyService!.promptForPort();
                    if (port) {
                        await gatsbyService!.configurePort(port);
                        vscode.window.showInformationMessage(`Gatsby port configured to ${port}`);
                        
                        // Regenerate the launch configuration with the new port
                        await gatsbyService!.generateLaunchConfig();
                    }
                } catch (error: any) {
                    showErrorWithDetails('Failed to configure Gatsby port', error);
                }
            });
            leadcmsCommands.push(configureGatsbyPortCommand);
        }

        // Command: Reset for new CMS instance
        if (hasLeadCmsFolder) {
            const resetForNewInstanceCommand = vscode.commands.registerCommand('leadcms-vs-plugin.resetForNewInstance', async () => {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    vscode.window.showErrorMessage('No workspace folder open.');
                    return;
                }
                const workspacePath = workspaceFolders[0].uri.fsPath;
                const contentDir = path.join(workspacePath, 'content');
                const indexPath = path.join(workspacePath, '.leadcms', 'content-index.json');
                // 1. Remove id and publishedAt from all .json files
                let jsonFiles: string[] = [];
                const findJsonFiles = async (dir: string) => {
                    const entries = await fs.readdir(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            await findJsonFiles(fullPath);
                        } else if (entry.isFile() && entry.name.endsWith('.json')) {
                            jsonFiles.push(fullPath);
                        }
                    }
                };
                await findJsonFiles(contentDir);
                for (const file of jsonFiles) {
                    try {
                        const data = await fs.readJson(file);
                        let changed = false;
                        if ('id' in data) {
                            delete data.id;
                            changed = true;
                        }
                        if ('publishedAt' in data) {
                            delete data.publishedAt;
                            changed = true;
                        }
                        if (changed) {
                            await fs.writeJson(file, data, { spaces: 2 });
                        }
                    } catch (err) {
                        // Ignore parse errors
                    }
                }
                // 2. Reset status in content-index.json
                if (await fs.pathExists(indexPath)) {
                    const index = await fs.readJson(indexPath);
                    let changed = false;
                    for (const [relPath, entryRaw] of Object.entries(index.entries || {})) {
                        const entry = entryRaw as any;
                        if (relPath.endsWith('.json') || relPath.endsWith('.mdx')) {
                            if (entry.status !== 'new' || entry.id !== `local:${relPath}` || entry.lastModifiedRemote) {
                                entry.status = 'new';
                                entry.lastModifiedLocal = new Date();
                                entry.id = `local:${relPath}`;
                                delete entry.lastModifiedRemote;
                                delete entry.lastSyncedAt;
                                changed = true;
                            }
                        }
                    }
                    if (changed) {
                        await fs.writeJson(indexPath, index, { spaces: 2 });
                    }
                }
                vscode.window.showInformationMessage('All content reset for new CMS instance.');
            });
            leadcmsCommands.push(resetForNewInstanceCommand);
        }

        // Register all commands
        Logger.info('Pushing commands to subscriptions...');
        context.subscriptions.push(showLogsCommand);
        context.subscriptions.push(initializeWorkspaceCommand);
        context.subscriptions.push(authenticateCommand);
        
        // Register the conditional commands
        for (const command of leadcmsCommands) {
            context.subscriptions.push(command);
        }
        
        // Add service instances to subscriptions for proper disposal if they exist
        if (previewService) {
            const service = previewService; // Capture current value
            context.subscriptions.push({ dispose: () => service.dispose() });
        }

        // Only show the ready notification if we have a workspace with .leadcms
        if (hasLeadCmsFolder) {
            vscode.window.showInformationMessage('LeadCMS CMS extension is now ready.');
        }
        
        Logger.info('LeadCMS CMS extension successfully activated!');
    } catch (error) {
        showActivationError(error);
    }
}

export function deactivate() {
    // Properly dispose of services
    if (indexService) {
        indexService.dispose();
        indexService = undefined;
    }
    
    Logger.info('LeadCMS CMS extension deactivated');
}