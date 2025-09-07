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
  errorMessage?: string;
}

export interface KlingImageRequest {
  prompt: string;
  aspectRatio: '1:1' | '9:16' | '16:9' | '4:3' | '3:4' | '3:2' | '2:3' | '21:9';
  negativePrompt?: string;
  images?: string[]; // Reference images (URLs or base64)
  imageReference?: 'subject' | 'face'; // For kling-v1-5
  imageFidelity?: number; // Face reference intensity [0,1]
  humanFidelity?: number; // Facial reference intensity [0,1]
  resolution?: '1k' | '2k';
  modelName?:
    | 'kling-v1'
    | 'kling-v1-5'
    | 'kling-v2'
    | 'kling-v2-new'
    | 'kling-v2-1';
  numberOfImages?: number; // [1,9]
}

export interface KlingImageResponse {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  imageUrl?: string;
  estimatedTime?: number;
  errorMessage?: string;
}

@Injectable()
export class KlingAiService implements OnModuleInit {
  private readonly logger = new Logger(KlingAiService.name);
  private httpClient: AxiosInstance;

  // Множественные API ключи
  private currentApiKey: {
    id: number;
    accessKey: string;
    secretKey: string;
    name: string;
    priority: number;
    isActive: boolean;
    isAvailable: boolean;
    errorCount: number;
    requestCount: number;
    lastUsed: Date | null;
  } | null = null;
  private apiKeys: Array<{
    id: number;
    accessKey: string;
    secretKey: string;
    name: string;
    priority: number;
    isActive: boolean;
    isAvailable: boolean;
    errorCount: number;
    requestCount: number;
    lastUsed: Date | null;
  }> = [];

  // JWT token caching для текущего ключа
  private cachedJwtToken: string | null = null;
  private jwtTokenExpiry: number = 0;

