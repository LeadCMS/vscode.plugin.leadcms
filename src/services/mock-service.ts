import { ContentDetailsDto } from '../models/content';

/**
 * Mock service to provide sample data for testing when API is not available
 */
export class MockService {
    /**
     * Generate mock content for testing
     */
    public static getMockContent(): ContentDetailsDto[] {
        return [
            {
                id: "1",
                title: "Getting Started with OnlineSales CMS",
                description: "A guide to help you get started with using OnlineSales CMS",
                body: "# Getting Started with OnlineSales CMS\n\nThis is a sample blog post showing how to use the OnlineSales CMS.\n\n## Features\n\n- Easy content management\n- Markdown support\n- API integration\n\nGet started today!",
                slug: "getting-started",
                type: "blog",
                author: "OnlineSales Team",
                language: "en",
                tags: ["tutorial", "getting-started"],
                category: "Documentation",
                coverImageUrl: "https://example.com/images/getting-started.jpg",
                allowComments: true,
                publishedAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            },
            {
                id: "2",
                title: "About Us",
                description: "Learn about our company and mission",
                body: "# About Us\n\nWelcome to our company page. We are dedicated to providing the best service.\n\n## Our Mission\n\nTo make content management easy and accessible for everyone.",
                slug: "about-us",
                type: "page",
                author: "OnlineSales Team",
                language: "en",
                tags: ["company", "about"],
                category: "Company",
                coverImageUrl: "https://example.com/images/about-us.jpg",
                allowComments: false,
                publishedAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }
        ];
    }
}
