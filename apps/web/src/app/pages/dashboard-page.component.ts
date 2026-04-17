import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../services/api.service';

interface MeResponse {
  email: string;
  ozonConnected: boolean;
  counts: {
    all: number;
    inProgress: number;
    completed: number;
    failed: number;
  };
}

@Component({
  standalone: true,
  imports: [RouterLink],
  styles: [`
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .card, .hero { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 22px; box-shadow: var(--shadow); }
    .hero { margin-bottom: 20px; }
    .label { color: var(--text-muted); font-size: 14px; margin-bottom: 8px; }
    .value { font-size: 28px; font-weight: 700; }
    .cta { display: inline-flex; margin-top: 18px; padding: 12px 16px; border-radius: 12px; background: var(--accent); color: #fff; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
  `],
  template: `
    <section class="hero">
      <div class="label">Состояние кабинета</div>
      <h1>Angular web</h1>
      <p>В первой итерации доступны email login, настройки Ozon и работа со списком задач</p>
      <a class="cta" routerLink="/settings">{{ data()?.ozonConnected ? 'Обновить ключи Ozon' : 'Подключить Ozon' }}</a>
    </section>

    <section class="grid">
      <article class="card">
        <div class="label">Всего записей</div>
        <div class="value">{{ data()?.counts?.all ?? 0 }}</div>
      </article>
      <article class="card">
        <div class="label">В работе</div>
        <div class="value">{{ data()?.counts?.inProgress ?? 0 }}</div>
      </article>
      <article class="card">
        <div class="label">Завершено</div>
        <div class="value">{{ data()?.counts?.completed ?? 0 }}</div>
      </article>
      <article class="card">
        <div class="label">Ошибки</div>
        <div class="value">{{ data()?.counts?.failed ?? 0 }}</div>
      </article>
    </section>
  `,
})
export class DashboardPageComponent {
  private readonly api = inject(ApiService);
  readonly data = signal<MeResponse | null>(null);

  constructor() {
    queueMicrotask(() => void this.load());
  }

  private async load() {
    this.data.set(await firstValueFrom(this.api.get<MeResponse>('/api/web/me')));
  }
}
