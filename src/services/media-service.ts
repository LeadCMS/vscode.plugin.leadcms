import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import { ApiService } from './api-service';
import { ConfigService } from './config-service';

export class MediaService {
    private workspacePath: string | undefined;
    private apiService: ApiService;
    private configService: ConfigService;
    
    constructor(apiService: ApiService) {
        this.apiService = apiService;
        this.configService = apiService.getConfigService();
        this.initialize();
    }

    private initialize(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            this.workspacePath = workspaceFolders[0].uri.fsPath;
        }
        // If no workspace is open, workspacePath will remain undefined
    }

    private ensureWorkspaceExists(): void {
        this.configService.ensureWorkspaceExists();
        if (!this.workspacePath) {
            // Re-initialize to pick up any workspace that might have been opened
            this.initialize();
            if (!this.workspacePath) {
                throw new Error('No workspace folder found. Please open a folder first.');
            }
        }
    }

    public async uploadMediaFile(filePath: string): Promise<string> {
        this.ensureWorkspaceExists();
        
        try {
            // Read the file
            const fileContent = await fs.readFile(filePath);
            const fileName = path.basename(filePath);
            
            // Upload to API
            const url = await this.apiService.uploadMedia(fileContent, fileName);
            
            // Copy to media directory
            const mediaDir = path.join(this.workspacePath!, 'media');
            await fs.ensureDir(mediaDir);
            const destinationPath = path.join(mediaDir, fileName);
            
            // Only copy if it's not already in the media directory
            if (filePath !== destinationPath) {
                await fs.copy(filePath, destinationPath);
            }
            
            return url;
        } catch (error) {
            console.error('Failed to upload media file:', error);
            throw error;
        }
    }
    
    public async getAllMedia(): Promise<string[]> {
        this.ensureWorkspaceExists();
        
        const mediaDir = path.join(this.workspacePath!, 'media');
        
        try {
            await fs.ensureDir(mediaDir);
            const files = await fs.readdir(mediaDir);
            return files;
        } catch (error) {
            console.error('Failed to get media files:', error);
            throw error;
        }
    }
}
