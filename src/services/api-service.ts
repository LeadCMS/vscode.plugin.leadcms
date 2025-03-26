import axios, { AxiosInstance } from 'axios';
import * as vscode from 'vscode';
import { ContentCreateDto, ContentDetailsDto, ContentUpdateDto } from '../models/content';
import { ConfigService } from './config-service';
import { Logger } from '../utils/logger';
import { AuthenticationError } from '../utils/errors';
// Update import to include the new helper
import { 
    showErrorWithDetails, 
    showErrorWithLogsOption,
    handleWorkspaceNotInitializedError
} from '../utils/ui-helpers';

// The error class for workspace initialization issues
export class WorkspaceNotInitializedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkspaceNotInitializedError';
    }
}

export class ApiService {
    private client: AxiosInstance | undefined;
    private configService: ConfigService;

    constructor(configService: ConfigService) {
        this.configService = configService;
    }

    // Method to allow ContentService to access ConfigService
    public getConfigService(): ConfigService {
        return this.configService;
    }

    /**
     * Initialize or reinitialize the API client with fresh configuration
     */
    public async initialize(): Promise<boolean> {
        try {
            // First check if workspace is initialized properly
            if (!this.configService.hasWorkspace()) {
                Logger.warn('No workspace available for API client initialization');
                return false;
            }
            
            // Check if config exists (this verifies workspace initialization)
            const config = await this.configService.getConfig();
            
            if (!config || !config.domain) {
                Logger.warn('No config or domain found in workspace. Workspace may not be fully initialized.');
                return false;
            }

            // Now check for token
            const tokenConfig = await this.configService.getToken();
            
            // If no token, that's okay - we don't return false here to distinguish
            // between "workspace not initialized" and "not authenticated"
            if (!tokenConfig || !tokenConfig.accessToken) {
                Logger.warn('No authentication token found. Will prompt for authentication.');
                // Return true because workspace is initialized, we just need auth
                return true; 
            }

            const baseURL = `${config.domain}/api`;
            Logger.info(`Initializing API client with base URL: ${baseURL}`);

            // Create a new client with fresh configuration
            this.client = axios.create({
                baseURL,
                headers: {
                    'Authorization': `Bearer ${tokenConfig.accessToken}`,
                    'Accept': 'text/json'
                }
            });
            
            // Set up interceptors
            this.setupInterceptors();
            
            return true;
        } catch (error) {
            Logger.error('Failed to initialize API service:', error);
            showErrorWithDetails('Failed to initialize API connection', error);
            return false;
        }
    }

    /**
     * Set up request and response interceptors for logging
     */
    private setupInterceptors(): void {
        if (!this.client) {
            return;
        }
        
        // Add request interceptor for logging
        this.client.interceptors.request.use(
            (config) => {
                const method = config.method?.toUpperCase() || 'UNKNOWN';
                const url = config.url || 'UNKNOWN';
                const fullUrl = config.baseURL ? `${config.baseURL}${url}` : url;
                
                Logger.apiRequest(method, fullUrl, config.data);
                return config;
            },
            (error) => {
                Logger.error('Request error interceptor', error);
                return Promise.reject(error);
            }
        );
        
        // Add response interceptor for logging
        this.client.interceptors.response.use(
            (response) => {
                const status = response.status;
                const url = response.config.url || 'UNKNOWN';
                const fullUrl = response.config.baseURL ? `${response.config.baseURL}${url}` : url;
                
                Logger.apiResponse(fullUrl, status, response.data);
                return response;
            },
            (error) => {
                if (axios.isAxiosError(error) && error.response) {
                    const status = error.response.status;
                    const url = error.config?.url || 'UNKNOWN';
                    const fullUrl = error.config?.baseURL ? `${error.config.baseURL}${url}` : url;
                    
                    Logger.error(`API error ${status} from ${fullUrl}`, {
                        status,
                        data: error.response.data,
                        message: error.message
                    });
                } else {
                    Logger.error('Non-Axios API error', error);
                }
                return Promise.reject(error);
            }
        );
    }

