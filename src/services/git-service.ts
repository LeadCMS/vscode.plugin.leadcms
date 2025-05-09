import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import { ConfigService } from './config-service';

export class GitService {
    private workspacePath: string | undefined;
    private configService: ConfigService;
    private git: SimpleGit | undefined;
    
    constructor(configService: ConfigService) {
        this.configService = configService;
        this.initialize();
    }

    private initialize(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            this.workspacePath = workspaceFolders[0].uri.fsPath;
            this.git = simpleGit(this.workspacePath);
        }
    }

    /**
     * Check if git is installed and available
     */
    public async isGitInstalled(): Promise<boolean> {
        if (!this.git) {
            return false;
        }
        
        try {
            await this.git.version();
            return true;
        } catch (error) {
            console.error('Git not found:', error);
            return false;
        }
    }

    /**
     * Check if the current directory is already a git repository
     */
    public async isGitRepository(): Promise<boolean> {
        if (!this.git) {
            return false;
        }
        
        try {
            return await this.git.checkIsRepo();
        } catch (error) {
            return false;
        }
    }

    /**
     * Initialize a new git repository if one doesn't exist already
     */
    public async initializeRepository(): Promise<boolean> {
        if (!this.workspacePath) {
            throw new Error('No workspace folder found');
        }
        
        try {
            // Check if git is installed
            if (!await this.isGitInstalled()) {
                throw new Error('Git is not installed or not available on PATH');
            }
            
            // Check if it's already a git repository
            if (await this.isGitRepository()) {
                console.log('Directory is already a git repository');
                return true;
            }
            
            // Create .gitignore file
            await this.createGitIgnore();
            
            // Initialize git repository
            await this.git!.init();
            console.log('Git repository initialized');
            
            // Add all files and make initial commit
            await this.git!.add('.');
            await this.git!.commit('Initial commit with LeadCMS CMS setup');
            console.log('Initial commit created');
            
            return true;
        } catch (error) {
            console.error('Failed to initialize git repository:', error);
            throw error;
        }
    }

    /**
     * Create a default .gitignore file
     */
    private async createGitIgnore(): Promise<void> {
        if (!this.workspacePath) {
            throw new Error('No workspace folder found');
        }
        
        const gitIgnorePath = path.join(this.workspacePath, '.gitignore');
        const templatePath = path.join(__dirname, '..', '..', 'templates', 'default.gitignore');
        
        try {
            // Check if template exists
            if (await fs.pathExists(templatePath)) {
                const templateContent = await fs.readFile(templatePath, 'utf8');
                
                // Check if .gitignore already exists
                if (await fs.pathExists(gitIgnorePath)) {
                    // Append our entries to the existing file if they don't exist
                    const existingContent = await fs.readFile(gitIgnorePath, 'utf8');
                    if (!existingContent.includes('# LeadCMS CMS specific')) {
                        await fs.writeFile(
                            gitIgnorePath, 
                            existingContent + '\n\n' + templateContent,
                            'utf8'
                        );
                    }
                } else {
                    // Create a new .gitignore file from template
                    await fs.writeFile(gitIgnorePath, templateContent, 'utf8');
                }
            } else {
                // Fallback to hardcoded .gitignore content
                if (!await fs.pathExists(gitIgnorePath)) {
                    await fs.writeFile(gitIgnorePath, this.getDefaultGitIgnoreContent(), 'utf8');
                }
            }
            
            console.log('.gitignore file created/updated');
        } catch (error) {
            console.error('Failed to create .gitignore file:', error);
            throw error;
        }
    }

    /**
     * Fallback gitignore content if template is not available
     */
    private getDefaultGitIgnoreContent(): string {
        return `# LeadCMS CMS specific
.leadcms/token.json

# IDE - VSCode
.vscode/*
!.vscode/settings.json
!.vscode/tasks.json
!.vscode/launch.json
!.vscode/extensions.json

# OS files
.DS_Store
Thumbs.db

# Logs
*.log
`;
    }

    /**
     * Append LeadCMS-specific entries to an existing .gitignore content
     */
    private appendGitIgnoreEntries(existingContent: string): string {
        const entries = this.getGitIgnoreEntries();
        const existingLines = existingContent.split('\n');
        
        // Add each entry if it doesn't already exist
        for (const entry of entries) {
            if (!existingLines.some(line => line.trim() === entry.trim())) {
                existingContent += '\n' + entry;
            }
        }
        
        // Add a section header if we had to add entries
        if (existingContent !== existingLines.join('\n')) {
            existingContent += '\n\n# LeadCMS CMS specific\n';
        }
        
        return existingContent;
    }

    /**
     * Get the list of entries to include in .gitignore
     */
    private getGitIgnoreEntries(): string[] {
        return [
            '# LeadCMS specific',
            '.leadcms/token.json',   // Contains sensitive authentication tokens
            '*.log',
            
            // IDE specific files
            '.vscode/*',
            '!.vscode/settings.json',
            '!.vscode/tasks.json',
            '!.vscode/launch.json',
            '!.vscode/extensions.json',
            '.idea/',
            '*.sublime-workspace',
            
            // OS specific files
            '.DS_Store',
            'Thumbs.db',
            'ehthumbs.db',
            'Desktop.ini',
            '$RECYCLE.BIN/',
            '*.cab',
            '*.msi',
            '*.msm',
            '*.msp',
            
            // Node.js specific
            'node_modules/',
            'npm-debug.log*',
            'yarn-debug.log*',
            'yarn-error.log*',
        ];
    }

    /**
     * Get the default .gitignore content
     */
    private getDefaultGitIgnore(): string {
        const entries = this.getGitIgnoreEntries();
        return '# LeadCMS CMS gitignore\n' + entries.join('\n');
    }
}
