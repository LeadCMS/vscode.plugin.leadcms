import axios, { AxiosInstance } from 'axios';
import * as vscode from 'vscode';
import { ContentCreateDto, ContentDetailsDto, ContentUpdateDto } from '../models/content';
import { ConfigService } from './config-service';
import { MockService } from './mock-service';
import { Logger } from '../utils/logger';
import { AuthenticationError } from '../utils/errors';

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
            if (!this.configService.hasWorkspace()) {
                return false;
            }
            
            // Always get fresh config from file
            const config = await this.configService.getConfig();
            const tokenConfig = await this.configService.getToken();
            
            if (!config || !config.domain || !tokenConfig || !tokenConfig.accessToken) {
                return false;
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
            Logger.error('Failed to initialize API client', error);
            return false;
        }
    }

    /**
     * Set up request and response interceptors for logging
     */
    private setupInterceptors(): void {
        if (!this.client) return;
        
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
     */
    private async ensureClientInitialized(): Promise<boolean> {
        // Always reinitialize the client to get fresh config
        return await this.initialize();
    }

    public async exportContent(): Promise<ContentDetailsDto[]> {
        // Ensure fresh client with latest config
        if (!await this.ensureClientInitialized()) {
            // If initialization fails, use mock data
            Logger.info('API client not initialized, using mock data');
            return MockService.getMockContent();
        }

        // Now the client is definitely initialized with fresh config
        try {
            Logger.info('Fetching content from API...');
            
            let responseData: any;
            
            try {
                // Try to fetch from the real API endpoint
                const response = await this.client!.get<any>('/content/export');
                responseData = response.data;
                
                // Additional debug logging (basic logging is handled by interceptors)
                Logger.info(`API response type: ${typeof responseData}, Is array: ${Array.isArray(responseData)}`);
            } catch (apiError: any) {
                // Check specifically for authentication errors
                if (axios.isAxiosError(apiError) && apiError.response?.status === 401) {
                    Logger.error('Authentication failed (401 Unauthorized)', apiError);
                    throw new AuthenticationError('Your authentication token is invalid or expired. Please re-authenticate.');
                }
                
                // For other API errors, fall back to mock data
                Logger.error('API request failed, using mock data for testing', apiError);
                
                responseData = MockService.getMockContent();
                Logger.info(`Using mock data with ${responseData.length} items`);
            }
            
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
        } catch (error) {
            // Pass authentication errors to be handled by the caller
            if (error instanceof AuthenticationError) {
                throw error;
            }
            
            Logger.error('Failed to export content', error);
            if (error instanceof Error) {
                throw new Error(`Failed to export content: ${error.message}`);
            } else {
                throw new Error('Failed to export content: Unknown error');
            }
        }
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
        // Ensure fresh client with latest config
        if (!await this.ensureClientInitialized()) {
            throw new Error('API client not initialized');
        }

        try {
            const response = await this.client!.post<ContentDetailsDto>('/content', content);
            return response.data;
        } catch (error: any) {
            if (axios.isAxiosError(error) && error.response?.status === 401) {
                Logger.error('Authentication failed (401 Unauthorized)', error);
                throw new AuthenticationError('Your authentication token is invalid or expired. Please re-authenticate.');
            }
            Logger.error('Failed to create content', error);
            throw new Error('Failed to create content');
        }
    }

    public async updateContent(id: string, content: ContentUpdateDto): Promise<ContentDetailsDto> {
        // Ensure fresh client with latest config
        if (!await this.ensureClientInitialized()) {
            throw new Error('API client not initialized');
        }

        try {
            const response = await this.client!.patch<ContentDetailsDto>(`/content/${id}`, content);
            return response.data;
        } catch (error: any) {
            if (axios.isAxiosError(error) && error.response?.status === 401) {
                Logger.error('Authentication failed (401 Unauthorized)', error);
                throw new AuthenticationError('Your authentication token is invalid or expired. Please re-authenticate.');
            }
            Logger.error(`Failed to update content with ID ${id}:`, error);
            throw new Error(`Failed to update content with ID ${id}`);
        }
    }

    public async uploadMedia(file: Buffer, filename: string): Promise<string> {
        // Ensure fresh client with latest config
        if (!await this.ensureClientInitialized()) {
            throw new Error('API client not initialized');
        }

        try {
            const formData = new FormData();
            const blob = new Blob([file], { type: 'application/octet-stream' });
            formData.append('file', blob, filename);

            Logger.info(`Uploading media file: ${filename} (${file.length} bytes)`);
            
            const response = await this.client!.post('/media', formData, {
                headers: {
                    'Content-Type': 'multipart/form-data'
                }
            });
            
            return response.data.url;
        } catch (error) {
            Logger.error(`Failed to upload media: ${filename}`, error);
            throw new Error('Failed to upload media');
        }
    }
}