    /**
     * Ensure API client is initialized with fresh configuration
     * @throws WorkspaceNotInitializedError if client cannot be initialized
     * @throws AuthenticationError if workspace is initialized but not authenticated
     */
    private async ensureClientInitialized(): Promise<boolean> {
        // Always reinitialize the client to get fresh config
        const initialized = await this.initialize();
        
        // First check if workspace is properly initialized
        if (!initialized) {
            const config = await this.configService.getConfig();
            if (!config) {
                Logger.error('Workspace not properly initialized: missing config.json');
                throw new WorkspaceNotInitializedError('Workspace not initialized. Please initialize your workspace first.');
            }
            
            // If workspace is initialized but we don't have a client,
            // it's most likely an authentication issue
            const token = await this.configService.getToken();
            if (!token || !token.accessToken) {
                Logger.error('Authentication required: missing or invalid token');
                throw new AuthenticationError('Authentication required. Please authenticate with OnlineSales API.');
            }
            
            // If we get here, there's some other initialization problem
            throw new Error('Failed to initialize API client. Check the logs for details.');
        }
        
        // If client is still undefined despite successful initialization,
        // it's likely an authentication issue
        if (!this.client) {
            Logger.error('API client is undefined after successful initialization');
            throw new AuthenticationError('Authentication required. Please authenticate with OnlineSales API.');
        }
        
        return true;
    }

    public async exportContent(): Promise<ContentDetailsDto[]> {
        try {
            // Ensure fresh client with latest config
            await this.ensureClientInitialized();
            
            Logger.info('Fetching content from API...');
            
            try {
                // Try to fetch from the real API endpoint
                const response = await this.client!.get<any>('/content/export');
                const responseData = response.data;
                
                // Additional debug logging (basic logging is handled by interceptors)
                Logger.info(`API response type: ${typeof responseData}, Is array: ${Array.isArray(responseData)}`);
                
                // Convert response to array if needed
                const contentArray = this.ensureResponseIsArray(responseData);
                
                // Debug log the response structure
                Logger.info(`API returned ${contentArray.length || 0} content items`);
                
                // Validate and filter out invalid content
                const validContent = contentArray.filter(item => 
                    item && 
                    typeof item === 'object' && 
                    item.id && 
                    item.title && 
                    item.slug && 
                    item.type
                );
                
                if (validContent.length < contentArray.length) {
                    Logger.info(`Filtered out ${contentArray.length - validContent.length} invalid content items`);
                }
                
                return validContent;
            } catch (apiError: any) {
                // Check specifically for authentication errors
                if (axios.isAxiosError(apiError) && apiError.response?.status === 401) {
                    Logger.error('Authentication failed (401 Unauthorized)', apiError);
                    throw new AuthenticationError('Your authentication token is invalid or expired. Please re-authenticate.');
                }
                
                // For other API errors, propagate them
                throw apiError;
            }
        } catch (error) {
            // Handle workspace initialization errors with a prompt
            if (error instanceof WorkspaceNotInitializedError) {
                const config = await this.configService.getConfig();
                if (config) {
                    // If we have a config file but no token, this is an auth issue
                    Logger.info('Workspace is initialized but not authenticated, prompting for authentication');
                    throw new AuthenticationError('Authentication required. Please authenticate with OnlineSales API.');
                }
                
                // Otherwise it's a real workspace initialization issue
                await handleWorkspaceNotInitializedError();
                return [];
            }
            
            // Pass authentication errors to be handled by the caller
            if (error instanceof AuthenticationError) {
                throw error;
            }
            
            Logger.error('Failed to export content', error);
            // Replace direct error message with utility function
            showErrorWithLogsOption('Failed to fetch content from API', error);
            if (error instanceof Error) {
                throw new Error(`Failed to export content: ${error.message}`);
            } else {
                throw new Error('Failed to export content: Unknown error');
            }
        }
        
        // Return empty array if we get here after showing the dialog
        return [];
    }
    
