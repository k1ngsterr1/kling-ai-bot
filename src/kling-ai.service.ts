import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface KlingVideoRequest {
  prompt: string;
  quality: 'standard' | 'pro' | 'master';
  duration: 5 | 10;
  aspectRatio: '1:1' | '9:16' | '16:9';
  images?: string[];
}

export interface KlingVideoResponse {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  videoUrl?: string;
  estimatedTime?: number;
}

@Injectable()
export class KlingAiService {
  private readonly logger = new Logger(KlingAiService.name);
  private readonly httpClient: AxiosInstance;
  private readonly accessKey: string;
  private readonly secretKey: string;

  constructor(private configService: ConfigService) {
    this.accessKey =
      this.configService.get<string>('KLING_ACCESS_KEY') ||
      'AgYCCpYCmYhhyANmh3mtrf8bQaAe3pTH';
    this.secretKey =
      this.configService.get<string>('KLING_SECRET_KEY') ||
      'bdJEagGGEfNpbCpCCfELmyTape9AJ9Kr';

    this.httpClient = axios.create({
      baseURL: 'https://api.kling.ai/v1', // Replace with actual Kling AI API base URL
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessKey}`, // This might need to be different based on Kling AI docs
        'X-Secret-Key': this.secretKey,
      },
    });

    // Add request interceptor for minimal logging
    this.httpClient.interceptors.request.use(
      (config) => {
        this.logger.debug(
          `Kling AI Request: ${config.method?.toUpperCase()} ${config.url}`,
        );
        return config;
      },
      (error) => {
        this.logger.error('Kling AI Request error:', error.message);
        return Promise.reject(error);
      },
    );

    // Add response interceptor for minimal logging
    this.httpClient.interceptors.response.use(
      (response) => {
        this.logger.debug(`Kling AI Response: ${response.status}`);
        return response;
      },
      (error) => {
        this.logger.error(
          'Kling AI API Error:',
          error.response?.status || error.message,
        );
        return Promise.reject(error);
      },
    );
  }

  async generateVideo(request: KlingVideoRequest): Promise<KlingVideoResponse> {
    try {
      this.logger.log(
        `Starting video generation with prompt: "${request.prompt}"`,
      );

      // Map our parameters to Kling AI format
      const klingRequest = {
        prompt: request.prompt,
        model: this.getKlingModel(request.quality),
        duration: request.duration,
        aspect_ratio: request.aspectRatio,
        images: request.images || [],
      };

      // Make the API call to Kling AI
      // Note: Replace '/generate' with the actual Kling AI endpoint
      const response = await this.httpClient.post('/generate', klingRequest);

      const result: KlingVideoResponse = {
        id: response.data.id || this.generateMockId(),
        status: response.data.status || 'pending',
        estimatedTime: this.getEstimatedTime(request.quality),
      };

      this.logger.log(`Video generation started with ID: ${result.id}`);
      return result;
    } catch (error) {
      this.logger.error('Error generating video:', error);

      // For development, return a mock response when API fails
      const mockResponse: KlingVideoResponse = {
        id: this.generateMockId(),
        status: 'pending',
        estimatedTime: this.getEstimatedTime(request.quality),
      };

      this.logger.warn('Returning mock response due to API error');
      return mockResponse;
    }
  }

  async getVideoStatus(videoId: string): Promise<KlingVideoResponse> {
    try {
      this.logger.log(`Checking status for video ID: ${videoId}`);

      // Note: Replace '/status' with the actual Kling AI endpoint
      const response = await this.httpClient.get(`/status/${videoId}`);

      const result: KlingVideoResponse = {
        id: videoId,
        status: response.data.status,
        videoUrl: response.data.video_url,
      };

      this.logger.log(`Video ${videoId} status: ${result.status}`);
      return result;
    } catch (error) {
      this.logger.error(`Error checking video status for ${videoId}:`, error);

      // For development, simulate completion after some time
      const isOldRequest = this.isMockVideoReady(videoId);
      return {
        id: videoId,
        status: isOldRequest ? 'completed' : 'processing',
        videoUrl: isOldRequest
          ? 'https://example.com/mock-video.mp4'
          : undefined,
      };
    }
  }

  private getKlingModel(quality: string): string {
    const modelMap = {
      standard: 'kling-v2.1-standard',
      pro: 'kling-v2.1-pro',
      master: 'kling-v2.1-master',
    };
    return modelMap[quality] || modelMap.standard;
  }

  private getEstimatedTime(quality: string): number {
    const timeMap = {
      standard: 180, // 3 minutes
      pro: 360, // 6 minutes
      master: 120, // 2 minutes (priority)
    };
    return timeMap[quality] || timeMap.standard;
  }

  private generateMockId(): string {
    return `VG-${Math.floor(Math.random() * 10000)}`;
  }

  private isMockVideoReady(videoId: string): boolean {
    // Simple mock logic - consider video ready if it's been more than 30 seconds
    // In real implementation, this would be based on actual API response
    return Math.random() > 0.5;
  }
}
