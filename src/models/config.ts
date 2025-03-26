export interface OnlineSalesConfig {
    domain: string;
    previewUrls?: Record<string, PreviewUrlConfig>;
}

export interface TokenConfig {
    accessToken: string;
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
