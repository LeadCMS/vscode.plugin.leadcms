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
    const result = {...metadata};
    
    // Only process coverImageUrl for now
    if (result.coverImageUrl && typeof result.coverImageUrl === 'string') {
        for (const [remoteUrl, localPath] of mediaMap.entries()) {
            if (result.coverImageUrl.includes(remoteUrl)) {
                // Get just the filename
                const filename = path.basename(localPath);
                result.coverImageUrl = filename;
                break;
            }
        }
    }
    
    return result;
}

/**
 * Escape special characters in a string for use in a regular expression
 */
function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}
