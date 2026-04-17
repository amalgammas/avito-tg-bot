import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { AuthService } from '../services/auth.service';
import { ApiService } from '../services/api.service';
import { NavigationStateService } from '../services/navigation-state.service';

interface MeResponse {
  counts?: {
    all?: number;
  };
}

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  styles: [`
    .shell { display: grid; grid-template-columns: 260px 1fr; min-height: 100vh; }
    .sidebar { padding: 28px 20px; border-right: 1px solid var(--border); background: rgba(255,255,255,0.82); backdrop-filter: blur(18px); }
    .brand { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
    .subtitle { color: var(--text-muted); font-size: 14px; margin-bottom: 28px; }
    .nav { display: grid; gap: 8px; }
    .nav a { padding: 12px 14px; border-radius: 12px; color: var(--text-muted); }
    .nav a.active { background: var(--surface-muted); color: var(--text); font-weight: 600; }
    .content { padding: 32px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
    .email { color: var(--text-muted); margin-right: 12px; }
    .ghost { border: 1px solid var(--border); background: var(--surface); border-radius: 10px; padding: 10px 14px; cursor: pointer; }
    @media (max-width: 960px) {
      .shell { grid-template-columns: 1fr; }
      .sidebar { border-right: 0; border-bottom: 1px solid var(--border); }
      .content { padding: 20px; }
    }
  `],
  template: `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">Кабинет поставок</div>
        <div class="subtitle">Мастер-ветка</div>
        <nav class="nav">
          <a routerLink="/dashboard" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Обзор</a>
          @if (hasSupplies()) {
            <a routerLink="/supplies" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Задачи и поставки</a>
          }
          <a routerLink="/supplies/new" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Новая поставка</a>
          <a routerLink="/settings" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Настройки Ozon</a>
        </nav>
      </aside>

      <main class="content">
        <div class="topbar">
          <div class="email">{{ email() }}</div>
          <button class="ghost" type="button" (click)="logout()">Выйти</button>
        </div>
        <router-outlet />
      </main>
    </div>
  `,
})
export class AppLayoutComponent {
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly navigationState = inject(NavigationStateService);
  readonly email = computed(() => this.auth.user()?.email ?? '');
  readonly hasSupplies = this.navigationState.hasSupplies;

  constructor() {
    queueMicrotask(() => void this.loadNavigationState());
  }

  logout() {
    void this.auth.logout();
  }

  private async loadNavigationState() {
    try {
      const response = await firstValueFrom(this.api.get<MeResponse>('/api/web/me'));
      this.navigationState.setHasSupplies((response.counts?.all ?? 0) > 0);
    } catch {
      this.navigationState.setHasSupplies(false);
    }
  }
}
