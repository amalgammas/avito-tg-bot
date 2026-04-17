import { Injectable, computed, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class LoadingStateService {
  private readonly activeRequests = signal(0);
  readonly visible = computed(() => this.activeRequests() > 0);

  start() {
    this.activeRequests.update((value) => value + 1);
  }

  stop() {
    this.activeRequests.update((value) => Math.max(0, value - 1));
  }
}
