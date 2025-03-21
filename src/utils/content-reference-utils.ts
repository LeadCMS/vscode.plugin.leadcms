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
}
