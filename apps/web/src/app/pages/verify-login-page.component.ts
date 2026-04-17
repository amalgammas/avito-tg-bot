import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { AuthService } from '../services/auth.service';

@Component({
  standalone: true,
  styles: [`
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .card { width: min(420px, 100%); background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 28px; box-shadow: var(--shadow); }
    h1 { margin-top: 0; }
    p { color: var(--text-muted); }
    .error { color: var(--danger); }
  `],
  template: `
    <div class="wrap">
      <div class="card">
        <h1>Подтверждаем вход</h1>
        @if (!error()) {
          <p>Проверяем magic link и создаём сессию…</p>
        } @else {
          <p class="error">{{ error() }}</p>
        }
      </div>
    </div>
  `,
})
export class VerifyLoginPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly error = signal('');

  constructor() {
    queueMicrotask(() => void this.verify());
  }

  private async verify() {
    const token = this.route.snapshot.queryParamMap.get('token') ?? '';
    if (!token) {
      this.error.set('Токен входа отсутствует.');
      return;
    }

    try {
      await this.auth.verifyMagicLink(token);
      await this.router.navigateByUrl('/dashboard');
    } catch {
      this.error.set('Не удалось подтвердить ссылку входа.');
    }
  }
}
