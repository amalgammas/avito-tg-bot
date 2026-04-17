import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../services/api.service';
import { NavigationStateService } from '../services/navigation-state.service';

interface SupplyRow {
  id: string;
  groupStatus: string;
  warehouse: string | null;
  createdAt: number;
  items: Array<{ article: string; quantity: number }>;
}

@Component({
  standalone: true,
  imports: [RouterLink, DatePipe],
  styles: [`
    .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
    .page-header p { margin: 6px 0 0; color: var(--text-muted); }
    .banner { margin-bottom: 16px; padding: 14px 16px; border-radius: 14px; border: 1px solid #bfdbfe; background: #eff6ff; color: #1d4ed8; }
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
    .toolbar button { padding: 10px 14px; border: 1px solid var(--border); background: var(--surface); border-radius: 999px; cursor: pointer; }
    .toolbar button.active { background: var(--accent); color: #fff; border-color: var(--accent); }
    .list { display: grid; gap: 14px; }
    .row { display: grid; gap: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 18px; box-shadow: var(--shadow); }
    .line { display: flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
    .muted { color: var(--text-muted); }
    .tag { padding: 4px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; }
    .tag.in-progress { background: #fff7ed; color: #c2410c; }
    .tag.completed { background: #ecfdf5; color: #047857; }
    .tag.failed { background: #fef2f2; color: #b91c1c; }
    .empty { background: var(--surface); border: 1px dashed var(--border); border-radius: 18px; padding: 28px; color: var(--text-muted); }
    .page-header a { padding: 12px 16px; border-radius: 12px; background: var(--accent); color: #fff; align-self: center; }
  `],
  template: `
    <div class="page-header">
      <div>
        <h1>Задачи и поставки</h1>
        <p>Список обновляется автоматически, пока задачи выполняются.</p>
      </div>
      <a routerLink="/supplies/new">Новая поставка</a>
    </div>

    @if (showCreatedBanner()) {
      <div class="banner">Задача запущена. Обновления статуса появятся здесь автоматически.</div>
    }

    <div class="toolbar">
      @for (option of filters; track option.value) {
        <button type="button" [class.active]="filter() === option.value" (click)="applyFilter(option.value)">
          {{ option.label }}
        </button>
      }
    </div>

    @if (!items().length) {
      <div class="empty">
        {{ emptyText() }}
      </div>
    } @else {
      <div class="list">
        @for (item of items(); track item.id) {
          <a class="row" [routerLink]="['/supplies', item.id]">
            <div class="line">
              <strong>{{ item.warehouse || 'Без склада' }}</strong>
              <span class="tag" [class.in-progress]="item.groupStatus === 'in_progress'" [class.completed]="item.groupStatus === 'completed'" [class.failed]="item.groupStatus === 'failed'">
                {{ statusLabel(item.groupStatus) }}
              </span>
            </div>
            <div class="line muted">
              <span>{{ item.items.length }} позиций</span>
              <span>{{ item.createdAt | date:'dd.MM.yyyy HH:mm' }}</span>
            </div>
          </a>
        }
      </div>
    }
  `,
})
export class SuppliesPageComponent {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly navigationState = inject(NavigationStateService);
  readonly items = signal<SupplyRow[]>([]);
  readonly filter = signal('');
  readonly showCreatedBanner = signal(Boolean(window.history.state?.created));
  readonly emptyText = computed(() =>
    this.filter() ? 'По выбранному фильтру задач пока нет.' : 'Пока нет ни одной задачи или поставки. Создайте первую поставку из мастера.',
  );
  readonly autoRefreshTimeout = 10000;

  readonly filters = [
    { value: '', label: 'Все' },
    { value: 'in_progress', label: 'В работе' },
    { value: 'completed', label: 'Завершены' },
    { value: 'failed', label: 'Ошибка' },
  ];

  constructor() {
    queueMicrotask(() => void this.load());
    const intervalId = window.setInterval(() => {
      void this.load();
    }, this.autoRefreshTimeout);
    this.destroyRef.onDestroy(() => window.clearInterval(intervalId));
  }

  async applyFilter(value: string) {
    this.filter.set(value);
    await this.load();
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
    const query = this.filter() ? `?status=${this.filter()}` : '';
    const items = await firstValueFrom(this.api.get<SupplyRow[]>(`/api/web/supplies${query}`));
    this.items.set(items);
    if (!this.filter()) {
      this.navigationState.setHasSupplies(items.length > 0);
    }
    if (items.length) {
      this.showCreatedBanner.set(false);
    }
  }
}
