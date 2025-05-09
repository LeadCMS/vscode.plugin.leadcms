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
        
        indexService = new IndexService(configService);
        const apiService = new ApiService(configService);
        const mediaService = new MediaService(apiService);
        const contentService = new ContentService(apiService, mediaService, indexService);
        const gitService = new GitService(configService);
        
        // Initialize new Gatsby and Preview services
        const gatsbyService = new GatsbyService(configService);
        const previewService = new PreviewService(gatsbyService);

        // Initialize file watcher if workspace exists
        let fileWatcherService: FileWatcherService | undefined;
        if (configService.hasWorkspace() && indexService) {
            fileWatcherService = new FileWatcherService(indexService, configService.getWorkspacePath());
            // Add to disposables
            context.subscriptions.push({ dispose: () => fileWatcherService?.dispose() });
            
            // Ensure .gitignore includes the VS Code settings file
            configService.ensureGitIgnoreContains('.vscode/settings.json').catch(error => {
                Logger.warn('Failed to update .gitignore:', error);
            });
            
            // Set up F5 experience
            gatsbyService.generateLaunchConfig().catch(error => {
                Logger.warn('Failed to set up F5 experience:', error);
            });
        }

        // Create validation service
        const validationService = new ValidationService(configService.getWorkspacePath());

        Logger.info('Services initialized, registering commands...');

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
                        const isGitInitialized = await gitService.initializeRepository();
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
                
                vscode.window.showInformationMessage('LeadCMS workspace initialized successfully.');
            } catch (error: any) {
                showErrorWithDetails('Failed to initialize workspace', error);
            }
        });
        
        // Command: Authenticate
        const authenticateCommand = vscode.commands.registerCommand('leadcms-vs-plugin.authenticate', async () => {
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
                    const isAuthenticated = await apiService.login(email, password, storePassword);
                    
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
        
        // Command: Pull Content
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
                        await contentService.pullContent();
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
        
        // Command: New Content
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

                await contentService.createNewContent(type, title, slug);
            } catch (error: any) {
                showErrorWithDetails('Failed to create new content', error);
            }
        });
        
        // Command: Push Content
        const pushContentCommand = vscode.commands.registerCommand('leadcms-vs-plugin.pushContent', async () => {
            try {
                if (!checkWorkspace()) {
                    return;
                }
                
                await contentService.pushContent();
            } catch (error: any) {
                // ContentService now handles AuthenticationError directly, but just in case:
                if (error instanceof AuthenticationError) {
                    await handleAuthenticationError(error);
                    return;
                }
                
                showErrorWithDetails('Failed to push content', error);
            }
        });
        
        // Add a new command to show pending changes
        const showChangesCommand = vscode.commands.registerCommand('leadcms-vs-plugin.showChanges', async () => {
            try {
                if (!checkWorkspace()) {
                    return;
                }
                
                await contentService.showChanges();
            } catch (error: any) {
                showErrorWithDetails('Failed to show changes', error);
            }   
        });

        // Register the unified content validation command
        const validateContentCommand = vscode.commands.registerCommand('leadcms.validateContent', async () => {
            try {
                if (!checkWorkspace()) {
                    return;
                }
                
                // Create the validation service
                const validationService = new ValidationService(configService.getWorkspacePath());
                
                // Show progress indicator while validating
                const problemCount = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Validating content...',
                    cancellable: false
                }, async (progress) => {
                    progress.report({ message: 'Checking content structure and media references...' });
                    return await validationService.validateAll();
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

        // Add the command to context subscriptions
        context.subscriptions.push(validateContentCommand);

        // Keep the old command for backward compatibility, but it won't appear in UI
        const validateMediaCommand = vscode.commands.registerCommand('leadcms.validateMedia', async () => {
            // Just redirect to the unified command
            vscode.commands.executeCommand('leadcms.validateContent');
        });

        context.subscriptions.push(validateMediaCommand);

        // Command: Preview MDX
        const previewMdxCommand = vscode.commands.registerCommand('leadcms-vs-plugin.previewMDX', async () => {
            try {
                if (!checkWorkspace()) {
                    return;
                }
                
                await previewService.previewMDX();
            } catch (error: any) {
                showErrorWithDetails('Failed to preview MDX', error);
            }
        });
        
        // Add a new command to open preview in browser
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
                const isServerRunning = await gatsbyService.ensureGatsbyServerRunning();
                if (!isServerRunning) {
                    vscode.window.showErrorMessage('Failed to start Gatsby development server.');
                    return;
                }
                
                // Generate preview URL
                const previewUrl = await gatsbyService.generatePreviewUrl(editor.document.uri.fsPath);
                if (!previewUrl) {
                    vscode.window.showErrorMessage('Failed to generate preview URL.');
                    return;
                }
                
                // Open in browser
                await gatsbyService.openInBrowser(previewUrl);
            } catch (error: any) {
                showErrorWithDetails('Failed to preview in browser', error);
            }
        });

        // Add file change listener for auto-validation
        const fileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(configService.getWorkspacePath(), '{content/**/*.mdx,content/**/*.json}')
        );
        
        fileWatcher.onDidChange(async (uri) => {
            await validationService.validateFile(uri.fsPath);
        });

        fileWatcher.onDidCreate(async (uri) => {
            await validationService.validateFile(uri.fsPath);
        });
        
        context.subscriptions.push(fileWatcher);
        
        // Add a new command to reconfigure Gatsby port
        const configureGatsbyPortCommand = vscode.commands.registerCommand('leadcms-vs-plugin.configureGatsbyPort', async () => {
            try {
                if (!checkWorkspace()) {
                    return;
                }
                
                const port = await gatsbyService.promptForPort();
                if (port) {
                    await gatsbyService.configurePort(port);
                    vscode.window.showInformationMessage(`Gatsby port configured to ${port}`);
                    
                    // Regenerate the launch configuration with the new port
                    await gatsbyService.generateLaunchConfig();
                }
            } catch (error: any) {
                showErrorWithDetails('Failed to configure Gatsby port', error);
            }
        });

        // Register all commands
        Logger.info('Pushing commands to subscriptions...');
        context.subscriptions.push(showLogsCommand);
        context.subscriptions.push(initializeWorkspaceCommand);
        context.subscriptions.push(authenticateCommand);
        context.subscriptions.push(pullContentCommand);
        context.subscriptions.push(newContentCommand);
        context.subscriptions.push(pushContentCommand);
        context.subscriptions.push(showChangesCommand); 
        context.subscriptions.push(previewMdxCommand);
        context.subscriptions.push(configureGatsbyPortCommand);
        context.subscriptions.push(previewInBrowserCommand);
        
        // Add previewService to subscriptions for proper disposal
        context.subscriptions.push({ dispose: () => previewService.dispose() });

        // Only show the ready notification if we have a workspace
        if (configService.hasWorkspace()) {
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