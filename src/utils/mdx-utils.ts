import * as path from 'path';

/**
 * Replaces media URLs in MDX content with local references
 * @param content The MDX content
 * @param mediaMap A map of remote URLs to local file paths
 * @param contentType The content type (optional, for path generation)
 * @param slug The content slug (optional, for path generation)
 */
export function replaceMediaReferences(
    content: string, 
    mediaMap: Map<string, string>,
    contentType?: string,
    slug?: string
): string {
    if (!content) {
        return content;
    }

    let modifiedContent = content;
    
    // Replace each URL with its local counterpart
    mediaMap.forEach((localPath, remoteUrl) => {
        // Get just the filename
        const filename = path.basename(localPath);
        
        // Replace with the filename only, since media files are now in the same folder
        modifiedContent = modifiedContent.replace(new RegExp(escapeRegExp(remoteUrl), 'g'), filename);
    });
    
    return modifiedContent;
}

/**
 * Replaces media URLs in JSON metadata
 * @param metadata The JSON metadata object
 * @param mediaMap A map of remote URLs to local file paths
 * @param contentType The content type (optional, for path generation)
 * @param slug The content slug (optional, for path generation)
 */
export function replaceMediaReferencesInMetadata(
    metadata: any,
    mediaMap: Map<string, string>,
    contentType?: string,
    slug?: string
): any {
    if (!metadata || typeof metadata !== 'object' || mediaMap.size === 0) {
        return metadata;
    }
    
    // Create a copy to avoid mutating the original
    const result = Array.isArray(metadata) ? [...metadata] : {...metadata};
    
    // Helper function to recursively process objects
    const processObject = (obj: any): any => {
        if (!obj || typeof obj !== 'object') {
            return obj;
        }
        
        // Handle arrays
        if (Array.isArray(obj)) {
            return obj.map(item => processObject(item));
        }
        
        // Handle regular objects
        const newObj = {...obj};
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'string' && 
                (key === 'coverImageUrl' || key.includes('Url') || key.includes('Image'))) {
                
                // Try to replace the URL if it exists in the map
                for (const [remoteUrl, localPath] of mediaMap.entries()) {
                    if (value.includes(remoteUrl)) {
                        // Get just the filename
                        const filename = path.basename(localPath);
                        newObj[key] = value.replace(remoteUrl, filename);
                        break;
                    }
                }
            } 
            else if (value && typeof value === 'object') {
                // Recursively process nested objects
                newObj[key] = processObject(value);
            }
        }
        
        return newObj;
    };
    
    return processObject(result);
}

/**
 * Escape special characters in a string for use in a regular expression
 */
function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}