    /**
     * Ensures that the API response is an array of content items
     */
    private ensureResponseIsArray(data: any): any[] {
        // If it's already an array, return it
        if (Array.isArray(data)) {
            return data;
        }
        
        // If data has a 'data' property that's an array (common API pattern)
        if (data && typeof data === 'object' && Array.isArray(data.data)) {
            return data.data;
        }
        
        // If data has a 'content' or 'items' property that's an array (another common pattern)
        if (data && typeof data === 'object') {
            if (Array.isArray(data.content)) {
                return data.content;
            }
            if (Array.isArray(data.items)) {
                return data.items;
            }
            
            // If we have an object with properties that look like content items,
            // it might be a single item - wrap it in an array
            if (data.id && data.title && data.type) {
                return [data];
            }
            
            // If it's an object with keys that might be IDs, try to convert to array
            const potentialItems = Object.values(data);
            if (potentialItems.length > 0 && potentialItems.every(item => 
                item && typeof item === 'object')) {
                return potentialItems;
            }
        }
        
        // If all else fails, return an empty array
        console.warn('Could not convert API response to an array of content items:', data);
        return [];
    }

    public async createContent(content: ContentCreateDto): Promise<ContentDetailsDto> {
        try {
            // Ensure fresh client with latest config
            await this.ensureClientInitialized();

            // Log detailed content data for debugging
            Logger.info(`Creating content with API - endpoint: /content, slug: ${content.slug}, type: ${content.type}, title: ${content.title}`);

            const response = await this.client!.post<ContentDetailsDto>('/content', content);
            return response.data;
        } catch (error: any) {
            if (error instanceof WorkspaceNotInitializedError) {
                await handleWorkspaceNotInitializedError();
                throw new Error('Workspace not initialized');
            }

            if (axios.isAxiosError(error) && error.response) {
                const status = error.response.status;
                
                // Log detailed information about the failed request
                Logger.error(`Content creation failed with status ${status}`, {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: error.response.data,
                    contentType: content.type,
                    contentSlug: content.slug,
                    contentTitle: content.title,
                    contentLength: content.body?.length || 0,
                    contentBodyPreview: content.body?.substring(0, 200) + (content.body?.length ? (content.body.length > 200 ? '...' : '') : ''),
                    requestHeaders: error.config?.headers,
                    fullPayload: content  // Log the entire content object for deep debugging
                });
                
                if (status === 401) {
                    throw new AuthenticationError('Your authentication token is invalid or expired. Please re-authenticate.');
                } else if (status === 406) {
                    // Log full content payload to a separate file for debugging
                    Logger.logContentPayload('CONTENT CREATION FAILED (406)', content);
                    
                    // Show more helpful error message
                    const message = 'Content validation failed (HTTP 406): The server rejected the content format. ' +
                                   'Complete content payload has been logged for debugging.';
                    throw new Error(message);
                }
            }
            
            Logger.error('Failed to create content', error);
            // Replace direct error message with utility function
            showErrorWithDetails('Failed to create content', error);
            throw new Error('Failed to create content');
        }
    }

    public async updateContent(id: string, content: ContentUpdateDto): Promise<ContentDetailsDto> {
        try {
            // Ensure fresh client with latest config
            await this.ensureClientInitialized();

            // Log detailed content data for debugging
            Logger.info(`Updating content with API - endpoint: /content/${id}, slug: ${content.slug}, title: ${content.title}`);

            const response = await this.client!.patch<ContentDetailsDto>(`/content/${id}`, content);
            return response.data;
        } catch (error: any) {
            if (error instanceof WorkspaceNotInitializedError) {
                await handleWorkspaceNotInitializedError();
                throw new Error('Workspace not initialized');
            }

            if (axios.isAxiosError(error) && error.response) {
                const status = error.response.status;
                
                // Log detailed information about the failed request
                Logger.error(`Content update failed with status ${status}`, {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: error.response.data,
                    contentId: id,
                    contentSlug: content.slug,
                    contentTitle: content.title,
                    contentLength: content.body?.length || 0,
                    contentBodyPreview: content.body?.substring(0, 200) + (content.body?.length ? (content.body.length > 200 ? '...' : '') : ''),
                    requestHeaders: error.config?.headers,
                    fullPayload: content  // Log the entire content object for deep debugging
                });

                if (status === 401) {
                    throw new AuthenticationError('Your authentication token is invalid or expired. Please re-authenticate.');
                } else if (status === 406) {
                    // Log full content payload to a separate file for debugging
                    Logger.logContentPayload(`CONTENT UPDATE FAILED (406) - ID: ${id}`, content);
                    
                    // Show more helpful error message
                    const message = 'Content validation failed (HTTP 406): The server rejected the content format. ' +
                                   'Complete content payload has been logged for debugging.';
                    throw new Error(message);
                }
            }
            
            Logger.error(`Failed to update content with ID ${id}:`, error);
            // Replace direct error message with utility function
            showErrorWithDetails('Failed to update content', error);
            throw new Error(`Failed to update content with ID ${id}`);
        }
    }

