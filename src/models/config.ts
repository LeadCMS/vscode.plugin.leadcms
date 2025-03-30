export interface OnlineSalesConfig {
    domain: string;
    previewUrls?: Record<string, PreviewUrlConfig>;
}

export interface TokenConfig {
    email?: string;          // User's email for re-authentication
    password?: string;       // User's password (optional, for auto re-auth)
    accessToken: string;     // The JWT token
    expiration?: string;     // ISO string of when the token expires
}

/**
 * Configuration for content type preview URLs
 */
export interface PreviewUrlConfig {
    /**
     * URL pattern with placeholders like {slug} that will be replaced with actual values
     * For example: "/blog/{slug}" or "/{type}/{slug}"
     */
    urlPattern: string;
}
