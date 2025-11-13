import { Injectable, Logger } from '@nestjs/common';

import type { OzonCredentials } from '@bot/config/ozon-api.service';
import type { OzonSupplyProcessResult, OzonSupplyTask } from '@bot/ozon/ozon-supply.types';

import { SupplyTaskOrchestratorService } from './supply-task-orchestrator.service';

export interface SupplyProcessingCallbacks {
  onEvent?: (result: OzonSupplyProcessResult) => void | Promise<void>;
  onWindowExpired?: (result: OzonSupplyProcessResult) => void | Promise<void>;
  onSupplyCreated?: (result: OzonSupplyProcessResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  onAbort?: () => void | Promise<void>;
  onFinally?: () => void | Promise<void>;
}

export interface SupplyProcessingParams {
  task: OzonSupplyTask;
  credentials: OzonCredentials;
  readyInDays: number;
  dropOffWarehouseId?: number;
  abortController: AbortController;
  callbacks?: SupplyProcessingCallbacks;
}

@Injectable()
export class SupplyProcessingCoordinatorService {
  private readonly logger = new Logger(SupplyProcessingCoordinatorService.name);

  constructor(private readonly orchestrator: SupplyTaskOrchestratorService) {}

  async run(params: SupplyProcessingParams): Promise<void> {
    const { task, credentials, readyInDays, dropOffWarehouseId, abortController, callbacks } = params;

    try {
      await this.orchestrator.run({
        task,
        credentials,
        readyInDays,
        dropOffWarehouseId,
        abortController,
        callbacks: {
          onEvent: callbacks?.onEvent,
          onWindowExpired: callbacks?.onWindowExpired,
          onSupplyCreated: callbacks?.onSupplyCreated,
          onError: callbacks?.onError,
          onAbort: callbacks?.onAbort,
        },
      });
    } catch (error) {
      this.logger.debug(`run failed: ${String(error)}`);
      throw error;
    } finally {
      try {
        await callbacks?.onFinally?.();
      } catch (finalizeError) {
        this.logger.debug(`onFinally callback failed: ${String(finalizeError)}`);
      }
    }
  }
}