    /**
     * Uploads a media file to the API
     * @returns Either a string URL or an object with a location property
     */
    public async uploadMedia(fileContent: Buffer, fileName: string, scopeUid: string): Promise<string | { location: string }> {
        try {
            // Ensure fresh client with latest config
            await this.ensureClientInitialized();

            // Create form data
            const formData = new FormData();
            formData.append('Image', new Blob([fileContent]), fileName);
            formData.append('ScopeUid', scopeUid);

            const response = await this.client!.post<string | { location: string }>('/media', formData, {
                headers: {
                    'Content-Type': 'multipart/form-data'
                },
            });
            
            Logger.info(`Media upload response type: ${typeof response.data}, value: ${JSON.stringify(response.data)}`);
            return response.data;
        } catch (error: any) {
            if (error instanceof WorkspaceNotInitializedError) {
                await handleWorkspaceNotInitializedError();
                throw new Error('Workspace not initialized');
            }

            if (axios.isAxiosError(error) && error.response?.status === 401) {
                Logger.error('Authentication failed (401 Unauthorized)', error);
                throw new AuthenticationError('Your authentication token is invalid or expired. Please re-authenticate.');
            }
            Logger.error('Failed to upload media file', error);
            showErrorWithDetails('Failed to upload media file', error);
            throw new Error('Failed to upload media file');
        }
    }

    /**
     * Deletes a content item from the API
     */
    public async deleteContent(id: string): Promise<void> {
        try {
            // Ensure fresh client with latest config
            await this.ensureClientInitialized();

            await this.client!.delete(`/content/${id}`);
        } catch (error: any) {
            if (error instanceof WorkspaceNotInitializedError) {
                await handleWorkspaceNotInitializedError();
                throw new Error('Workspace not initialized');
            }

            if (axios.isAxiosError(error) && error.response?.status === 401) {
                Logger.error('Authentication failed (401 Unauthorized)', error);
                throw new AuthenticationError('Your authentication token is invalid or expired. Please re-authenticate.');
            }
            Logger.error(`Failed to delete content with ID ${id}:`, error);
            showErrorWithDetails('Failed to delete content', error);
            throw new Error(`Failed to delete content with ID ${id}`);
        }
    }

    /**
     * Deletes a media file from the API
     * @param mediaPath The full media path in format type/slug/filename
     */
    public async deleteMedia(mediaPath: string): Promise<void> {
        try {
            // Ensure fresh client with latest config
            await this.ensureClientInitialized();

            Logger.info(`Deleting media file: ${mediaPath}`);
            
            // The API expects the path to be URL encoded
            const encodedPath = encodeURIComponent(mediaPath);
            await this.client!.delete(`/api/media/${encodedPath}`);
            
            Logger.info(`Successfully deleted media file: ${mediaPath}`);
        } catch (error: any) {
            if (error instanceof WorkspaceNotInitializedError) {
                await handleWorkspaceNotInitializedError();
                throw new Error('Workspace not initialized');
            }

            if (axios.isAxiosError(error) && error.response?.status === 401) {
                Logger.error('Authentication failed (401 Unauthorized)', error);
                throw new AuthenticationError('Your authentication token is invalid or expired. Please re-authenticate.');
            }
            
            Logger.error(`Failed to delete media file ${mediaPath}:`, error);
            showErrorWithDetails('Failed to delete media file', error);
            throw new Error(`Failed to delete media file: ${mediaPath}`);
        }
    }

    // Any other methods that might use error messages directly
    private handleApiError(error: any, message: string): void {
        // Replace with utility function
        showErrorWithLogsOption(message, error);
    }
}
