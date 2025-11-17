import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class SupplyTaskAbortService {
  private readonly logger = new Logger(SupplyTaskAbortService.name);
  private readonly controllers = new Map<string, { controller: AbortController; chatId: string }>();

  register(chatId: string, taskId: string, controller: AbortController): AbortController {
    if (!taskId) {
      this.logger.warn(`Skip registering abort controller: empty taskId for chat ${chatId}`);
      return controller;
    }

    const existing = this.controllers.get(taskId);
    if (existing) {
      existing.controller.abort();
    }

    this.controllers.set(taskId, { controller, chatId });
    return controller;
  }

  abort(chatId: string, taskId?: string): void {
    if (taskId) {
      const entry = this.controllers.get(taskId);
      if (entry && entry.chatId === chatId) {
        entry.controller.abort();
        this.controllers.delete(taskId);
      }
      return;
    }

    for (const [key, entry] of this.controllers.entries()) {
      if (entry.chatId === chatId) {
        entry.controller.abort();
        this.controllers.delete(key);
      }
    }
  }

  clear(taskId: string): void {
    if (!taskId) {
      return;
    }
    this.controllers.delete(taskId);
  }
}
