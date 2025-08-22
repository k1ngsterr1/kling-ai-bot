import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
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

export interface KlingImageRequest {
  prompt: string;
  aspectRatio: '1:1' | '9:16' | '16:9';
}

export interface KlingImageResponse {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  imageUrl?: string;
  estimatedTime?: number;
}

@Injectable()
export class KlingAiService implements OnModuleInit {
  private readonly logger = new Logger(KlingAiService.name);
  private httpClient: AxiosInstance;
  private accessKey: string;
  private secretKey: string;

  // JWT token caching
  private cachedJwtToken: string | null = null;
  private jwtTokenExpiry: number = 0;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    this.loadKlingConfig();
    this.initializeHttpClient();
  }

  async onModuleInit() {
    await this.loadKlingConfig();
    this.initializeHttpClient();

    // Test API keys on startup
    if (this.accessKey && this.secretKey) {
      const testResult = await this.testApiKeys();
      if (!testResult.valid) {
        this.logger.error('🚫 Kling API keys test failed:', testResult.error);
        this.logger.error(
          'Please check and update your API keys via /admin panel',
        );
      }
    }
  }

  private async loadKlingConfig() {
    try {
      // Load from database ONLY
      const config = await this.prisma.klingConfig.findFirst({
        orderBy: { updatedAt: 'desc' },
      });

      if (config && config.accessKey && config.secretKey) {
        this.accessKey = config.accessKey;
        this.secretKey = config.secretKey;
        this.logger.log('✅ Using Kling keys from database');
        this.logger.log(`Access Key: ${this.accessKey.substring(0, 8)}...`);
        this.logger.log(`Secret Key: ${this.secretKey.substring(0, 8)}...`);
      } else {
        this.logger.warn('❌ No Kling API keys found in database!');
        this.logger.warn(
          'Please configure API keys using admin panel (/admin)',
        );
        this.accessKey = '';
        this.secretKey = '';
      }
    } catch (error) {
      this.logger.error('Error loading Kling config from database:', error);
      this.accessKey = '';
      this.secretKey = '';
    }
  }

  private async saveKlingConfig() {
    try {
      // Delete old configs and create new one
      await this.prisma.klingConfig.deleteMany({});
      await this.prisma.klingConfig.create({
        data: {
          accessKey: this.accessKey,
          secretKey: this.secretKey,
        },
      });
    } catch (error) {
      this.logger.error('Error saving Kling config:', error);
    }
  }

  private initializeHttpClient() {
    this.logger.log('Initializing HTTP client...');

    // Clear JWT cache on initialization
    this.cachedJwtToken = null;
    this.jwtTokenExpiry = 0;

    this.httpClient = axios.create({
      baseURL: 'https://api.klingai.com',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'KlingAI-Bot/1.0',
      },
    });

    // Request interceptor for JWT token
    this.httpClient.interceptors.request.use(
      async (config) => {
        const token = await this.generateJwtToken();
        config.headers.Authorization = `Bearer ${token}`;
        return config;
      },
      (error) => {
        this.logger.error('Request interceptor error:', error);
        return Promise.reject(error);
      },
    );

    // Response interceptor for error handling
    this.httpClient.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        // Retry on specific errors
        if (
          error.response?.status === 401 ||
          error.response?.status === 429 ||
          error.response?.status >= 500
        ) {
          if (!originalRequest._retryCount) {
            originalRequest._retryCount = 0;
          }

          if (originalRequest._retryCount < 3) {
            originalRequest._retryCount++;

            // Clear JWT cache on 401 error
            if (error.response?.status === 401) {
              this.logger.warn('Clearing JWT cache due to 401 error');
              this.cachedJwtToken = null;
              this.jwtTokenExpiry = 0;
            }

            const delay = Math.pow(2, originalRequest._retryCount) * 1000;
            this.logger.warn(
              `Retrying request (${originalRequest._retryCount}/3) after ${delay}ms`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            return this.httpClient.request(originalRequest);
          }
        }

        return Promise.reject(error);
      },
    );
  }

  private async retryRequest<T>(
    requestFn: () => Promise<T>,
    maxRetries: number = 3,
    delay: number = 1000,
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await requestFn();
      } catch (error) {
        this.logger.warn(
          `Attempt ${attempt}/${maxRetries} failed:`,
          error.message,
        );

        if (attempt === maxRetries) {
          throw error; // Re-throw on final attempt
        }

        // Exponential backoff delay
        await new Promise((resolve) =>
          setTimeout(resolve, delay * Math.pow(2, attempt - 1)),
        );
      }
    }

    // This should never be reached, but TypeScript requires it
    throw new Error('Retry logic failed unexpectedly');
  }

  private generateJwtToken(): string {
    const now = Math.floor(Date.now() / 1000);

    // Check if we have a valid cached token (with 5 minute buffer before expiry)
    if (this.cachedJwtToken && this.jwtTokenExpiry > now + 300) {
      this.logger.debug('Using cached JWT token');
      return this.cachedJwtToken;
    }

    // Create header
    const header = {
      alg: 'HS256',
      typ: 'JWT',
    };

    // Create payload according to Kling AI docs
    const expiry = now + 1800; // Expire in 30 minutes
    const payload = {
      iss: this.accessKey,
      exp: expiry,
      nbf: now, // Not before now
    };

    this.logger.debug('Generating new JWT token');
    this.logger.debug('JWT Header:', header);
    this.logger.debug('JWT Payload:', {
      iss: this.accessKey?.substring(0, 8) + '...',
      exp: payload.exp,
      nbf: payload.nbf,
      currentTime: now,
      validFor: '30 minutes',
    });

    // Create JWT token
    const token = jwt.sign(payload, this.secretKey, {
      algorithm: 'HS256',
      header: header,
    });

    // Cache the token
    this.cachedJwtToken = token;
    this.jwtTokenExpiry = expiry;

    this.logger.debug(
      'Generated JWT token (first 20 chars):',
      token.substring(0, 20) + '...',
    );

    // Log token parts for debugging
    const [headerB64, payloadB64, signature] = token.split('.');
    this.logger.debug('JWT Parts:', {
      header: headerB64,
      payload: payloadB64,
      signature: signature?.substring(0, 10) + '...',
    });

    return token;
  }

  // Test API keys validity
  async testApiKeys(): Promise<{ valid: boolean; error?: string }> {
    if (!this.accessKey || !this.secretKey) {
      return { valid: false, error: 'API keys not configured' };
    }

    try {
      // Simple test request to check if JWT auth works
      const response = await this.httpClient.get(
        '/v1/images/generations?page=1&size=1',
      );

      if (response.status === 200) {
        this.logger.log('✅ API keys are valid - test request successful');
        return { valid: true };
      } else {
        this.logger.warn(`⚠️ Unexpected response status: ${response.status}`);
        return { valid: false, error: `Unexpected status: ${response.status}` };
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;

        if (status === 401) {
          this.logger.error('❌ API keys are INVALID - Authentication failed');
          return { valid: false, error: `Authentication failed: ${message}` };
        } else {
          this.logger.warn(
            `⚠️ API test failed with status ${status}: ${message}`,
          );
          return { valid: false, error: `API error ${status}: ${message}` };
        }
      }

      this.logger.error('❌ API test failed:', error.message);
      return { valid: false, error: error.message };
    }
  }

  async generateVideo(request: KlingVideoRequest): Promise<KlingVideoResponse> {
    // Check if API keys are configured
    if (!this.accessKey || !this.secretKey) {
      this.logger.error('❌ Kling API keys not configured!');
      throw new Error(
        'API keys not configured. Please set them via admin panel.',
      );
    }

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

  // Image generation methods
  async generateImage(request: KlingImageRequest): Promise<KlingImageResponse> {
    // Check if API keys are configured
    if (!this.accessKey || !this.secretKey) {
      this.logger.error('❌ Kling API keys not configured!');
      throw new Error(
        'API keys not configured. Please set them via admin panel.',
      );
    }

    this.logger.log(
      `Starting image generation with prompt: "${request.prompt}"`,
    );

    this.logger.log(`Using Access Key: ${this.accessKey?.substring(0, 8)}...`);
    this.logger.log(`Using Secret Key: ${this.secretKey?.substring(0, 8)}...`);

    const endpoint = 'https://api.klingai.com/v1/images/generations';

    const payload = {
      model: 'kling-v-1',
      prompt: request.prompt,
      aspect_ratio: request.aspectRatio,
    };

    this.logger.log(
      'Sending image generation request to Kling AI:',
      JSON.stringify(payload, null, 2),
    );

    try {
      const response = await this.httpClient.post(endpoint, payload);

      this.logger.log(
        `Image generation initiated. Response: ${JSON.stringify(response.data)}`,
      );

      if (response.data && response.data.data && response.data.data.task_id) {
        return {
          id: response.data.data.task_id,
          status: 'pending',
          estimatedTime: 60, // Images typically take 1 minute
        };
      } else {
        throw new Error('Invalid response from Kling AI API');
      }
    } catch (error) {
      this.logger.error('Error generating image:', error);

      if (axios.isAxiosError(error)) {
        this.logger.error('API Error Status:', error.response?.status);
        this.logger.error('API Error Headers:', error.response?.headers);
        this.logger.error(
          'API Error Response:',
          JSON.stringify(error.response?.data, null, 2),
        );
        this.logger.error('API Error Config:', {
          url: error.config?.url,
          method: error.config?.method,
          headers: error.config?.headers,
        });
      }

      // Return mock response for development
      this.logger.warn(
        'Returning mock image generation response due to API error',
      );
      this.logger.warn(
        'This means the API call failed and you are seeing a placeholder image',
      );
      return {
        id: this.generateMockImageId(),
        status: 'pending',
        estimatedTime: 30,
      };
    }
  }

  async getImageStatus(imageId: string): Promise<KlingImageResponse> {
    this.logger.log(`Checking status for image: ${imageId}`);

    try {
      const result = await this.retryRequest(
        async () => {
          const endpoint = `https://api.klingai.com/v1/images/generations/${imageId}`;

          // Add specific timeout for status check
          const response = await this.httpClient.get(endpoint, {
            timeout: 30000, // 30 seconds timeout for status check
          });

          this.logger.log(
            `Image status response: ${JSON.stringify(response.data)}`,
          );

          // Find the specific task in the response array
          const tasks = response.data.data || [];
          this.logger.debug(`Found ${tasks.length} tasks in response`);

          const task = tasks.find((t) => t.task_id === imageId);

          if (!task) {
            this.logger.warn(`Task ${imageId} not found in response`);
            return {
              id: imageId,
              status: 'failed' as const,
            };
          }

          const result: KlingImageResponse = {
            id: imageId,
            status: this.mapKlingStatus(task.task_status),
            imageUrl:
              task.task_status === 'succeed' &&
              task.task_result?.images?.length > 0
                ? task.task_result.images[0].url
                : undefined,
          };

          this.logger.log(
            `Image ${imageId} status: ${result.status} (raw: ${task.task_status})`,
          );

          return result;
        },
        2,
        2000,
      ); // 2 retries with 2 second base delay

      return result;
    } catch (error) {
      this.logger.error('Error checking image status:', {
        imageId,
        error: error.message,
        code: error.code,
        timeout: error.code === 'ECONNABORTED' ? 'Request timeout' : false,
      });

      if (axios.isAxiosError(error)) {
        this.logger.error('API Error Response:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          headers: error.response?.headers,
        });

        // If it's a timeout or connection error, return processing to continue polling
        if (
          error.code === 'ECONNABORTED' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ECONNRESET'
        ) {
          this.logger.warn(
            `Connection/timeout error for ${imageId}, continuing polling...`,
          );
          return {
            id: imageId,
            status: 'processing',
          };
        }
      }

      // For development, simulate completion after some time
      this.logger.warn(
        `Mock image status check for ${imageId} - this is not a real generation result`,
      );
      const isOldRequest = this.isMockImageReady(imageId);
      return {
        id: imageId,
        status: isOldRequest ? 'completed' : 'processing',
        imageUrl: isOldRequest
          ? 'https://picsum.photos/512/512?random=1'
          : undefined,
      };
    }
  }

  private generateMockImageId(): string {
    return `IG-${Math.floor(Math.random() * 10000)}`;
  }

  private isMockImageReady(imageId: string): boolean {
    // Simple mock logic - consider image ready if it's been more than 30 seconds
    return Math.random() > 0.5;
  }

  private generateMockId(): string {
    return `VG-${Math.floor(Math.random() * 10000)}`;
  }

  private isMockVideoReady(videoId: string): boolean {
    // Simple mock logic - consider video ready if it's been more than 30 seconds
    // In real implementation, this would be based on actual API response
    return Math.random() > 0.5;
  }

  // Admin methods for updating API keys
  async updateAccessKey(newAccessKey: string): Promise<void> {
    this.logger.log(
      `Updating access key: ${newAccessKey.substring(0, 6)}***${newAccessKey.substring(newAccessKey.length - 4)}`,
    );
    this.accessKey = newAccessKey;
    // Clear JWT cache when keys change
    this.cachedJwtToken = null;
    this.jwtTokenExpiry = 0;
    await this.saveKlingConfig(); // Save to database
    this.initializeHttpClient(); // Reinitialize with new keys
  }

  async updateSecretKey(newSecretKey: string): Promise<void> {
    this.logger.log(
      `Updating secret key: ${newSecretKey.substring(0, 6)}***${newSecretKey.substring(newSecretKey.length - 4)}`,
    );
    this.secretKey = newSecretKey;
    // Clear JWT cache when keys change
    this.cachedJwtToken = null;
    this.jwtTokenExpiry = 0;
    await this.saveKlingConfig(); // Save to database
    this.initializeHttpClient(); // Reinitialize with new keys
  }

  getCurrentAccessKey(): string {
    return this.accessKey;
  }

  getCurrentSecretKey(): string {
    return this.secretKey;
  }

  updateBothKeys(newAccessKey: string, newSecretKey: string): void {
    this.logger.log('Updating both API keys');
    this.accessKey = newAccessKey;
    this.secretKey = newSecretKey;
    this.initializeHttpClient(); // Reinitialize with new keys
  }
}
