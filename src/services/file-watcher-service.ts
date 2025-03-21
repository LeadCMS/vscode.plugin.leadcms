import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import { IndexService } from './index-service';
import { Logger } from '../utils/logger';

/**
 * Service that watches for file system changes and updates the index accordingly
 */
export class FileWatcherService {
    private fileWatcher: vscode.FileSystemWatcher | undefined;
    private recentlyDeletedFiles: Map<string, { path: string, timestamp: number }> = new Map();
    private static RENAME_DETECTION_WINDOW = 2000; // 2 seconds to correlate deletion and creation
    
    constructor(private indexService: IndexService, private workspacePath: string) {
        this.initialize();
    }
    
    /**
     * Initialize file system watchers
     */
    private initialize(): void {
        try {
            // Create a file system watcher for the entire workspace
            // We're interested in tracking content and media files
            const contentGlob = new vscode.RelativePattern(this.workspacePath, '**/content/**');
            const mediaGlob = new vscode.RelativePattern(this.workspacePath, '**/media/**');
            
            // Watch content files
            this.setupWatcher(contentGlob);
            
            // Watch media files
            this.setupWatcher(mediaGlob);
            
            Logger.info('File watcher service initialized');
        } catch (error) {
            Logger.error('Failed to initialize file watcher service:', error);
        }
    }
    
    /**
     * Set up a watcher for a specific glob pattern
     */
    private setupWatcher(globPattern: vscode.GlobPattern): void {
        const watcher = vscode.workspace.createFileSystemWatcher(globPattern);
        
        // When a file is created, check if it might be a renamed file
        watcher.onDidCreate(async (uri) => {
            try {
                const newPath = uri.fsPath;
                const now = Date.now();
                
                // Check recently deleted files to see if this might be a rename
                for (const [oldUri, { path: oldPath, timestamp }] of this.recentlyDeletedFiles.entries()) {
                    // If the creation happened within our time window of a deletion
                    if (now - timestamp < FileWatcherService.RENAME_DETECTION_WINDOW) {
                        // Check if file contents are the same (this helps confirm it's actually a rename)
                        if (await this.compareFiles(oldPath, newPath)) {
                            Logger.info(`Detected file rename: ${oldPath} -> ${newPath}`);
                            
                            // Update the index to reflect the rename
                            await this.indexService.updateAfterRename(oldPath, newPath);
                            
                            // Remove from the deleted files map
                            this.recentlyDeletedFiles.delete(oldUri);
                            return;
                        }
                    }
                }
                
                // Clean up old entries to prevent memory leaks
                this.cleanupDeletedFilesCache();
                
                Logger.info(`File created: ${newPath}`);
            } catch (error) {
                Logger.error(`Error handling file creation: ${uri.fsPath}`, error);
            }
        });
        
        // When a file is deleted, add it to our recently deleted files map
        watcher.onDidDelete(uri => {
            try {
                const deletedPath = uri.fsPath;
                this.recentlyDeletedFiles.set(uri.toString(), { 
                    path: deletedPath, 
                    timestamp: Date.now() 
                });
                
                Logger.info(`File deleted: ${deletedPath}`);
            } catch (error) {
                Logger.error(`Error handling file deletion: ${uri.fsPath}`, error);
            }
        });
        
        // Keep track of the watcher for disposal
        if (!this.fileWatcher) {
            this.fileWatcher = watcher;
        }
    }
    
    /**
     * Compare two files to see if they have the same content
     */
    private async compareFiles(file1Path: string, file2Path: string): Promise<boolean> {
        try {
            // Check if both files exist
            const [file1Exists, file2Exists] = await Promise.all([
                fs.pathExists(file1Path),
                fs.pathExists(file2Path)
            ]);
            
            // If the first file doesn't exist anymore, it was truly deleted
            // If the second file doesn't exist, it's not a valid rename target
            if (!file1Exists || !file2Exists) {
                return false;
            }
            
            // Use the IndexService's hash calculation to compare files
            const hash1 = await this.indexService.calculateFileHash(file1Path);
            const hash2 = await this.indexService.calculateFileHash(file2Path);
            
            return hash1 === hash2;
        } catch (error) {
            Logger.error(`Error comparing files ${file1Path} and ${file2Path}:`, error);
            return false;
        }
    }
    
    /**
     * Clean up entries in the deleted files cache that are older than our detection window
     */
    private cleanupDeletedFilesCache(): void {
        const now = Date.now();
        for (const [uri, { timestamp }] of this.recentlyDeletedFiles.entries()) {
            if (now - timestamp > FileWatcherService.RENAME_DETECTION_WINDOW * 2) {
                this.recentlyDeletedFiles.delete(uri);
            }
        }
    }
    
    /**
     * Dispose the file watchers when no longer needed
     */
    public dispose(): void {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
            this.fileWatcher = undefined;
        }
        this.recentlyDeletedFiles.clear();
    }
}
