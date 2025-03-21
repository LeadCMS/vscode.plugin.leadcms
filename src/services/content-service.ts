import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import { ContentCreateDto, ContentDetailsDto, ContentUpdateDto } from '../models/content';
import { ApiService } from './api-service';
import { ConfigService } from './config-service';

export class ContentService {
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

    public async pullContent(): Promise<void> {
        this.ensureWorkspaceExists();
        
        try {
            const contents = await this.apiService.exportContent();
            
            if (!contents || contents.length === 0) {
                vscode.window.showInformationMessage('No content found to pull.');
                return;
            }
            
            let successCount = 0;
            let errorCount = 0;
            
            for (const content of contents) {
                try {
                    if (!this.isValidContent(content)) {
                        console.warn('Skipping invalid content:', content);
                        errorCount++;
                        continue;
                    }
                    
                    await this.saveContentToFiles(content);
                    successCount++;
                } catch (error) {
                    console.error(`Failed to save content ${content?.id || 'unknown'}:`, error);
                    errorCount++;
                }
            }
            
            var message = successCount > 0 
                ? `Successfully pulled ${successCount} content items.` 
                : 'No content was pulled successfully.';
                
            if (errorCount > 0) {
                message += ` ${errorCount} items had errors (see console for details).`;
            }
            
            vscode.window.showInformationMessage(message);
        } catch (error) {
            console.error('Failed to pull content:', error);
            throw error;
        }
    }

    private isValidContent(content: any): content is ContentDetailsDto {
        return content && 
               typeof content === 'object' &&
               typeof content.id === 'number' &&
               typeof content.title === 'string' &&
               typeof content.slug === 'string' &&
               typeof content.type === 'string'; // Ensure type is a string
    }

    private async saveContentToFiles(content: ContentDetailsDto): Promise<void> {
        this.ensureWorkspaceExists();

        try {
            // Ensure required properties exist
            if (!content.type) {
                throw new Error(`Content ${content.id} is missing required 'type' property`);
            }
            
            const contentFolder = path.join(this.workspacePath!, 'content', content.type);
            await fs.ensureDir(contentFolder);
            
            // Save body content to MDX file
            const mdxPath = path.join(contentFolder, `${content.slug}.mdx`);
            await fs.writeFile(mdxPath, content.body || '', 'utf8');
            
            // Save metadata to JSON file
            const metadataPath = path.join(contentFolder, `${content.slug}.json`);
            
            // Create a new object without the body property
            const { body, ...metadataWithoutBody } = content;
            
            await fs.writeFile(metadataPath, JSON.stringify(metadataWithoutBody, null, 2), 'utf8');
        } catch (error) {
            console.error(`Failed to save content ${content.id}:`, error);
            throw error;
        }
    }

    public async createNewContent(type: string, title: string, slug: string): Promise<void> {
        this.ensureWorkspaceExists();
        
        try {
            const contentFolder = path.join(this.workspacePath!, 'content', type);
            await fs.ensureDir(contentFolder);
            
            // Create empty MDX file
            const mdxPath = path.join(contentFolder, `${slug}.mdx`);
            const defaultBody = `# ${title}\n\nEnter your content here...`;
            await fs.writeFile(mdxPath, defaultBody, 'utf8');
            
            // Create metadata JSON file with minimal details
            const metadataPath = path.join(contentFolder, `${slug}.json`);
            const metadata: Partial<ContentDetailsDto> = {
                title,
                slug,
                type,
                description: '',
                author: '',
                language: 'en',
                tags: [],
                category: '',
                allowComments: true
            };
            
            await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
            
            vscode.window.showInformationMessage(`Created new ${type} content: ${title}`);
            
            // Open the new file in the editor
            const document = await vscode.workspace.openTextDocument(mdxPath);
            await vscode.window.showTextDocument(document);
        } catch (error) {
            console.error('Failed to create new content:', error);
            throw error;
        }
    }

    public async pushContent(): Promise<void> {
        this.ensureWorkspaceExists();
        
        try {
            const contentDir = path.join(this.workspacePath!, 'content');
            const contentTypes = await fs.readdir(contentDir);
            let updatedCount = 0;
            let createdCount = 0;
            
            for (const type of contentTypes) {
                const typeDir = path.join(contentDir, type);
                const stats = await fs.stat(typeDir);
                
                if (!stats.isDirectory()) {
                    continue;
                }
                
                const files = await fs.readdir(typeDir);
                const jsonFiles = files.filter(file => file.endsWith('.json'));
                
                for (const jsonFile of jsonFiles) {
                    const baseName = path.basename(jsonFile, '.json');
                    const mdxFile = path.join(typeDir, `${baseName}.mdx`);
                    const jsonFilePath = path.join(typeDir, jsonFile);
                    
                    if (!await fs.pathExists(mdxFile)) {
                        console.warn(`MDX file not found for ${jsonFilePath}`);
                        continue;
                    }
                    
                    const metadataContent = await fs.readFile(jsonFilePath, 'utf8');
                    const metadata = JSON.parse(metadataContent);
                    
                    const bodyContent = await fs.readFile(mdxFile, 'utf8');
                    
                    if (metadata.id) {
                        // Update existing content
                        const updateDto: ContentUpdateDto = {
                            title: metadata.title,
                            description: metadata.description,
                            body: bodyContent,
                            slug: metadata.slug,
                            author: metadata.author,
                            language: metadata.language,
                            tags: metadata.tags,
                            category: metadata.category,
                            coverImageUrl: metadata.coverImageUrl,
                            allowComments: metadata.allowComments,
                            publishedAt: metadata.publishedAt
                        };
                        
                        await this.apiService.updateContent(metadata.id, updateDto);
                        updatedCount++;
                    } else {
                        // Create new content
                        const createDto: ContentCreateDto = {
                            title: metadata.title,
                            description: metadata.description,
                            body: bodyContent,
                            slug: metadata.slug,
                            type: metadata.type || type,
                            author: metadata.author,
                            language: metadata.language,
                            tags: metadata.tags,
                            category: metadata.category,
                            coverImageUrl: metadata.coverImageUrl,
                            allowComments: metadata.allowComments,
                            publishedAt: metadata.publishedAt
                        };
                        
                        const newContent = await this.apiService.createContent(createDto);
                        
                        // Update the local metadata with the new ID
                        metadata.id = newContent.id;
                        metadata.createdAt = newContent.createdAt;
                        metadata.updatedAt = newContent.updatedAt;
                        
                        await fs.writeFile(jsonFilePath, JSON.stringify(metadata, null, 2), 'utf8');
                        createdCount++;
                    }
                }
            }
            
            vscode.window.showInformationMessage(`Successfully pushed content: ${createdCount} created, ${updatedCount} updated.`);
        } catch (error) {
            console.error('Failed to push content:', error);
            throw error;
        }
    }
}
