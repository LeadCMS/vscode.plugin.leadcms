import * as vscode from 'vscode';
import { ConfigService } from './services/config-service';
import { ApiService } from './services/api-service';
import { ContentService } from './services/content-service';
import { MediaService } from './services/media-service';
import { OnlineSalesConfig, TokenConfig } from './models/config';

export function activate(context: vscode.ExtensionContext) {
    // Log activation with more details
    console.log('Activating OnlineSales CMS extension...');
    
    try {
        const configService = new ConfigService();
        const apiService = new ApiService(configService);
        const contentService = new ContentService(apiService);
        const mediaService = new MediaService(apiService);

        console.log('Services initialized, registering commands...');

        // Check workspace availability when the command is executed
        function checkWorkspace(): boolean {
            if (!configService.hasWorkspace()) {
                vscode.window.showErrorMessage('OnlineSales: This command requires an open workspace. Please open a folder first.');
                return false;
            }
            return true;
        }

        // Command: Initialize Workspace
        const initializeWorkspaceCommand = vscode.commands.registerCommand('onlinesales-vs-plugin.initializeWorkspace', async () => {
            try {
                console.log('Executing initialize workspace command...');
                
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
                    vscode.window.showErrorMessage('Domain is required to initialize workspace.');
                    return;
                }

                const config: OnlineSalesConfig = {
                    domain: domain.trim()
                };

                await configService.saveConfig(config);
                await configService.ensureDirectoriesExist();

                vscode.window.showInformationMessage('OnlineSales workspace initialized successfully.');
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to initialize workspace: ${error.message}`);
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
                    vscode.window.showErrorMessage('Access token is required for authentication.');
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
                    vscode.window.showErrorMessage('Failed to authenticate with OnlineSales API.');
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`Authentication failed: ${error.message}`);
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
                const errorDetails = error.stack || error.message || String(error);
                console.error('Pull content error details:', errorDetails);
                
                // Show a more user-friendly error message
                let errorMessage = `Failed to pull content: ${error.message}`;
                if (error.message?.includes('path')) {
                    errorMessage = 'Error processing content: The content structure returned by the API is not as expected. Check the API endpoint and format.';
                }
                
                vscode.window.showErrorMessage(errorMessage, 'View Details')
                    .then(selection => {
                        if (selection === 'View Details') {
                            // Create and show output channel with detailed error
                            const outputChannel = vscode.window.createOutputChannel('OnlineSales CMS');
                            outputChannel.appendLine('Error details:');
                            outputChannel.appendLine(errorDetails);
                            outputChannel.show();
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
                vscode.window.showErrorMessage(`Failed to create new content: ${error.message}`);
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
                vscode.window.showErrorMessage(`Failed to push content: ${error.message}`);
            }
        });

        // Register all commands
        console.log('Pushing commands to subscriptions...');
        context.subscriptions.push(initializeWorkspaceCommand);
        context.subscriptions.push(authenticateCommand);
        context.subscriptions.push(pullContentCommand);
        context.subscriptions.push(newContentCommand);
        context.subscriptions.push(pushContentCommand);

        // Only show the ready notification if we have a workspace
        if (configService.hasWorkspace()) {
            vscode.window.showInformationMessage('OnlineSales CMS extension is now ready.');
        }
        
        console.log('OnlineSales CMS extension successfully activated!');
    } catch (error) {
        console.error('Error during extension activation:', error);
        vscode.window.showErrorMessage('Failed to activate OnlineSales CMS extension. See console for details.');
    }
}

export function deactivate() {
    console.log('OnlineSales CMS extension deactivated');
}
