import { Injectable } from '@nestjs/common';

import type { OzonSupplyProcessResult, OzonSupplyTask } from '@bot/ozon/ozon-supply.types';
import type { OzonCredentials } from '@bot/config/ozon-api.service';

import { SupplyRunnerService } from './supply-runner.service';

interface SupplyTaskOrchestratorCallbacks {
  onEvent?: (result: OzonSupplyProcessResult) => void | Promise<void>;
  onWindowExpired?: (result: OzonSupplyProcessResult) => void | Promise<void>;
  onSupplyCreated?: (result: OzonSupplyProcessResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  onAbort?: () => void | Promise<void>;
}

interface SupplyTaskOrchestratorParams {
  task: OzonSupplyTask;
  credentials: OzonCredentials;
  readyInDays: number;
  dropOffWarehouseId?: number;
  abortController: AbortController;
  callbacks?: SupplyTaskOrchestratorCallbacks;
}

@Injectable()
export class SupplyTaskOrchestratorService {
  constructor(private readonly runner: SupplyRunnerService) {}

  async run(params: SupplyTaskOrchestratorParams): Promise<void> {
    const { task, credentials, readyInDays, dropOffWarehouseId, abortController, callbacks } = params;

    await this.runner.run({
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
  }
}
