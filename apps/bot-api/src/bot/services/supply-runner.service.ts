import { Injectable, Logger } from '@nestjs/common';

import { OzonSupplyService } from '@bot/ozon/ozon-supply.service';
import type {
  OzonSupplyProcessResult,
  OzonSupplyTask,
} from '@bot/ozon/ozon-supply.types';
import { OzonSupplyEventType } from '@bot/ozon/ozon-supply.types';
import type { OzonCredentials } from '@bot/config/ozon-api.service';

interface SupplyRunnerCallbacks {
  onEvent?: (result: OzonSupplyProcessResult) => void | Promise<void>;
  onWindowExpired?: (result: OzonSupplyProcessResult) => void | Promise<void>;
  onSupplyCreated?: (result: OzonSupplyProcessResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  onAbort?: () => void | Promise<void>;
}

interface SupplyRunnerParams {
  task: OzonSupplyTask;
  credentials: OzonCredentials;
  readyInDays: number;
  dropOffWarehouseId?: number;
  abortController: AbortController;
  callbacks?: SupplyRunnerCallbacks;
}

@Injectable()
export class SupplyRunnerService {
  private readonly logger = new Logger(SupplyRunnerService.name);

  constructor(private readonly supplyService: OzonSupplyService) {}

  async run(params: SupplyRunnerParams): Promise<void> {
    const { task, credentials, readyInDays, dropOffWarehouseId, abortController, callbacks } = params;

    let supplyCreated: OzonSupplyProcessResult | undefined;
    let windowExpired: OzonSupplyProcessResult | undefined;

    try {
      await this.supplyService.runSingleTask(task, {
        credentials,
        readyInDays,
        dropOffWarehouseId,
        skipDropOffValidation: true,
        abortSignal: abortController.signal,
        priority: 'high',
        onEvent: async (result) => {
          const type = result.event?.type ?? OzonSupplyEventType.Error;

          if (type === OzonSupplyEventType.SupplyCreated) {
            supplyCreated = result;
          }
          if (type === OzonSupplyEventType.WindowExpired) {
            windowExpired = result;
          }

          if (callbacks?.onEvent) {
            await callbacks.onEvent(result);
          }
        },
      });

      if (windowExpired && callbacks?.onWindowExpired) {
        await callbacks.onWindowExpired(windowExpired);
        return;
      }

      if (supplyCreated && callbacks?.onSupplyCreated) {
        await callbacks.onSupplyCreated(supplyCreated);
      }
    } catch (error) {
      if (this.isAbortError(error)) {
        this.logger.log('Supply task aborted by user');
        if (callbacks?.onAbort) {
          await callbacks.onAbort();
        }
        return;
      }

      if (callbacks?.onError) {
        await callbacks.onError(error);
        return;
      }

      throw error;
    }
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }
}
