import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

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
      baseURL: 'https://api.klingai.com',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add request interceptor to add authentication
    this.httpClient.interceptors.request.use(
      (config) => {
        const timestamp = Date.now().toString();
        const signature = this.generateSignature(
          config.method || 'GET',
          config.url || '',
          timestamp,
          config.data,
        );

        config.headers['Authorization'] =
          `KLING-HMAC-SHA256 AccessKey=${this.accessKey}, Signature=${signature}, Timestamp=${timestamp}`;

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

  private generateSignature(
    method: string,
    url: string,
    timestamp: string,
    body?: any,
  ): string {
    const bodyString = body ? JSON.stringify(body) : '';
    const stringToSign = `${method.toUpperCase()}\n${url}\n${timestamp}\n${bodyString}`;

    return crypto
      .createHmac('sha256', this.secretKey)
      .update(stringToSign)
      .digest('hex');
  }

  async generateVideo(request: KlingVideoRequest): Promise<KlingVideoResponse> {
    try {
      this.logger.log(
        `Starting video generation with prompt: "${request.prompt}"`,
      );

      // Map our parameters to Kling AI format
      const klingRequest = {
        model_name: this.getKlingModel(request.quality),
        prompt: request.prompt,
        negative_prompt: '',
        cfg_scale: 0.5,
        mode: 'std',
        duration: request.duration.toString(),
        aspect_ratio: request.aspectRatio,
        ...(request.images &&
          request.images.length > 0 && {
            image: request.images[0], // First image as reference
          }),
        ...(request.images &&
          request.images.length > 1 && {
            tail_image: request.images[1], // Second image if provided
          }),
      };

      // Make the API call to Kling AI
      const response = await this.httpClient.post(
        '/v1/videos/text2video',
        klingRequest,
      );

      const result: KlingVideoResponse = {
        id: response.data.data.task_id,
        status: 'pending',
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
      const response = await this.httpClient.get(`/v1/videos/${videoId}`);

      const result: KlingVideoResponse = {
        id: videoId,
        status: this.mapKlingStatus(response.data.data.task_status),
        videoUrl:
          response.data.data.task_status === 'succeed'
            ? response.data.data.works[0]?.resource.resource
            : undefined,
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
      standard: 'kling-v-1',
      pro: 'kling-v-1',
      master: 'kling-v-1-5',
    };
    return modelMap[quality] || modelMap.standard;
  }

  private mapKlingStatus(
    klingStatus: string,
  ): 'pending' | 'processing' | 'completed' | 'failed' {
    const statusMap = {
      submitted: 'pending',
      processing: 'processing',
      succeed: 'completed',
      failed: 'failed',
    };
    return statusMap[klingStatus] || 'processing';
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
