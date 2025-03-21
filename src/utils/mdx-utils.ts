import * as path from 'path';

/**
 * Replaces media URLs in MDX content with local references
 * @param content The MDX content
 * @param mediaMap A map of remote URLs to local file paths
 */
export function replaceMediaReferences(content: string, mediaMap: Map<string, string>): string {
    let modifiedContent = content;
    
    // Replace each URL with its local counterpart
    mediaMap.forEach((localPath, remoteUrl) => {
        // Generate a relative path that preserves folder structure
        // Split the path to get components
        const pathParts = localPath.split(/[\/\\]/); // Split by both slash types
        
        // Find the 'media' directory in the path
        const mediaIndex = pathParts.findIndex(part => part === 'media');
        if (mediaIndex >= 0) {
            // Get all components after 'media'
            const relativeParts = pathParts.slice(mediaIndex);
            // Create the relative path using ../../ instead of ./
            const localRef = `../../${relativeParts.join('/')}`;
            
            // Replace all occurrences of the remote URL with the local reference
            modifiedContent = modifiedContent.replace(new RegExp(escapeRegExp(remoteUrl), 'g'), localRef);
        } else {
            // Fallback to simple filename if 'media' directory not found in path
            const filename = path.basename(localPath);
            const localRef = `../../media/${filename}`;
            
            modifiedContent = modifiedContent.replace(new RegExp(escapeRegExp(remoteUrl), 'g'), localRef);
        }
    });
    
    return modifiedContent;
}

/**
 * Escape special characters in a string for use in a regular expression
 */
function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}
