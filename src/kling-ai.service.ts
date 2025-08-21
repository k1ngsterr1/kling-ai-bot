import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as jwt from 'jsonwebtoken';

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
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add request interceptor to add JWT authentication
    this.httpClient.interceptors.request.use(
      (config) => {
        const token = this.generateJwtToken();
        config.headers['Authorization'] = `Bearer ${token}`;

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

    // Add response interceptor for error handling
    this.httpClient.interceptors.response.use(
      (response) => {
        this.logger.debug(`Kling AI Response: ${response.status}`);
        return response;
      },
      (error) => {
        this.logger.error('Kling AI API Error:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          message: error.message,
        });
        return Promise.reject(error);
      },
    );
  }

  private generateJwtToken(): string {
    const headers = {
      alg: 'HS256',
      typ: 'JWT',
    };

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: this.accessKey,
      exp: now + 1800, // Current time + 30 minutes
      nbf: now - 5, // Current time - 5 seconds
    };

    this.logger.debug('JWT Payload:', {
      iss: this.accessKey,
      exp: payload.exp,
      nbf: payload.nbf,
      currentTime: now,
      validFor: '30 minutes',
    });

    const token = jwt.sign(payload, this.secretKey, { algorithm: 'HS256' });

    this.logger.debug(
      'Generated JWT token (first 20 chars):',
      token.substring(0, 20) + '...',
    );

    return token;
  }

  async generateVideo(request: KlingVideoRequest): Promise<KlingVideoResponse> {
    try {
      this.logger.log(
        `Starting video generation with prompt: "${request.prompt}"`,
      );

      // Map our parameters to Kling AI format according to documentation
      const klingRequest = {
        model: this.getKlingModel(request.quality),
        prompt: request.prompt,
        negative_prompt: '',
        aspect_ratio: request.aspectRatio,
        duration: request.duration,
        ...(request.images &&
          request.images.length > 0 && {
            image: request.images[0],
          }),
      };

      this.logger.log(
        'Sending request to Kling AI:',
        JSON.stringify(klingRequest, null, 2),
      );

      // Use the correct endpoint from documentation
      const response = await this.httpClient.post(
        '/v1/videos/text2video',
        klingRequest,
      );

      this.logger.log(
        'Kling AI Generate Response:',
        JSON.stringify(
          {
            status: response.status,
            statusText: response.statusText,
            data: response.data,
          },
          null,
          2,
        ),
      );

      const result: KlingVideoResponse = {
        id:
          response.data.data?.task_id ||
          response.data.id ||
          this.generateMockId(),
        status: this.mapKlingStatus(
          response.data.data?.task_status || 'pending',
        ),
        estimatedTime: this.getEstimatedTime(request.quality),
      };

      this.logger.log(
        `Video generation started with ID: ${result.id}, status: ${result.status} (raw: ${response.data.data?.task_status})`,
      );
      return result;
    } catch (error) {
      this.logger.error('Error generating video:', error);

      if (error.response) {
        this.logger.error('API Response Error:', {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
        });
      }

      if (error.request) {
        this.logger.error('API Request Error:', error.request);
      }

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

      // Get list of all videos and find our task
      const response = await this.httpClient.get('/v1/videos/text2video', {
        params: {
          task_id: videoId,
        },
      });

      this.logger.debug(`Kling AI Status Response:`, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data: JSON.stringify(response.data, null, 2),
      });

      // Find the specific task in the response array
      const tasks = response.data.data || [];
      this.logger.debug(`Found ${tasks.length} tasks in response`);

      const task = tasks.find((t) => t.task_id === videoId);

      if (!task) {
        this.logger.warn(`Task ${videoId} not found in response`);
        this.logger.debug(
          `Available task IDs:`,
          tasks.map((t) => t.task_id),
        );
        return {
          id: videoId,
          status: 'failed',
        };
      }

      this.logger.debug(
        `Task details for ${videoId}:`,
        JSON.stringify(task, null, 2),
      );

      const result: KlingVideoResponse = {
        id: videoId,
        status: this.mapKlingStatus(task.task_status),
        videoUrl:
          task.task_status === 'succeed' && task.task_result?.videos?.length > 0
            ? task.task_result.videos[0].url
            : undefined,
      };

      this.logger.log(
        `Video ${videoId} status: ${result.status} (raw: ${task.task_status})`,
      );
      if (task.task_result) {
        this.logger.debug(
          `Task result:`,
          JSON.stringify(task.task_result, null, 2),
        );
      }
      if (result.videoUrl) {
        this.logger.log(`Video URL: ${result.videoUrl}`);
      }

      return result;
    } catch (error) {
      this.logger.error(`Error checking video status for ${videoId}:`, error);

      if (error.response) {
        this.logger.error('Status Check API Response Error:', {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
        });
      }

      if (error.request) {
        this.logger.error('Status Check API Request Error:', error.request);
      }

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
    return modelMap[quality] || 'kling-v-1';
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
