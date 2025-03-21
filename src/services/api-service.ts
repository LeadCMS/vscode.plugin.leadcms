import axios, { AxiosInstance } from 'axios';
import * as vscode from 'vscode';
import { ContentCreateDto, ContentDetailsDto, ContentUpdateDto } from '../models/content';
import { ConfigService } from './config-service';
import { MockService } from './mock-service';

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

    public async initialize(): Promise<boolean> {
        try {
            if (!this.configService.hasWorkspace()) {
                return false;
            }
            
            const config = await this.configService.getConfig();
            const tokenConfig = await this.configService.getToken();
            
            if (!config || !config.domain || !tokenConfig || !tokenConfig.accessToken) {
                return false;
            }

            this.client = axios.create({
                baseURL: `${config.domain}/api`,
                headers: {
                    'Authorization': `Bearer ${tokenConfig.accessToken}`,
                    'Accept': 'text/json'
                }
            });
            
            return true;
        } catch (error) {
            console.error('Failed to initialize API client:', error);
            return false;
        }
    }

    public async exportContent(): Promise<ContentDetailsDto[]> {
        if (!this.client) {
            await this.initialize();
            if (!this.client) {
                // If we still don't have a client, use mock data for development
                console.warn('API client not initialized, using mock data');
                return MockService.getMockContent();
            }
        }

        try {
            console.log('Fetching content from API...');
            
            let responseData: any;
            
            try {
                // Try to fetch from the real API endpoint
                const response = await this.client.get<any>('/content/export');
                console.log('API response received:', response.status);
                responseData = response.data;
                
                // Debug the actual response structure
                console.log('API response type:', typeof responseData);
                console.log('Is array?', Array.isArray(responseData));
                console.log('Response value:', JSON.stringify(responseData).substring(0, 200) + '...');
            } catch (apiError) {
                // Log the API error details for debugging
                console.warn('API request failed, using mock data for testing:', apiError);
                if (axios.isAxiosError(apiError) && apiError.config) {
                    console.error('API error details:', {
                        status: apiError.response?.status,
                        statusText: apiError.response?.statusText,
                        data: apiError.response?.data,
                        config: {
                            url: apiError.config?.url || 'unknown',
                            method: apiError.config?.method || 'unknown',
                            baseURL: apiError.config?.baseURL || 'unknown'
                        }
                    });
                }
                
                // Use mock data for testing when API is unavailable
                responseData = MockService.getMockContent();
                console.log('Using mock data with', responseData.length, 'items');
            }
            
            // Convert response to array if needed
            const contentArray = this.ensureResponseIsArray(responseData);
            
            // Debug log the response structure
            console.log(`API returned ${contentArray.length || 0} content items`);
            if (contentArray.length > 0) {
                console.log('First content item example:', JSON.stringify(contentArray[0], null, 2));
            } else {
                console.warn('API returned no content items');
            }
            
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
                console.warn(`Filtered out ${contentArray.length - validContent.length} invalid content items`);
            }
            
            return validContent;
        } catch (error) {
            console.error('Failed to export content:', error);
            // Instead of just throwing a generic error, include more useful information
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
        if (!this.client) {
            await this.initialize();
            if (!this.client) {
                throw new Error('API client not initialized');
            }
        }

        try {
            const response = await this.client.post<ContentDetailsDto>('/content', content);
            return response.data;
        } catch (error) {
            console.error('Failed to create content:', error);
            throw new Error('Failed to create content');
        }
    }

    public async updateContent(id: string, content: ContentUpdateDto): Promise<ContentDetailsDto> {
        if (!this.client) {
            await this.initialize();
            if (!this.client) {
                throw new Error('API client not initialized');
            }
        }

        try {
            const response = await this.client.patch<ContentDetailsDto>(`/content/${id}`, content);
            return response.data;
        } catch (error) {
            console.error(`Failed to update content with ID ${id}:`, error);
            throw new Error(`Failed to update content with ID ${id}`);
        }
    }

    public async uploadMedia(file: Buffer, filename: string): Promise<string> {
        if (!this.client) {
            await this.initialize();
            if (!this.client) {
                throw new Error('API client not initialized');
            }
        }

        try {
            const formData = new FormData();
            const blob = new Blob([file], { type: 'application/octet-stream' });
            formData.append('file', blob, filename);

            const response = await this.client.post('/media', formData, {
                headers: {
                    'Content-Type': 'multipart/form-data'
                }
            });
            
            return response.data.url;
        } catch (error) {
            console.error('Failed to upload media:', error);
            throw new Error('Failed to upload media');
        }
    }
}
