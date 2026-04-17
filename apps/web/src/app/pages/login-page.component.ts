import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { AuthService } from '../services/auth.service';

@Component({
  standalone: true,
  imports: [ReactiveFormsModule],
  styles: [`
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .card { width: min(460px, 100%); background: var(--surface); border: 1px solid var(--border); border-radius: 24px; padding: 32px; box-shadow: var(--shadow); }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { margin: 0 0 24px; color: var(--text-muted); line-height: 1.5; }
    label { display: block; margin-bottom: 8px; font-weight: 600; }
    input { width: 100%; padding: 14px 16px; border-radius: 12px; border: 1px solid var(--border); background: #fff; }
    button { width: 100%; margin-top: 16px; padding: 14px 16px; border: 0; border-radius: 12px; background: var(--accent); color: #fff; cursor: pointer; font-weight: 600; }
    .hint, .error { margin-top: 16px; font-size: 14px; }
    .hint { color: var(--text-muted); }
    .error { color: var(--danger); }
    .preview { margin-top: 16px; word-break: break-word; font-size: 13px; color: var(--accent-strong); }
  `],
  template: `
    <div class="wrap">
      <section class="card">
        <h1>Вход по email</h1>
        <p>Сначала отправляем magic link на почту. Passkey добавим следующим этапом, когда базовый кабинет уже будет работать стабильно.</p>

        <form [formGroup]="form" (ngSubmit)="submit()">
          <label for="email">Email</label>
          <input id="email" type="email" formControlName="email" placeholder="you@example.com" />
          <button type="submit" [disabled]="loading()">Отправить ссылку</button>
        </form>

        @if (message()) {
          <div class="hint">{{ message() }}</div>
        }

        @if (previewUrl()) {
          <div class="preview">Dev preview: {{ previewUrl() }}</div>
        }

        @if (error()) {
          <div class="error">{{ error() }}</div>
        }
      </section>
    </div>
  `,
})
export class LoginPageComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);

  readonly loading = signal(false);
  readonly message = signal('');
  readonly error = signal('');
  readonly previewUrl = signal('');

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  async submit() {
    if (this.form.invalid || this.loading()) {
      this.form.markAllAsTouched();
      return;
    }

    this.loading.set(true);
    this.message.set('');
    this.error.set('');
    this.previewUrl.set('');

    try {
      const response = await this.auth.requestMagicLink(this.form.getRawValue().email);
      this.message.set('Ссылка отправлена. Откройте письмо и завершите вход.');
      this.previewUrl.set(response.previewUrl ?? '');
    } catch {
      this.error.set('Не удалось отправить magic link.');
    } finally {
      this.loading.set(false);
    }
  }
}
