import { DatePipe, JsonPipe } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../services/api.service';
import { NavigationStateService } from '../services/navigation-state.service';

interface SupplyDetail {
  id: string;
  groupStatus: string;
  warehouse: string | null;
  clusterName: string | null;
  dropOffName: string | null;
  arrival: string | null;
  failureReason: string | null;
  taskPayload?: unknown;
  items: Array<{ article: string; quantity: number }>;
  createdAt: number;
}

@Component({
  standalone: true,
  imports: [DatePipe, JsonPipe, RouterLink],
  styles: [`
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 24px; box-shadow: var(--shadow); }
    .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
    .meta { color: var(--text-muted); }
    .actions { display: flex; gap: 12px; margin-top: 20px; }
    button, .back { padding: 12px 16px; border-radius: 12px; border: 1px solid var(--border); background: #fff; cursor: pointer; }
    .danger { background: #fff7ed; border-color: #fdba74; color: var(--danger); }
    .tag { display: inline-flex; padding: 6px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; }
    .tag.in-progress { background: #fff7ed; color: #c2410c; }
    .tag.completed { background: #ecfdf5; color: #047857; }
    .tag.failed { background: #fef2f2; color: #b91c1c; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 16px; background: #f8fafc; border-radius: 12px; border: 1px solid var(--border); }
  `],
  template: `
    @if (detail()) {
      <section class="card">
        <div class="header">
          <div>
            <h1>Детали задачи</h1>
            <div class="meta">Статус обновляется автоматически.</div>
          </div>
          <span class="tag" [class.in-progress]="detail()!.groupStatus === 'in_progress'" [class.completed]="detail()!.groupStatus === 'completed'" [class.failed]="detail()!.groupStatus === 'failed'">
            {{ statusLabel(detail()!.groupStatus) }}
          </span>
        </div>

        <p>Склад: {{ detail()!.warehouse || 'не выбран' }}</p>
        <p>Кластер: {{ detail()!.clusterName || 'не указан' }}</p>
        <p>Drop-off: {{ detail()!.dropOffName || 'не указан' }}</p>
        <p>Создано: {{ detail()!.createdAt | date:'dd.MM.yyyy HH:mm' }}</p>

        @if (detail()!.failureReason) {
          <p>Ошибка: {{ detail()!.failureReason }}</p>
        }

        <h2>Товары</h2>
        <pre>{{ detail()!.items | json }}</pre>

        @if (detail()!.taskPayload) {
          <h2>Payload</h2>
          <pre>{{ detail()!.taskPayload | json }}</pre>
        }

        <div class="actions">
          <a class="back" routerLink="/supplies">Назад к списку</a>
          <button class="danger" type="button" [disabled]="cancelling()" (click)="cancel()">
            {{ cancelling() ? 'Отменяем...' : 'Отменить' }}
          </button>
        </div>
      </section>
    }
  `,
})
export class SupplyDetailPageComponent {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly navigationState = inject(NavigationStateService);
  readonly detail = signal<SupplyDetail | null>(null);
  readonly cancelling = signal(false);

  constructor() {
    queueMicrotask(() => void this.load());
    const intervalId = window.setInterval(() => {
      if (!this.cancelling()) {
        void this.load();
      }
    }, 5_000);
    this.destroyRef.onDestroy(() => window.clearInterval(intervalId));
  }

  async cancel() {
    if (this.cancelling()) {
      return;
    }

    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.cancelling.set(true);
    await firstValueFrom(this.api.post(`/api/web/supplies/${id}/cancel`, {}));
    this.navigationState.setHasSupplies(true);
    await this.router.navigateByUrl('/supplies');
  }

  statusLabel(groupStatus: string) {
    if (groupStatus === 'in_progress') {
      return 'В работе';
    }
    if (groupStatus === 'completed') {
      return 'Завершено';
    }
    return 'Ошибка';
  }

  private async load() {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    try {
      this.detail.set(await firstValueFrom(this.api.get<SupplyDetail>(`/api/web/supplies/${id}`)));
    } catch (error: any) {
      if (error?.status === 404) {
        await this.router.navigateByUrl('/supplies');
        return;
      }
      throw error;
    }
  }
}
