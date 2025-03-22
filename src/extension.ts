import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { ConfigService } from './services/config-service';
import { ApiService } from './services/api-service';
import { ContentService } from './services/content-service';
import { MediaService } from './services/media-service';
import { GitService } from './services/git-service';
import { OnlineSalesConfig, TokenConfig } from './models/config';
import { Logger } from './utils/logger';
import { AuthenticationError } from './utils/errors';
import { IndexService } from './services/index-service';
import { FileWatcherService } from './services/file-watcher-service';
import { MediaValidationService } from './services/media-validation-service';
import { 
    showError, 
    showErrorWithDetails, 
    showErrorWithLogsOption, 
    handleAuthenticationError, 
    showWorkspaceRequiredError,
    showActivationError
} from './utils/ui-helpers';

export function activate(context: vscode.ExtensionContext) {
    // Initialize the logger
    Logger.init();
    
    // Log activation with more details
    Logger.info('Activating OnlineSales CMS extension...');
    
    try {
        const configService = new ConfigService();
        // Add configService to context.subscriptions for proper disposal
        context.subscriptions.push({ dispose: () => configService.dispose() });
        
        const apiService = new ApiService(configService);
        const mediaService = new MediaService(apiService);
        const indexService = new IndexService(configService);
        const contentService = new ContentService(apiService, mediaService, indexService);
        const gitService = new GitService(configService);

        // Initialize file watcher if workspace exists
        let fileWatcherService: FileWatcherService | undefined;
        if (configService.hasWorkspace()) {
            fileWatcherService = new FileWatcherService(indexService, configService.getWorkspacePath());
            // Add to disposables
            context.subscriptions.push({ dispose: () => fileWatcherService?.dispose() });
        }

        // Initialize the new media validation service
        const mediaValidationService = new MediaValidationService(configService.getWorkspacePath(), mediaService);

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
        const showLogsCommand = vscode.commands.registerCommand('onlinesales-vs-plugin.showLogs', () => {
            Logger.show();
        });

        // Command: Initialize Workspace
        const initializeWorkspaceCommand = vscode.commands.registerCommand('onlinesales-vs-plugin.initializeWorkspace', async () => {
            try {
                Logger.info('Executing initialize workspace command...');
                
                if (!checkWorkspace()) {
                    return;
                }
                
                const domain = await vscode.window.showInputBox({
                    prompt: 'Enter OnlineSales instance domain (e.g., https://cms.waveservice.app)',
                    placeHolder: 'https://cms.waveservice.app',
                    validateInput: input => {
                        return input && input.trim().length > 0 ? null : 'Domain is required';
                    }
                });
                
                if (!domain) {
                    showError('Domain is required to initialize workspace.');
                    return;
                }
                
                // Ask about local media references
                const useLocalMediaReferences = await vscode.window.showQuickPick(['Yes', 'No'], {
                    placeHolder: 'Replace remote media URLs with local references?',
                    canPickMany: false
                });
                
                const config: OnlineSalesConfig = {
                    domain: domain.trim(),
                    useLocalMediaReferences: useLocalMediaReferences === 'Yes'
                };
                
                // Show progress during initialization
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Initializing OnlineSales workspace...',
                    cancellable: false
                }, async (progress) => {
                    // Step 1: Save config and create directory structure
                    progress.report({ message: 'Creating directory structure...', increment: 20 });
                    await configService.saveConfig(config);
                    await configService.ensureDirectoriesExist();
                    
                    // Step 2: Initialize Git repository
                    progress.report({ message: 'Initializing Git repository...', increment: 40 });
                    try {
                        const isGitInitialized = await gitService.initializeRepository();
                        if (isGitInitialized) {
                            progress.report({ message: 'Git repository initialized', increment: 40 });
                        } else {
                            progress.report({ message: 'Skipped Git initialization', increment: 40 });
                        }
                    } catch (gitError) {
                        Logger.warn('Git initialization failed:', gitError);
                        vscode.window.showWarningMessage(`Git initialization failed: ${gitError instanceof Error ? gitError.message : 'Unknown error'}. Continuing without Git.`);
                        progress.report({ message: 'Continuing without Git...', increment: 40 });
                    }
                });
                
                // Initialize file watcher for the newly set up workspace
                if (!fileWatcherService) {
                    fileWatcherService = new FileWatcherService(indexService, configService.getWorkspacePath());
                    // Add to disposables
                    context.subscriptions.push({ dispose: () => fileWatcherService?.dispose() });
                }
                
                vscode.window.showInformationMessage('OnlineSales workspace initialized successfully.');
            } catch (error: any) {
                showErrorWithDetails('Failed to initialize workspace', error);
            }
        });
        
        // Command: Authenticate
        const authenticateCommand = vscode.commands.registerCommand('onlinesales-vs-plugin.authenticate', async () => {
            try {
                if (!checkWorkspace()) {
                    return;
                }
                
                const token = await vscode.window.showInputBox({
                    prompt: 'Enter your OnlineSales access token',
                    password: true,
                    validateInput: input => {
                        return input && input.trim().length > 0 ? null : 'Access token is required';
                    }
                });
                
                if (!token) {
                    showError('Access token is required for authentication.');
                    return;
                }
                
                const tokenConfig: TokenConfig = {
                    accessToken: token.trim()
                };

                await configService.saveToken(tokenConfig);
                const isInitialized = await apiService.initialize();
                
                if (isInitialized) {
                    vscode.window.showInformationMessage('Authentication successful.');
                } else {
                    showError('Failed to authenticate with OnlineSales API.');
                }
            } catch (error: any) {
                showErrorWithDetails('Authentication failed', error);
            }
        });
        
        // Command: Pull Content
        const pullContentCommand = vscode.commands.registerCommand('onlinesales-vs-plugin.pullContent', async () => {
            try {
                if (!checkWorkspace()) {
                    return;
                }
                
                // Show progress indicator
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Pulling content from OnlineSales CMS...",
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
        const newContentCommand = vscode.commands.registerCommand('onlinesales-vs-plugin.newContent', async () => {
            try {
                if (!checkWorkspace()) {
                    return;
                }
                
                const type = await vscode.window.showQuickPick(['blog', 'page'], {
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
        const pushContentCommand = vscode.commands.registerCommand('onlinesales-vs-plugin.pushContent', async () => {
            try {
                if (!checkWorkspace()) {
                    return;
                }
                
                await contentService.pushContent();
            } catch (error: any) {
                // Special handling for authentication errors
                if (error instanceof AuthenticationError) {
                    await handleAuthenticationError(error);
                    return;
                }
                
                showErrorWithDetails('Failed to push content', error);
            }
        });
        
        // Add a new command to show pending changes
        const showChangesCommand = vscode.commands.registerCommand('onlinesales-vs-plugin.showChanges', async () => {
            try {
                if (!checkWorkspace()) {
                    return;
                }
                
                await contentService.showChanges();
            } catch (error: any) {
                showErrorWithDetails('Failed to show changes', error);
            }   
        });
        
        // Add debug commands
        // Command: Debug Index
        const debugIndexCommand = vscode.commands.registerCommand('onlinesales-vs-plugin.debugIndex', async () => {
            try {
                if (!checkWorkspace()) {
                    return;
                }
                
                await indexService.listIndexedFiles();
                vscode.window.showInformationMessage('Index contents logged. Check the logs for details.');
            } catch (error: any) {
                showErrorWithDetails('Failed to list indexed files', error);
            }
        });
        
        // Command: Mark File as Renamed
        const markRenamedCommand = vscode.commands.registerCommand('onlinesales-vs-plugin.markRenamed', async () => {
            try {
                if (!checkWorkspace()) {
                    return;
                }
                
                const oldPath = await vscode.window.showInputBox({
                    prompt: 'Enter original file path (relative to workspace)',
                    placeHolder: 'media/image.jpg',
                    validateInput: input => {
                        return input && input.trim().length > 0 ? null : 'Path is required';
                    }
                });
                
                if (!oldPath) {
                    return;
                }
                
                const newPath = await vscode.window.showInputBox({
                    prompt: 'Enter new file path (relative to workspace)',
                    placeHolder: 'media/renamed-image.jpg',
                    validateInput: input => {
                        return input && input.trim().length > 0 ? null : 'Path is required';
                    }
                });
                
                if (!newPath) {
                    return;
                }
                
                // Convert to absolute paths
                const oldAbsPath = path.join(configService.getWorkspacePath(), oldPath.trim());
                const newAbsPath = path.join(configService.getWorkspacePath(), newPath.trim());
                
                // Check if new file exists
                if (!(await fs.pathExists(newAbsPath))) {
                    showError(`New file does not exist: ${newPath}`);
                    return;
                }
                
                await indexService.markFileRenamed(oldAbsPath, newAbsPath);
                vscode.window.showInformationMessage(`File marked as renamed: ${oldPath} -> ${newPath}`);
                
                // Refresh changes view
                await contentService.showChanges();
            } catch (error: any) {
                showErrorWithDetails('Failed to mark file as renamed', error);
            }
        });

        // Command: Validate Media References
        const validateMediaCommand = vscode.commands.registerCommand('onlinesales.validateMedia', async () => {
            try {
                const problemCount = await mediaValidationService.validateAllMediaReferences();
                
                if (problemCount === 0) {
                    vscode.window.showInformationMessage('No missing media files found.');
                } else {
                    vscode.window.showWarningMessage(
                        `Found ${problemCount} missing media references. Check Problems panel for details.`
                    );
                }
            } catch (error) {
                showErrorWithDetails('Error validating media', error);
            }
        });
        
        // Add file change listener for auto-validation
        const fileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(configService.getWorkspacePath(), '{content/**/*.mdx,content/**/*.json}')
        );
        
        fileWatcher.onDidChange(async (uri) => {
            await mediaValidationService.validateSingleFile(uri.fsPath);
        });

        fileWatcher.onDidCreate(async (uri) => {
            await mediaValidationService.validateSingleFile(uri.fsPath);
        });
        
        context.subscriptions.push(fileWatcher);
        
        // Register all commands
        Logger.info('Pushing commands to subscriptions...');
        context.subscriptions.push(showLogsCommand);
        context.subscriptions.push(initializeWorkspaceCommand);
        context.subscriptions.push(authenticateCommand);
        context.subscriptions.push(pullContentCommand);
        context.subscriptions.push(newContentCommand);
        context.subscriptions.push(pushContentCommand);
        context.subscriptions.push(showChangesCommand); 
        context.subscriptions.push(debugIndexCommand);
        context.subscriptions.push(markRenamedCommand);
        context.subscriptions.push(validateMediaCommand);

        // Only show the ready notification if we have a workspace
        if (configService.hasWorkspace()) {
            vscode.window.showInformationMessage('OnlineSales CMS extension is now ready.');
        }
        
        Logger.info('OnlineSales CMS extension successfully activated!');
    } catch (error) {
        showActivationError(error);
    }
}

export function deactivate() {
    Logger.info('OnlineSales CMS extension deactivated');
}