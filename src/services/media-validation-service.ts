import * as vscode from 'vscode';
import { MediaService } from './media-service';
import { Logger } from '../utils/logger';
import { ValidationService } from '../validation/validation-service';

/**
 * Service to validate media references in content files
 * @deprecated This service is kept for backwards compatibility. 
 * Use ValidationService with MediaValidator instead.
 */
export class MediaValidationService {
    private workspacePath: string | undefined;
    private mediaService: MediaService;
    private validationService: ValidationService;

    constructor(workspacePath: string | undefined, mediaService: MediaService) {
        this.workspacePath = workspacePath;
        this.mediaService = mediaService;
        this.validationService = new ValidationService(workspacePath);
    }

    /**
     * Validates all media references in the workspace
     */
    public async validateAllMediaReferences(): Promise<number> {
        Logger.info('Validating all media references...');
        
        try {
            // Use the validation service to validate all files
            return await this.validationService.validateAll();
        } catch (error) {
            Logger.error('Error validating media references:', error);
            return 0;
        }
    }

    /**
     * Validates media references in a single file
     */
    public async validateSingleFile(filePath: string): Promise<number> {
        if (!filePath.endsWith('.mdx') && !filePath.endsWith('.json')) {
            return 0;
        }
        
        try {
            // Use the validation service to validate a single file
            const result = await this.validationService.validateFile(filePath);
            return result.problems.length; // Return the number of problems instead of the result object
        } catch (error) {
            Logger.error(`Error validating media in file ${filePath}:`, error);
            return 0;
        }
    }
}