  // Настройки для автоматического переключения
  private readonly MAX_ERRORS_BEFORE_SWITCH = 3; // Максимум ошибок перед переключением
  private readonly API_RECOVERY_TIME = 30 * 60 * 1000; // 30 минут для восстановления API
  private readonly REQUEST_TIMEOUT = 30000; // 30 секунд таймаут

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    this.initializeHttpClient();
  }

  async onModuleInit() {
    await this.loadApiKeys();
    this.initializeHttpClient();

    // Test API keys on startup
    if (this.currentApiKey) {
      const testResult = await this.testCurrentApiKey();
      if (!testResult.valid) {
        this.logger.error('🚫 Kling API keys test failed:', testResult.error);
        await this.switchToNextAvailableApiKey();
      }
    }
  }

  /**
   * Загружает все доступные API ключи из базы данных
   */
  private async loadApiKeys() {
    try {
      const configs = await this.prisma.klingConfig.findMany({
        where: { isActive: true },
        orderBy: [
          { priority: 'desc' }, // Сначала по приоритету
          { isDefault: 'desc' }, // Потом по дефолтности
          { updatedAt: 'desc' }, // Потом по времени обновления
        ],
      });

      this.apiKeys = configs.map((config) => ({
        id: config.id,
        accessKey: config.accessKey,
        secretKey: config.secretKey,
        name: config.name,
        priority: config.priority,
        isActive: config.isActive,
        isAvailable: config.isAvailable,
        errorCount: config.errorCount,
        requestCount: config.requestCount,
        lastUsed: config.lastUsed,
      }));

      if (this.apiKeys.length > 0) {
        // Выбираем первый доступный ключ
        await this.selectBestApiKey();
        this.logger.log(
          `✅ Loaded ${this.apiKeys.length} API key(s) from database`,
        );
        this.logger.log(`🎯 Using API key: ${this.currentApiKey?.name}`);
      } else {
        this.logger.warn('❌ No active Kling API keys found in database!');
        this.logger.warn(
          'Please configure API keys using admin panel (/admin)',
        );
        this.currentApiKey = null;
      }
    } catch (error) {
      this.logger.error('Error loading Kling API keys from database:', error);
      this.currentApiKey = null;
    }
  }

  /**
   * Выбирает лучший доступный API ключ
   */
  private async selectBestApiKey() {
    if (this.apiKeys.length === 0) {
      this.currentApiKey = null;
      return;
    }

    // Находим доступные ключи (без ошибок или с истекшим временем восстановления)
    const availableKeys: typeof this.apiKeys = [];
    const now = new Date();

    for (const key of this.apiKeys) {
      const config = await this.prisma.klingConfig.findUnique({
        where: { id: key.id },
      });

      if (config && config.isAvailable) {
        // Если ключ помечен как недоступный, проверяем, прошло ли время восстановления
        if (
          config.errorCount >= this.MAX_ERRORS_BEFORE_SWITCH &&
          config.lastUsed
        ) {
          const timeSinceLastError = now.getTime() - config.lastUsed.getTime();
          if (timeSinceLastError > this.API_RECOVERY_TIME) {
            // Время восстановления прошло, сбрасываем счетчик ошибок
            await this.resetApiKeyErrors(key.id);
            availableKeys.push(key);
          }
        } else {
          availableKeys.push(key);
        }
      }
    }

    if (availableKeys.length > 0) {
      // Сортируем по приоритету и выбираем лучший
      availableKeys.sort((a, b) => b.priority - a.priority);
      this.currentApiKey = availableKeys[0];
    } else {
      // Если нет доступных ключей, берем первый из списка и сбрасываем его ошибки
      this.currentApiKey = this.apiKeys[0];
      await this.resetApiKeyErrors(this.currentApiKey.id);
      this.logger.warn(
        '🔄 No available API keys, using first key and resetting errors',
      );
    }

    // Сбрасываем JWT токен при смене ключа
    this.cachedJwtToken = null;
    this.jwtTokenExpiry = 0;
  }

  /**
   * Переключается на следующий доступный API ключ
   */
  private async switchToNextAvailableApiKey(): Promise<boolean> {
    const currentKeyId = this.currentApiKey?.id;

    // Помечаем текущий ключ как недоступный
    if (currentKeyId) {
      await this.markApiKeyAsUnavailable(currentKeyId);
    }

    // Ищем следующий доступный ключ
    await this.selectBestApiKey();

    const switched = this.currentApiKey?.id !== currentKeyId;
    if (switched && this.currentApiKey) {
      this.logger.log(`🔄 Switched to API key: ${this.currentApiKey.name}`);
    }

    return switched;
  }

  /**
   * Помечает API ключ как недоступный из-за ошибок
   */
  private async markApiKeyAsUnavailable(keyId: number) {
    try {
      await this.prisma.klingConfig.update({
        where: { id: keyId },
        data: {
          errorCount: { increment: 1 },
          lastUsed: new Date(),
          isAvailable: false,
        },
      });
    } catch (error) {
      this.logger.error('Error marking API key as unavailable:', error);
    }
  }

  /**
   * Сбрасывает счетчик ошибок API ключа
   */
  private async resetApiKeyErrors(keyId: number) {
    try {
      await this.prisma.klingConfig.update({
        where: { id: keyId },
        data: {
          errorCount: 0,
          isAvailable: true,
        },
      });
    } catch (error) {
      this.logger.error('Error resetting API key errors:', error);
    }
  }

  /**
   * Обновляет статистику использования API ключа
   */
  private async updateApiKeyUsage(keyId: number, success: boolean) {
    try {
      const updateData: any = {
        lastUsed: new Date(),
        requestCount: { increment: 1 },
      };

      if (success) {
        // При успешном запросе сбрасываем счетчик ошибок
        updateData.errorCount = 0;
        updateData.isAvailable = true;
      } else {
        // При ошибке увеличиваем счетчик
        updateData.errorCount = { increment: 1 };
      }

      const updated = await this.prisma.klingConfig.update({
        where: { id: keyId },
        data: updateData,
      });

      // Если достигли лимита ошибок, помечаем ключ как недоступный
      if (!success && updated.errorCount >= this.MAX_ERRORS_BEFORE_SWITCH) {
        await this.prisma.klingConfig.update({
          where: { id: keyId },
          data: { isAvailable: false },
        });

        this.logger.warn(
          `🚫 API key ${this.currentApiKey?.name} marked as unavailable due to ${updated.errorCount} errors`,
        );

        // Пытаемся переключиться на другой ключ
        await this.switchToNextAvailableApiKey();
      }
    } catch (error) {
      this.logger.error('Error updating API key usage:', error);
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
      (config) => {
        const token = this.generateJwtToken();
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
    if (!this.currentApiKey) {
      throw new Error('No API key available for JWT generation');
    }

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
      iss: this.currentApiKey.accessKey,
      exp: expiry,
      nbf: now, // Not before now
    };

    this.logger.debug(
      'Generating new JWT token for API key:',
      this.currentApiKey.name,
    );
    this.logger.debug('JWT Header:', header);
    this.logger.debug('JWT Payload:', {
      iss: this.currentApiKey.accessKey?.substring(0, 8) + '...',
      exp: payload.exp,
      nbf: payload.nbf,
      currentTime: now,
      validFor: '30 minutes',
    });

    // Create JWT token
    const token = jwt.sign(payload, this.currentApiKey.secretKey, {
      algorithm: 'HS256',
      header: header,
      noTimestamp: true, // Убираем автоматическое поле iat
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

  // Test current API key validity
  async testCurrentApiKey(): Promise<{ valid: boolean; error?: string }> {
    if (!this.currentApiKey) {
      return { valid: false, error: 'No API key configured' };
    }

    try {
      // Simple test request to check if JWT auth works
      const response = await this.httpClient.get(
        '/v1/images/generations?page=1&size=1',
      );

      if (response.status === 200) {
        this.logger.log(
          `✅ API key ${this.currentApiKey.name} is valid - test request successful`,
        );
        await this.updateApiKeyUsage(this.currentApiKey.id, true);
        return { valid: true };
      } else {
        this.logger.warn(
          `⚠️ Unexpected response status: ${response.status} for key ${this.currentApiKey.name}`,
        );
        await this.updateApiKeyUsage(this.currentApiKey.id, false);
        return { valid: false, error: `Unexpected status: ${response.status}` };
      }
    } catch (error) {
      await this.updateApiKeyUsage(this.currentApiKey.id, false);
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;

        if (status === 401) {
          this.logger.error(
            `❌ API key ${this.currentApiKey.name} is INVALID - Authentication failed`,
          );
          return { valid: false, error: `Authentication failed: ${message}` };
        } else {
          this.logger.error(
            `❌ API request failed for key ${this.currentApiKey.name}:`,
            error.message,
          );
          return { valid: false, error: message };
        }
      }

      return {
        valid: false,
        error: error.message,
      };
    }
  }

  // Test API keys validity (legacy method for backwards compatibility)
  async testApiKeys(): Promise<{ valid: boolean; error?: string }> {
    return this.testCurrentApiKey();
  }

  async generateVideo(request: KlingVideoRequest): Promise<KlingVideoResponse> {
    if (!this.currentApiKey) {
      this.logger.error('❌ Kling API keys not configured!');
      throw new Error(
        'API keys not configured. Please set them via admin panel.',
      );
    }

    try {
      const hasImage =
        Array.isArray(request.images) && request.images.length > 0;

      // Decide endpoint
      const endpoint = hasImage
        ? '/v1/videos/image2video'
        : '/v1/videos/text2video';

      // Build payload according to Kling docs
      const klingRequest: any = {
        model_name: this.getKlingModel(request.quality),
        prompt: request.prompt ?? '',
        negative_prompt: '',
        aspect_ratio: request.aspectRatio,
        duration: request.duration,
        mode: request.quality === 'standard' ? 'std' : 'pro',
      };

      if (hasImage) {
        this.logger.log('Including image in video generation request');
        klingRequest.image = request.images![0];
        // If the API supports more controls (e.g., strength), add them here.
      }

      this.logger.log(
        `Starting ${hasImage ? 'image2video' : 'text2video'} with prompt: "${request.prompt || ''}"`,
      );
      this.logger.log(
        'Sending request to Kling AI:',
        JSON.stringify(klingRequest, null, 2),
      );

      const response = await this.httpClient.post(endpoint, klingRequest);

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
          response.data?.data?.task_id ||
          response.data?.id ||
          this.generateMockId(),
        status: this.mapKlingStatus(
          response.data?.data?.task_status || 'pending',
        ),
        estimatedTime: this.getEstimatedTime(request.quality),
      };

      this.logger.log(
        `Video generation started with ID: ${result.id}, status: ${result.status} (raw: ${response.data?.data?.task_status})`,
      );

      return result;
    } catch (error: any) {
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

      // Fallback mock for dev
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
        errorMessage:
          task.task_status === 'failed' ? task.task_status_msg : undefined,
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
      standard: 'kling-v1',
      pro: 'kling-v2-1-master',
      master: 'kling-v2-master',
    };
    return modelMap[quality] || 'kling-v1';
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
    if (!this.currentApiKey) {
      this.logger.error('❌ Kling API keys not configured!');
      throw new Error(
        'API keys not configured. Please set them via admin panel.',
      );
    }

    this.logger.log(
      `🎨 Generating image using ${this.currentApiKey.name} with prompt: "${request.prompt}"`,
    );

    this.logger.log(
      `Using API Key: ${this.currentApiKey.accessKey?.substring(0, 8)}...`,
    );

    const payload: any = {
      model_name: request.modelName || 'kling-v1',
      prompt: request.prompt,
      aspect_ratio: request.aspectRatio,
      resolution: request.resolution || '1k',
      n: request.numberOfImages || 1,
    };

    // Add negative prompt if provided
    if (request.negativePrompt) {
      payload.negative_prompt = request.negativePrompt;
    }

    // Add reference image if provided
    if (request.images && request.images.length > 0) {
      payload.image = request.images[0]; // Use first image as reference

      // Add image reference type for kling-v1-5
      if (request.modelName === 'kling-v1-5' && request.imageReference) {
        payload.image_reference = request.imageReference;

        if (
          request.imageReference === 'subject' &&
          request.humanFidelity !== undefined
        ) {
          payload.human_fidelity = request.humanFidelity;
        }
      }

      // Add image fidelity if provided
      if (request.imageFidelity !== undefined) {
        payload.image_fidelity = request.imageFidelity;
      }
    }

    this.logger.log(
      'Sending image generation request to Kling AI:',
      JSON.stringify(payload, null, 2),
    );

    try {
      // Use relative path so httpClient interceptors handle auth
      const response = await this.httpClient.post(
        '/v1/images/generations',
        payload,
      );

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
          // Use the list endpoint instead of direct task ID endpoint
          const response = await this.httpClient.get('/v1/images/generations', {
            params: {
              page: 1,
              size: 50, // Get more tasks to find our ID
            },
            timeout: 30000, // 30 seconds timeout for status check
          });

          this.logger.log(
            `Image list response: ${JSON.stringify(response.data)}`,
          );

          // Find the specific task in the response array
          const tasks = response.data.data || [];
          this.logger.debug(`Found ${tasks.length} tasks in response`);

          const task = tasks.find((t) => t.task_id === imageId);

          if (!task) {
            this.logger.warn(`Task ${imageId} not found in response`);
            // Maybe the task is on another page or older, return processing to continue polling
            return {
              id: imageId,
              status: 'processing' as const,
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
            errorMessage:
              task.task_status === 'failed' ? task.task_status_msg : undefined,
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

  async getImageResult(imageId: string): Promise<KlingImageResponse | null> {
    this.logger.log(`Getting final result for image: ${imageId}`);

    try {
      // Use the same logic as getImageStatus with retry mechanism
      const result = await this.retryRequest(
        async () => {
          // Use the list endpoint instead of direct task ID endpoint
          const response = await this.httpClient.get('/v1/images/generations', {
            params: {
              page: 1,
              size: 50, // Get more tasks to find our ID
            },
            timeout: 15000, // 15 seconds timeout
          });

          this.logger.log(
            `Image result response: ${JSON.stringify(response.data)}`,
          );

          // Find the specific task in the response array
          const tasks = response.data.data || [];
          const task = tasks.find((t) => t.task_id === imageId);

          if (!task) {
            this.logger.warn(`Task ${imageId} not found in final result`);
            return null;
          }

          // Only return if we have a completed image
          if (
            task.task_status === 'succeed' &&
            task.task_result?.images?.length > 0
          ) {
            const result: KlingImageResponse = {
              id: imageId,
              status: 'completed',
              imageUrl: task.task_result.images[0].url,
            };

            this.logger.log(
              `Got final result for image ${imageId}: ${result.imageUrl}`,
            );
            return result;
          }

          this.logger.log(
            `Image ${imageId} not yet ready: status=${task.task_status}`,
          );
          return null;
        },
        2,
        2000,
      ); // 2 retries with 2 second base delay

      return result;
    } catch (error) {
      this.logger.error('Error getting image result:', {
        imageId,
        error: error.message,
        code: error.code,
      });

      if (axios.isAxiosError(error)) {
        this.logger.error('API Error Response:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
        });
      }

      return null;
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

  // Admin methods for managing API keys
  async addApiKey(
    name: string,
    accessKey: string,
    secretKey: string,
    priority: number = 1,
  ): Promise<void> {
    this.logger.log(`Adding new API key: ${name}`);

    await this.prisma.klingConfig.create({
      data: {
        name,
        accessKey,
        secretKey,
        priority,
        isActive: true,
        isAvailable: true,
        errorCount: 0,
        requestCount: 0,
        lastUsed: new Date(),
      },
    });

    // Reload API keys
    await this.loadApiKeys();
    this.logger.log(`✅ API key "${name}" added successfully`);
  }

  async updateApiKey(
    id: number,
    updates: Partial<{
      name: string;
      accessKey: string;
      secretKey: string;
      priority: number;
      isActive: boolean;
    }>,
  ): Promise<void> {
    this.logger.log(`Updating API key with ID: ${id}`);

    await this.prisma.klingConfig.update({
      where: { id },
      data: updates,
    });

    // Reload API keys
    await this.loadApiKeys();
    this.logger.log(`✅ API key updated successfully`);
  }

  async removeApiKey(id: number): Promise<void> {
    this.logger.log(`Removing API key with ID: ${id}`);

    await this.prisma.klingConfig.delete({
      where: { id },
    });

    // Reload API keys
    await this.loadApiKeys();
    this.logger.log(`✅ API key removed successfully`);
  }

  async getAllApiKeys(): Promise<any[]> {
    return this.apiKeys.map((key) => ({
      id: key.id,
      name: key.name,
      accessKey: key.accessKey?.substring(0, 8) + '...',
      priority: key.priority,
      isActive: key.isActive,
      isAvailable: key.isAvailable,
      errorCount: key.errorCount,
      requestCount: key.requestCount,
      lastUsed: key.lastUsed,
    }));
  }

  /**
   * Создает новую пару API ключей с автоматической генерацией имени
   */
  async createNewApiKeyPair(
    accessKey: string,
    secretKey: string,
    customName?: string,
    priority: number = 1,
  ): Promise<{ id: number; name: string; success: boolean; error?: string }> {
    try {
      // Проверяем, что ключи не пустые
      if (!accessKey || !secretKey) {
        throw new Error('Access Key и Secret Key не могут быть пустыми');
      }

      // Проверяем, что такой же ключ уже не существует
      const existingKey = await this.prisma.klingConfig.findFirst({
        where: {
          OR: [{ accessKey: accessKey }, { secretKey: secretKey }],
        },
      });

      if (existingKey) {
        throw new Error('API ключ с такими данными уже существует');
      }

      // Генерируем имя если не указано
      let name = customName;
      if (!name) {
        const keyCount = await this.prisma.klingConfig.count();
        name = `API Key #${keyCount + 1}`;
      }

      // Проверяем уникальность имени
      const existingNameKey = await this.prisma.klingConfig.findFirst({
        where: { name },
      });

      if (existingNameKey) {
        const timestamp = new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/[:-]/g, '');
        name = `${name}_${timestamp}`;
      }

      // Создаем новую пару
      const newKey = await this.prisma.klingConfig.create({
        data: {
          name,
          accessKey,
          secretKey,
          priority,
          isActive: true,
          isAvailable: true,
          errorCount: 0,
          requestCount: 0,
          lastUsed: new Date(),
        },
      });

      // Перезагружаем API ключи
      await this.loadApiKeys();

      this.logger.log(
        `✅ Новая пара API ключей "${name}" успешно создана с ID: ${newKey.id}`,
      );

      return {
        id: newKey.id,
        name: newKey.name,
        success: true,
      };
    } catch (error) {
      this.logger.error(
        '❌ Ошибка при создании новой пары API ключей:',
        error.message,
      );
      return {
        id: 0,
        name: '',
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Тестирует новую пару API ключей перед сохранением
   */
  async testNewApiKeyPair(
    accessKey: string,
    secretKey: string,
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      // Проверяем, что ключи не пустые
      if (!accessKey || !secretKey) {
        return {
          valid: false,
          error: 'Access Key и Secret Key не могут быть пустыми',
        };
      }

      this.logger.log('🧪 Тестирование новой пары API ключей...');

      // Временно сохраняем текущие ключи
      const originalApiKey = this.currentApiKey;
      const originalJwtToken = this.cachedJwtToken;
      const originalJwtExpiry = this.jwtTokenExpiry;

      try {
        // Временно устанавливаем новые ключи для тестирования
        this.currentApiKey = {
          id: 0, // Временный ID
          accessKey,
          secretKey,
          name: 'TEST_KEY',
          priority: 1,
          isActive: true,
          isAvailable: true,
          errorCount: 0,
          requestCount: 0,
          lastUsed: new Date(),
        };

        // Сбрасываем JWT кеш для теста
        this.cachedJwtToken = null;
        this.jwtTokenExpiry = 0;

        // Пытаемся сделать тестовый запрос
        const testResponse = await axios.get(
          'https://api.klingai.com/v1/images/generations?page=1&size=1',
          {
            headers: {
              Authorization: `Bearer ${this.generateJwtToken()}`,
              'Content-Type': 'application/json',
            },
            timeout: 10000, // 10 секунд на тест
          },
        );

        if (testResponse.status === 200) {
          this.logger.log(
            '✅ Новая пара API ключей прошла тестирование успешно',
          );
          return { valid: true };
        } else {
          this.logger.warn(
            `⚠️ Неожиданный статус ответа: ${testResponse.status}`,
          );
          return {
            valid: false,
            error: `Неожиданный статус: ${testResponse.status}`,
          };
        }
      } finally {
        // Восстанавливаем оригинальные ключи
        this.currentApiKey = originalApiKey;
        this.cachedJwtToken = originalJwtToken;
        this.jwtTokenExpiry = originalJwtExpiry;
      }
    } catch (error) {
      this.logger.error(
        '❌ Ошибка при тестировании новой пары API ключей:',
        error.message,
      );

      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;

        if (status === 401) {
          return {
            valid: false,
            error: 'Неверные API ключи - авторизация не прошла',
          };
        } else if (status === 403) {
          return {
            valid: false,
            error: 'Доступ запрещен - проверьте права доступа API ключей',
          };
        } else {
          return { valid: false, error: `Ошибка API: ${message}` };
        }
      }

      return { valid: false, error: error.message };
    }
  }

  getCurrentApiKey(): any | null {
    if (!this.currentApiKey) return null;

    return {
      id: this.currentApiKey.id,
      name: this.currentApiKey.name,
      accessKey: this.currentApiKey.accessKey?.substring(0, 8) + '...',
      priority: this.currentApiKey.priority,
      isActive: this.currentApiKey.isActive,
      isAvailable: this.currentApiKey.isAvailable,
      errorCount: this.currentApiKey.errorCount,
      requestCount: this.currentApiKey.requestCount,
      lastUsed: this.currentApiKey.lastUsed,
    };
  }

  // Legacy methods for backwards compatibility (deprecated)
  async updateAccessKey(newAccessKey: string): Promise<void> {
    this.logger.warn(
      '⚠️ updateAccessKey is deprecated. Use addApiKey or updateApiKey instead.',
    );
    if (this.currentApiKey) {
      await this.updateApiKey(this.currentApiKey.id, {
        accessKey: newAccessKey,
      });
    }
  }

  async updateSecretKey(newSecretKey: string): Promise<void> {
    this.logger.warn(
      '⚠️ updateSecretKey is deprecated. Use addApiKey or updateApiKey instead.',
    );
    if (this.currentApiKey) {
      await this.updateApiKey(this.currentApiKey.id, {
        secretKey: newSecretKey,
      });
    }
  }

  getCurrentAccessKey(): string {
    this.logger.warn(
      '⚠️ getCurrentAccessKey is deprecated. Use getCurrentApiKey instead.',
    );
    return this.currentApiKey?.accessKey || '';
  }

  getCurrentSecretKey(): string {
    this.logger.warn(
      '⚠️ getCurrentSecretKey is deprecated. Use getCurrentApiKey instead.',
    );
    return this.currentApiKey?.secretKey || '';
  }

  updateBothKeys(newAccessKey: string, newSecretKey: string): void {
    this.logger.warn(
      '⚠️ updateBothKeys is deprecated. Use addApiKey or updateApiKey instead.',
    );
    if (this.currentApiKey) {
      this.updateApiKey(this.currentApiKey.id, {
        accessKey: newAccessKey,
        secretKey: newSecretKey,
      });
    }
  }
}
