export interface ContentDetailsDto {
    id: string;
    title: string;
    description: string;
    body?: string;
    slug: string;
    type: string;
    author: string;
    language: string;
    tags: string[];
    category: string;
    coverImageUrl: string;
    allowComments: boolean;
    publishedAt: string;
    createdAt: string;
    updatedAt: string;
}

export interface ContentCreateDto {
    title: string;
    description: string;
    body: string;
    slug: string;
    type: string;
    author: string;
    language: string;
    tags?: string[];
    category?: string;
    coverImageUrl?: string;
    allowComments?: boolean;
    publishedAt?: string;
    source?: string;
}

export interface ContentUpdateDto {
    title?: string;
    description?: string;
    body?: string;
    slug?: string;
    author?: string;
    language?: string;
    tags?: string[];
    category?: string;
    coverImageUrl?: string;
    allowComments?: boolean;
    publishedAt?: string;
    source?: string;
}
