import * as fs from 'fs-extra';
import * as path from 'path';
import { Logger } from './logger';

/**
 * Utility functions to manage content references and linked files
 */
export class ContentReferenceUtils {
    /**
     * Updates references in MDX files - handles both content type and slug changes
     * 
     * @param mdxPath Path to the MDX file
     * @param oldPattern Old pattern to replace (could be contentType or slug)
     * @param newPattern New pattern to use
     * @param isSlugRename Whether this is a slug rename (vs. content type rename)
     */
    public static async updateReferencesInMdx(
        mdxPath: string, 
        oldPattern: string, 
        newPattern: string,
        isSlugRename: boolean = false
    ): Promise<boolean> {
        try {
            // Check if MDX file exists
            if (!await fs.pathExists(mdxPath)) {
                return false;
            }
            
            // Read MDX content
            const content = await fs.readFile(mdxPath, 'utf8');
            
            // Create regex patterns to match different reference formats
            // We need to escape special characters for regex
            const escapeRegex = (str: string) => {
                return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            };
            
            const escapedOld = escapeRegex(oldPattern);
            const escapedNew = escapeRegex(newPattern);
            
            // Set up patterns array based on whether it's a slug or content type rename
            let patterns: RegExp[] = [];
            let replacementCount = 0;
            let newContent = content;
            
            if (isSlugRename) {
                // For slug renames, we match these patterns:
                patterns = [
                    // Direct media reference: ../../media/slug/
                    new RegExp(`(\\.\\.\\/.\\.\\/media\\/${escapedOld}\\/)`, 'g'),
                    
                    // Nested reference: ../../media/contentType/slug/
                    new RegExp(`(\\.\\.\\/.\\.\\/media\\/[^/]+\\/${escapedOld}\\/)`, 'g'),
                    
                    // Direct slug references: oldSlug or /oldSlug/ or "oldSlug" or 'oldSlug'
                    new RegExp(`([\\s"\'/])${escapedOld}([\\s"\\'/])`, 'g'),
                    
                    // Template strings like blog/{slug}
                    new RegExp(`([\\w-]+\\/)\\{${escapedOld}\\}`, 'g')
                ];
                
                // Handle each pattern
                for (const pattern of patterns) {
                    const updatedContent = newContent.replace(pattern, (match, prefix, suffix) => {
                        replacementCount++;
                        
                        // Handle different pattern types
                        if (match.includes('../../media/')) {
                            // This is a media path, replace just the slug portion
                            return match.replace(`/${oldPattern}/`, `/${newPattern}/`);
                        } else if (match.includes('/{')) {
                            // This is a template string like blog/{slug}
                            return `${prefix}{${newPattern}}`;
                        } else {
                            // This is a direct slug reference with prefix and suffix
                            return `${prefix}${newPattern}${suffix || ''}`;
                        }
                    });
                    
                    if (updatedContent !== newContent) {
                        newContent = updatedContent;
                    }
                }
            } else {
                // For content type renames, we use the original patterns
                patterns = [
                    // Markdown image reference: ![alt](../../media/blog/image.jpg)
                    new RegExp(`!\\[.*?\\]\\((\\.\\.\\/.\\.\\/media\\/${escapedOld}\\/[^)]*?)\\)`, 'g'),
                    
                    // HTML image tag: <img src="../../media/blog/image.jpg" />
                    new RegExp(`<img[^>]*src=["'](\\.\\.\\/.\\.\\/media\\/${escapedOld}\\/[^"']*?)["'][^>]*>`, 'g'),
                    
                    // Plain path reference: ../../media/blog/image.jpg
                    new RegExp(`(\\.\\.\\/.\\.\\/media\\/${escapedOld}\\/[\\w.-]+)`, 'g'),
                    
                    // Template strings like blog/{slug}
                    new RegExp(`${escapedOld}\\/{([^}]+)\\}`, 'g')
                ];
                
                // Apply replacements
                for (const pattern of patterns) {
                    newContent = newContent.replace(pattern, (match, p1) => {
                        replacementCount++;
                        
                        // Handle template strings
                        if (match.includes('/{')) {
                            return match.replace(`${oldPattern}/{`, `${newPattern}/{`);
                        }
                        
                        // Handle media paths
                        if (p1) {
                            return match.replace(p1, p1.replace(
                                `../../media/${oldPattern}/`, 
                                `../../media/${newPattern}/`
                            ));
                        }
                        
                        return match;
                    });
                }
            }
            
            // Save the file if changes were made
            if (replacementCount > 0 && newContent !== content) {
                Logger.info(`Updating ${replacementCount} references in ${mdxPath}`);
                await fs.writeFile(mdxPath, newContent, 'utf8');
                return true;
            }
            
            return false;
        } catch (error) {
            Logger.error(`Error updating references in ${mdxPath}:`, error);
            return false;
        }
    }
    
