import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { GatsbyService } from './gatsby-service';

export class PreviewService {
    private panels: Map<string, vscode.WebviewPanel> = new Map();
    private activePanel: vscode.WebviewPanel | undefined;
    private activeEditorListener: vscode.Disposable | undefined;
    private isAutoPreviewEnabled: boolean = true;
    private disposedPanels: Set<vscode.WebviewPanel> = new Set(); // Track disposed panels
    
    constructor(private gatsbyService: GatsbyService) {
        // Start listening for editor changes if auto-preview is enabled
        this.setupEditorChangeListener();
    }
    
    /**
     * Set up a listener for active editor changes
     */
    private setupEditorChangeListener(): void {
        // Dispose of any existing listener
        if (this.activeEditorListener) {
            this.activeEditorListener.dispose();
        }
        
        // Set up the new listener
        this.activeEditorListener = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            // Only proceed if auto-preview is enabled and we have a valid editor
            if (!this.isAutoPreviewEnabled || !editor) {
                return;
            }
            
            // Check if the new active editor is an MDX file
            const isMdx = editor.document.fileName.toLowerCase().endsWith('.mdx');
            if (!isMdx) {
                return;
            }
            
            // Update preview for the newly activated MDX file
            await this.updatePreviewForActiveEditor(editor);
        });
    }
    
    /**
     * Update the preview for the currently active editor
     */
    private async updatePreviewForActiveEditor(editor: vscode.TextEditor): Promise<void> {
        try {
            const mdxFilePath = editor.document.uri.fsPath;
            
            // Check if Gatsby server is running
            if (!await this.gatsbyService.ensureGatsbyServerRunning()) {
                // Server isn't running and couldn't be started
                return;
            }
            
            // Generate the preview URL
            const previewUrl = await this.gatsbyService.generatePreviewUrl(mdxFilePath);
            if (!previewUrl) {
                // Don't show error here as generatePreviewUrl already does
                return;
            }
            
            // Now update or create the panel
            await this.showPreviewPanel(mdxFilePath, previewUrl);
            
            Logger.info(`Auto-updated preview for ${path.basename(mdxFilePath)}`);
        } catch (error) {
            Logger.error('Error updating preview for active editor:', error);
            // Don't show error to user for automatic updates
        }
    }
    
    /**
     * Preview an MDX file in a side panel
     * @param mdxFilePath Path to the MDX file to preview
     */
    public async previewMDX(mdxFilePath?: string): Promise<void> {
        try {
            // If no file provided, use the active editor
            if (!mdxFilePath) {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showErrorMessage('No active editor found. Please open an MDX file to preview.');
                    return;
                }
                
                mdxFilePath = editor.document.uri.fsPath;
                
                // Check if it's an MDX file
                if (!mdxFilePath.toLowerCase().endsWith('.mdx')) {
                    vscode.window.showErrorMessage('The active file is not an MDX file. Please open an MDX file to preview.');
                    return;
                }
            }
            
            // Show progress indicator while starting Gatsby server
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Preparing MDX preview...",
                cancellable: false
            }, async (progress) => {
                // Check for running Gatsby server (including any started via F5)
                progress.report({ message: "Checking Gatsby configuration..." });
                const isServerRunning = await this.gatsbyService.ensureGatsbyServerRunning();
                
                if (!isServerRunning) {
                    // Handle failure - don't show another error message since ensureGatsbyServerRunning already shows one
                    Logger.warn('Failed to start Gatsby development server');
                    return;
                }
                
                progress.report({ message: "Generating preview URL..." });
                
                // Generate preview URL
                const previewUrl = await this.gatsbyService.generatePreviewUrl(mdxFilePath!);
                if (!previewUrl) {
                    vscode.window.showErrorMessage(
                        'Failed to generate preview URL. Please check your LeadCMS configuration.'
                    );
                    return;
                }
                
                // Offer the option to open in browser
                progress.report({ message: "Opening preview..." });
                const choice = await vscode.window.showQuickPick(
                    ['Open in VS Code panel', 'Open in browser', 'Auto-update preview as I switch files'],
                    { placeHolder: 'How do you want to view the preview?' }
                );
                
                if (choice === 'Open in browser') {
                    await this.gatsbyService.openInBrowser(previewUrl);
                } else if (choice === 'Auto-update preview as I switch files') {
                    // Enable auto-preview mode and create/update panel
                    this.isAutoPreviewEnabled = true;
                    await this.showPreviewPanel(mdxFilePath!, previewUrl);
                    vscode.window.showInformationMessage('Auto-preview enabled. Preview will update as you switch between MDX files.');
                } else {
                    // Create or show existing webview panel without auto-preview
                    await this.showPreviewPanel(mdxFilePath!, previewUrl);
                }
                
                progress.report({ message: "Preview ready" });
            });
        } catch (error) {
            Logger.error('Error previewing MDX:', error);
            
            // Show a more helpful error message with troubleshooting options
            vscode.window.showErrorMessage(
                `Failed to preview MDX file: ${error}`,
                "Check Logs",
                "Configure Gatsby Path"
            ).then(selection => {
                if (selection === "Check Logs") {
                    Logger.show();
                } else if (selection === "Configure Gatsby Path") {
                    this.gatsbyService.reconfigureGatsbyPath();
                }
            });
        }
    }
    
    /**
     * Show preview panel for an MDX file
     * @param mdxFilePath Path to the MDX file
     * @param previewUrl URL to preview in the panel
     */
    private async showPreviewPanel(mdxFilePath: string, previewUrl: string): Promise<void> {
        // Extract the relative URL path from the full URL
        const urlObj = new URL(previewUrl);
        const relativePath = urlObj.pathname; // This gets just the path part, e.g., "/blog/my-post"
        
        // Check if panel already exists
        let panel = this.panels.get(mdxFilePath);
        
        // Create new panel if needed
        if (!panel) {
            // Create a new panel or reuse the active one
            if (this.activePanel && !this.disposedPanels.has(this.activePanel) && this.isAutoPreviewEnabled) {
                // Update the existing active panel with new content and title
                panel = this.activePanel;
                panel.title = `Preview: ${relativePath}`;
            } else {
                // Create a new panel
                panel = vscode.window.createWebviewPanel(
                    'mdxPreview',
                    `Preview: ${relativePath}`,
                    vscode.ViewColumn.Beside,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true,
                    }
                );
                
                // Handle panel disposal
                panel.onDidDispose(() => {
                    this.panels.delete(mdxFilePath);
                    this.disposedPanels.add(panel!); // Mark panel as disposed
                    
                    if (this.activePanel === panel) {
                        this.activePanel = undefined;
                        // Auto-disable auto-preview when panel is closed
                        this.isAutoPreviewEnabled = false;
                    }
                });
            }
            
            // Add to map of panels and set as active
            this.panels.set(mdxFilePath, panel);
            this.activePanel = panel;
        } else {
            // Reveal existing panel and update its title
            panel.reveal(vscode.ViewColumn.Beside);
            panel.title = `Preview: ${relativePath}`;
            this.activePanel = panel;
        }
        
        // Set the webview content
        panel.webview.html = this.getWebviewContent(previewUrl);
        
        // Log preview URL
        Logger.info(`Previewing ${mdxFilePath} at ${previewUrl} (${relativePath})`);
    }
    
    /**
     * Dispose all resources used by this service
     */
    public dispose(): void {
        // Dispose the editor change listener
        if (this.activeEditorListener) {
            this.activeEditorListener.dispose();
            this.activeEditorListener = undefined;
        }
        
        // Dispose all panels
        for (const panel of this.panels.values()) {
            if (!this.disposedPanels.has(panel)) { // Only dispose if not already disposed
                panel.dispose();
            }
        }
        this.panels.clear();
        this.disposedPanels.clear();
        this.activePanel = undefined;
    }
    
    /**
     * Generate HTML content for the preview webview
     * @param url URL to preview
     */
    private getWebviewContent(url: string): string {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta name="color-scheme" content="light">
                <title>MDX Preview</title>
                <style>
                    body, html {
                        margin: 0;
                        padding: 0;
                        height: 100%;
                        overflow: hidden;
                        background-color: #FFFFFF;
                        color: #000000;
                    }
                    iframe {
                        width: 100%;
                        height: 100%;
                        border: none;
                        background-color: #FFFFFF;
                    }
                    .loader {
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: white;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        flex-direction: column;
                        color: #000000;
                    }
                    .spinner {
                        width: 50px;
                        height: 50px;
                        border: 4px solid rgba(0, 0, 0, 0.1);
                        border-left-color: #09f;
                        border-radius: 50%;
                        animation: spin 1s linear infinite;
                    }
                    @keyframes spin {
                        to { transform: rotate(360deg); }
                    }
                </style>
            </head>
            <body>
                <div class="loader" id="loader">
                    <div class="spinner"></div>
                    <p>Loading preview...</p>
                </div>
                <iframe 
                    src="${url}" 
                    id="preview-frame" 
                    onload="document.getElementById('loader').style.display = 'none';"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                    style="color-scheme: light;"
                ></iframe>
                <script>
                    // Ensure iframe uses light theme
                    const iframe = document.getElementById('preview-frame');
                    iframe.onload = function() {
                        document.getElementById('loader').style.display = 'none';
                        
                        try {
                            // Try to inject styles into the iframe to ensure light theme
                            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                            
                            // Only if we can access the document (same origin)
                            if (iframeDoc) {
                                // Create a style element
                                const style = iframeDoc.createElement('style');
                                style.textContent = \`
                                    :root {
                                        color-scheme: light !important;
                                    }
                                    html, body {
                                        background-color: #FFFFFF !important;
                                        color: #000000 !important;
                                    }
                                \`;
                                
                                // Append to the head
                                iframeDoc.head.appendChild(style);
                            }
                        } catch (e) {
                            // Ignore errors - might be cross-origin
                            console.log('Could not inject styles into iframe:', e);
                        }
                    };
                </script>
            </body>
            </html>
        `;
    }
}