    /**
     * Updates references in all MDX files for a specific content type
     * 
     * @param workspacePath Root workspace path
     * @param oldContentType Old content type folder name
     * @param newContentType New content type folder name
     */
    public static async updateAllContentTypeReferences(
        workspacePath: string, 
        oldContentType: string, 
        newContentType: string
    ): Promise<void> {
        try {
            const contentPath = path.join(workspacePath, 'content', newContentType);
            
            // Check if the content directory exists
            if (!await fs.pathExists(contentPath)) {
                return;
            }
            
            // Get all MDX files in the directory
            const files = await fs.readdir(contentPath);
            const mdxFiles = files.filter(f => f.endsWith('.mdx'));
            
            Logger.info(`Updating media references in ${mdxFiles.length} files for content type: ${oldContentType} -> ${newContentType}`);
            
            // Process each MDX file
            for (const mdxFile of mdxFiles) {
                const mdxPath = path.join(contentPath, mdxFile);
                await this.updateReferencesInMdx(mdxPath, oldContentType, newContentType, false);
            }
        } catch (error) {
            Logger.error(`Error updating content type references:`, error);
        }
    }
    
    /**
     * Alias for backward compatibility
     */
    public static updateMediaReferencesInMdx = ContentReferenceUtils.updateReferencesInMdx;

    /**
     * Updates slug references in JSON metadata files
     * 
     * @param jsonPath Path to the JSON metadata file
     * @param oldSlug Old slug value to replace
     * @param newSlug New slug value to use
     */
    public static async updateSlugReferencesInJson(
        jsonPath: string,
        oldSlug: string,
        newSlug: string
    ): Promise<boolean> {
        try {
            // Check if file exists
            if (!await fs.pathExists(jsonPath)) {
                return false;
            }
            
            // Read JSON content
            const content = await fs.readFile(jsonPath, 'utf8');
            
            // Try to parse as JSON to handle it properly
            try {
                const jsonData = JSON.parse(content);
                let modified = false;
                
                // Update direct slug property if it exists and matches EXACTLY
                if (jsonData.slug === oldSlug) {
                    jsonData.slug = newSlug;
                    modified = true;
                    Logger.info(`Updated slug property in ${jsonPath}`);
                }
                
                // Update any URL or path properties that contain the slug
                const updateUrlsInObject = (obj: any): boolean => {
                    let objModified = false;
                    
                    for (const key of Object.keys(obj)) {
                        const value = obj[key];
                        
                        // If value is a string and looks like a URL or path with the slug
                        if (typeof value === 'string') {
                            // For URL paths, we need to be careful to replace only complete path segments
                            // Parse the URL structure carefully
                            if (key === 'coverImageUrl' || key.includes('Url') || key.includes('Path')) {
                                // Regular expression that matches exact path segments
                                const urlPattern = new RegExp(`(^|/)${oldSlug}(/|$)`, 'g');
                                
                                if (urlPattern.test(value)) {
                                    // Parse the URL path to avoid partial replacements
                                    const parts = value.split('/');
                                    const newParts = parts.map(part => 
                                        part === oldSlug ? newSlug : part
                                    );
                                    
                                    obj[key] = newParts.join('/');
                                    objModified = true;
                                    Logger.info(`Updated ${key} path segment in ${jsonPath}`);
                                }
                            } 
                            // For exact matches (like tags, categories, etc.)
                            else if (value === oldSlug) {
                                obj[key] = newSlug;
                                objModified = true;
                                Logger.info(`Updated exact match ${key} in ${jsonPath}`);
                            }
                        } 
                        // If value is an object, recursively process it
                        else if (value && typeof value === 'object' && !Array.isArray(value)) {
                            const nestedModified = updateUrlsInObject(value);
                            objModified = objModified || nestedModified;
                        }
                        // If value is an array, check each item
                        else if (Array.isArray(value)) {
                            for (let i = 0; i < value.length; i++) {
                                const item = value[i];
                                if (typeof item === 'string') {
                                    // Check for exact slug match
                                    if (item === oldSlug) {
                                        value[i] = newSlug;
                                        objModified = true;
                                        Logger.info(`Updated slug in array at ${key}[${i}]`);
                                    } 
                                    // Check for URL path segments
                                    else if (item.includes('/')) {
                                        const urlPattern = new RegExp(`(^|/)${oldSlug}(/|$)`, 'g');
                                        
                                        if (urlPattern.test(item)) {
                                            // Parse the URL path to avoid partial replacements
                                            const parts = item.split('/');
                                            const newParts = parts.map(part => 
                                                part === oldSlug ? newSlug : part
                                            );
                                            
                                            value[i] = newParts.join('/');
                                            objModified = true;
                                            Logger.info(`Updated URL path segment in array at ${key}[${i}]`);
                                        }
                                    }
                                } else if (item && typeof item === 'object') {
                                    // Recursively process objects in arrays
                                    const nestedModified = updateUrlsInObject(item);
                                    objModified = objModified || nestedModified;
                                }
                            }
                        }
                    }
                    
                    return objModified;
                };
                
                // Process entire JSON object recursively
                const deepModified = updateUrlsInObject(jsonData);
                modified = modified || deepModified;
                
                // If changes were made, save the file
                if (modified) {
                    Logger.info(`Updating JSON slug references in ${jsonPath}`);
                    await fs.writeFile(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');
                    return true;
                }
                
                return false;
            } catch (jsonError) {
                // If JSON parsing fails, use regex as a fallback with more precise patterns
                Logger.warn(`JSON parsing failed for ${jsonPath}, using regex fallback`);
                let newContent = content;
                let modified = false;
                
                // Simple pattern for: "slug": "old-slug"
                const slugPattern = new RegExp(`"slug"\\s*:\\s*"${oldSlug}"`, 'g');
                if (slugPattern.test(newContent)) {
                    newContent = newContent.replace(slugPattern, `"slug": "${newSlug}"`);
                    modified = true;
                }
                
                // Pattern for: "/api/media/old-slug/image.jpg"
                // More precise pattern to match whole path segments only
                const imageUrlPattern = new RegExp(`"/api/media/(${oldSlug})/`, 'g');
                if (imageUrlPattern.test(newContent)) {
                    newContent = newContent.replace(imageUrlPattern, `"/api/media/${newSlug}/`);
                    modified = true;
                }
                
                if (modified) {
                    Logger.info(`Updating JSON with regex fallback in ${jsonPath}`);
                    await fs.writeFile(jsonPath, newContent, 'utf8');
                    return true;
                }
                
                return false;
            }
        } catch (error) {
            Logger.error(`Error updating slug references in JSON ${jsonPath}:`, error);
            return false;
        }
    }

    /**
     * Updates slug references in MDX files
     * 
     * @param mdxPath Path to the MDX file
     * @param oldSlug Old slug value
     * @param newSlug New slug value
     */
    public static async updateSlugReferencesInMdx(
        mdxPath: string,
        oldSlug: string,
        newSlug: string
    ): Promise<boolean> {
        try {
            if (!await fs.pathExists(mdxPath)) {
                return false;
            }
            
            const content = await fs.readFile(mdxPath, 'utf8');
            const escapedOld = this.escapeRegExp(oldSlug);
            let replacementCount = 0;
            
            // Patterns for direct slug references
            const patterns = [
                // Direct slug references: oldSlug or /oldSlug/ or "oldSlug" or 'oldSlug'
                new RegExp(`([\\s"\'/])${escapedOld}([\\s"\\'/])`, 'g'),
                
                // Template strings like blog/{slug}
                new RegExp(`([\\w-]+\\/)\\{${escapedOld}\\}`, 'g')
            ];
            
            let newContent = content;
            
            // Handle each pattern
            for (const pattern of patterns) {
                newContent = newContent.replace(pattern, (match, prefix, suffix) => {
                    replacementCount++;
                    
                    if (match.includes('/{')) {
                        // This is a template string like blog/{slug}
                        return `${prefix}{${newSlug}}`;
                    } else {
                        // This is a direct slug reference with prefix and suffix
                        return `${prefix}${newSlug}${suffix || ''}`;
                    }
                });
            }
            
            // Save the file if changes were made
            if (replacementCount > 0 && newContent !== content) {
                Logger.info(`Updating ${replacementCount} slug references in ${mdxPath}`);
                await fs.writeFile(mdxPath, newContent, 'utf8');
                return true;
            }
            
            return false;
        } catch (error) {
            Logger.error(`Error updating slug references in ${mdxPath}:`, error);
            return false;
        }
    }

    /**
     * Updates content type references within a folder
     * 
     * @param workspacePath Root workspace path
     * @param folderPath Path to the content folder
     * @param oldContentType Old content type
     * @param newContentType New content type
     */
    public static async updateContentTypeReferencesInFolder(
        workspacePath: string,
        folderPath: string,
        oldContentType: string,
        newContentType: string
    ): Promise<void> {
        try {
            // Check if the content directory exists
            if (!await fs.pathExists(folderPath)) {
                return;
            }
            
            // Update MDX file
            const mdxPath = path.join(folderPath, 'index.mdx');
            if (await fs.pathExists(mdxPath)) {
                const content = await fs.readFile(mdxPath, 'utf8');
                const escapedOld = this.escapeRegExp(oldContentType);
                
                // Pattern for content type references
                const pattern = new RegExp(`/${escapedOld}/`, 'g');
                const newContent = content.replace(pattern, `/${newContentType}/`);
                
                if (newContent !== content) {
                    Logger.info(`Updating content type references in ${mdxPath}`);
                    await fs.writeFile(mdxPath, newContent, 'utf8');
                }
            }
            
            // Update JSON file if needed
            const jsonPath = path.join(folderPath, 'index.json');
            if (await fs.pathExists(jsonPath)) {
                try {
                    const jsonContent = await fs.readFile(jsonPath, 'utf8');
                    let metadata = JSON.parse(jsonContent);
                    let modified = false;
                    
                    // Update type if it exists
                    if (metadata.type && metadata.type === oldContentType) {
                        metadata.type = newContentType;
                        modified = true;
                    }
                    
                    // Update coverImageUrl if it contains the content type
                    if (metadata.coverImageUrl && metadata.coverImageUrl.includes(`/${oldContentType}/`)) {
                        metadata.coverImageUrl = metadata.coverImageUrl.replace(
                            `/${oldContentType}/`, 
                            `/${newContentType}/`
                        );
                        modified = true;
                    }
                    
                    if (modified) {
                        await fs.writeFile(jsonPath, JSON.stringify(metadata, null, 2), 'utf8');
                        Logger.info(`Updated content type in ${jsonPath}`);
                    }
                } catch (error) {
                    Logger.error(`Error updating JSON content type: ${error}`);
                }
            }
        } catch (error) {
            Logger.error(`Error updating content type references:`, error);
        }
    }
    
    // Helper to escape special characters in regex
    private static escapeRegExp(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Updates references to a media file in the same folder
     * 
     * @param workspacePath Root workspace path
     * @param oldFilePath Original file path
     * @param newFilePath New file path
     */
    public static async updateMediaFileReferencesInFolder(
        oldFilePath: string,
        newFilePath: string
    ): Promise<number> {
        try {
            const oldFileName = path.basename(oldFilePath);
            const newFileName = path.basename(newFilePath);
            
            if (oldFileName === newFileName) {
                Logger.info('Filenames are identical, no need to update references');
                return 0;
            }

            // Get the folder containing the media file
            const folderPath = path.dirname(oldFilePath);
            
            if (!await fs.pathExists(folderPath)) {
                Logger.info(`Folder ${folderPath} not found`);
                return 0;
            }

            // Find MDX and JSON files in the same folder
            const files = await fs.readdir(folderPath);
            const mdxFiles = files
                .filter(f => f.endsWith('.mdx'))
                .map(f => path.join(folderPath, f));
            
            const jsonFiles = files
                .filter(f => f.endsWith('.json'))
                .map(f => path.join(folderPath, f));
            
            Logger.info(`Found ${mdxFiles.length} MDX files and ${jsonFiles.length} JSON files in the same folder to check for media references`);

            let totalUpdatedFiles = 0;

            // Process each MDX file
            for (const mdxFile of mdxFiles) {
                if (await this.updateMediaReferencesInFile(mdxFile, oldFileName, newFileName)) {
                    totalUpdatedFiles++;
                }
            }
            
            // Process each JSON file
            for (const jsonFile of jsonFiles) {
                if (await this.updateMediaReferencesInJsonFile(jsonFile, oldFileName, newFileName)) {
                    totalUpdatedFiles++;
                }
            }

            Logger.info(`Media references updated in ${totalUpdatedFiles} files in the same folder`);
            return totalUpdatedFiles;
            
        } catch (error) {
            Logger.error(`Error updating media references:`, error);
            return 0;
        }
    }

    /**
     * Updates media references in a single MDX file
     * 
     * @param filePath Path to the MDX file
     * @param oldFileName Original filename (not full path)
     * @param newFileName New filename (not full path)
     */
    private static async updateMediaReferencesInFile(
        filePath: string,
        oldFileName: string,
        newFileName: string
    ): Promise<boolean> {
        try {
            // Read MDX content
            const content = await fs.readFile(filePath, 'utf8');

            // Check if the file contains references to the old filename
            if (!content.includes(oldFileName)) {
                return false;
            }

            // Create regex patterns to match different reference formats
            const escapedOldName = this.escapeRegExp(oldFileName);
            
            // Patterns for media references
            const patterns = [
                // Basic filename reference
                new RegExp(`(["'\`(/\\s])${escapedOldName}([)"'\`/\\s.:;,?!])`, 'g'),
                
                // Markdown image: ![alt](path/filename.ext)
                new RegExp(`!\\[.*?\\]\\([^)]*${escapedOldName}\\)`, 'g'),
                
                // HTML img tag: <img src="path/filename.ext" />
                new RegExp(`<img[^>]*src=["'][^"']*${escapedOldName}["'][^>]*>`, 'g')
            ];

            let newContent = content;
            let fileUpdated = false;

            // Apply each pattern replacement
            for (const pattern of patterns) {
                const updatedContent = newContent.replace(pattern, (match) => {
                    fileUpdated = true;
                    return match.replace(oldFileName, newFileName);
                });

                if (updatedContent !== newContent) {
                    newContent = updatedContent;
                }
            }

            // Save updated content if changes were made
            if (fileUpdated) {
                await fs.writeFile(filePath, newContent, 'utf8');
                Logger.info(`Updated media references in ${filePath}`);
                return true;
            }

            return false;
        } catch (error) {
            Logger.error(`Error updating media references in ${filePath}:`, error);
            return false;
        }
    }

    /**
     * Updates media references in a single JSON file
     * 
     * @param filePath Path to the JSON file
     * @param oldFileName Original filename (not full path)
     * @param newFileName New filename (not full path)
     */
    private static async updateMediaReferencesInJsonFile(
        filePath: string,
        oldFileName: string,
        newFileName: string
    ): Promise<boolean> {
        try {
            // Read JSON content
            const content = await fs.readFile(filePath, 'utf8');

            // Check if the file contains references to the old filename
            if (!content.includes(oldFileName)) {
                return false;
            }
            
            let modified = false;

            // Try to parse as JSON to handle it properly
            try {
                const jsonData = JSON.parse(content);
                
                // Helper function to recursively process objects
                const updateReferencesInObject = (obj: any): boolean => {
                    let objModified = false;
                    
                    if (!obj || typeof obj !== 'object') {
                        return false;
                    }
                    
                    // Handle arrays
                    if (Array.isArray(obj)) {
                        for (let i = 0; i < obj.length; i++) {
                            if (typeof obj[i] === 'string' && obj[i].includes(oldFileName)) {
                                obj[i] = obj[i].replace(oldFileName, newFileName);
                                objModified = true;
                            } else if (obj[i] && typeof obj[i] === 'object') {
                                const nestedModified = updateReferencesInObject(obj[i]);
                                objModified = objModified || nestedModified;
                            }
                        }
                        return objModified;
                    }
                    
                    // Handle regular objects
                    for (const key of Object.keys(obj)) {
                        const value = obj[key];
                        
                        if (typeof value === 'string' && value.includes(oldFileName)) {
                            obj[key] = value.replace(oldFileName, newFileName);
                            objModified = true;
                        } else if (value && typeof value === 'object') {
                            const nestedModified = updateReferencesInObject(value);
                            objModified = objModified || nestedModified;
                        }
                    }
                    
                    return objModified;
                };
                
                // Process the JSON data
                modified = updateReferencesInObject(jsonData);
                
                // Save the updated JSON if modified
                if (modified) {
                    await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2), 'utf8');
                    Logger.info(`Updated media references in ${filePath}`);
                    return true;
                }
            } catch (jsonError) {
                // If JSON parsing fails, use regex as a fallback
                Logger.warn(`JSON parsing failed for ${filePath}, using regex fallback`);
                
                const escapedOldName = this.escapeRegExp(oldFileName);
                const pattern = new RegExp(escapedOldName, 'g');
                
                if (pattern.test(content)) {
                    const newContent = content.replace(pattern, newFileName);
                    await fs.writeFile(filePath, newContent, 'utf8');
                    Logger.info(`Updated media references in ${filePath} using regex fallback`);
                    return true;
                }
            }
            
            return false;
        } catch (error) {
            Logger.error(`Error updating media references in JSON ${filePath}:`, error);
            return false;
        }
    }

    /**
     * Finds all MDX files in a directory recursively
     */
    private static async findAllMdxFiles(dirPath: string): Promise<string[]> {
        return await this.findAllFilesWithExtension(dirPath, '.mdx');
    }

    /**
     * Finds all files with a specific extension recursively
     */
    private static async findAllFilesWithExtension(dirPath: string, extension: string): Promise<string[]> {
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            
            const files: string[] = [];
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                
                if (entry.isDirectory()) {
                    // Skip system directories
                    if (['.git', 'node_modules', '.onlinesales'].includes(entry.name)) {
                        continue;
                    }
                    
                    // Recursively get files in subdirectories
                    const subFiles = await this.findAllFilesWithExtension(fullPath, extension);
                    files.push(...subFiles);
                } else if (entry.name.toLowerCase().endsWith(extension)) {
                    files.push(fullPath);
                }
            }
            
            return files;
        } catch (error) {
            Logger.error(`Error finding files with extension ${extension} in ${dirPath}:`, error);
            return [];
        }
    }
}
